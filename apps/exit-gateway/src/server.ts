import { randomUUID, createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import b4a from "b4a";
import DHT from "hyperdht";
import { WebSocketServer, createWebSocketStream } from "ws";

import type { AuthorizedClient } from "@p2pvpn/identity";
import { loadAuthorizedClients, verifyChallengeResponse, verifyTunnelTicket } from "@p2pvpn/identity";
import {
  ProtocolSocket,
  PROTOCOL_VERSION,
  isIgnorableStreamError,
  isMessageType,
  waitForMessage,
  type AuthChallengeMessage,
  type AuthResponseMessage,
  type HelloMessage,
  type PingMessage,
  type ProtocolMessage
} from "@p2pvpn/protocol";

import type { ServerConfig } from "./config.js";
import { createPacketSessionFactory, type PacketSession, type PacketSessionFactory } from "./data-plane.js";

interface TransportContext {
  transport: "hyperdht" | "ws";
  stream: Duplex;
  remoteAddress?: string;
}

interface RunningServer {
  close: () => Promise<void>;
}

interface ActiveClientSession {
  sessionId: string;
  close: () => void;
}

export async function startExitGateway(config: ServerConfig, allowlistPath: string): Promise<RunningServer> {
  if (config.auth.mode === "ticket" && !config.auth.ticket.issuerPublicKeyPem) {
    throw new Error("Server auth.mode=ticket requires auth.ticket.issuerPublicKeyPem");
  }

  const authorizedClientMap =
    config.auth.mode === "allowlist"
      ? new Map<string, AuthorizedClient>(
          (await loadAuthorizedClients(allowlistPath)).clients.map((client: AuthorizedClient) => [client.fingerprint, client])
        )
      : new Map<string, AuthorizedClient>();
  const packetSessionFactory = await createPacketSessionFactory(config);

  const dht = new DHT({
    bootstrap: config.bootstrap,
    ...config.dht
  });

  const hyperServer = dht.createServer();
  const activeSessions = new Set<string>();
  const activeClientSessions = new Map<string, ActiveClientSession>();
  const startedAt = Date.now();

  for (const line of packetSessionFactory.describe()) {
    console.log(`[exit-gateway] data-plane ${line}`);
  }

  hyperServer.on("connection", (stream: Duplex) => {
    void handleConnection(config, authorizedClientMap, packetSessionFactory, activeSessions, activeClientSessions, startedAt, {
      transport: "hyperdht",
      stream
    });
  });

  await hyperServer.listen({
    publicKey: b4a.from(config.transportKeyPair.publicKeyHex, "hex"),
    secretKey: b4a.from(config.transportKeyPair.secretKeyHex, "hex")
  });

  let webSocketServer: any = null;
  let webServer: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer> | null = null;

  if (config.websocket.enabled) {
    const requestListener = (_request: unknown, response: { writeHead: (statusCode: number) => void; end: (body?: string) => void }) => {
      response.writeHead(404);
      response.end("Not found");
    };

    if (config.websocket.tls.enabled) {
      if (!config.websocket.tls.certPath || !config.websocket.tls.keyPath) {
        throw new Error("TLS is enabled for WebSocket fallback, but certPath/keyPath are missing");
      }

      webServer = createHttpsServer(
        {
          cert: await readFile(config.websocket.tls.certPath),
          key: await readFile(config.websocket.tls.keyPath)
        },
        requestListener
      );
    } else {
      webServer = createHttpServer(requestListener);
    }

    webSocketServer = new WebSocketServer({
      server: webServer,
      path: config.websocket.path
    });

    webSocketServer.on("connection", (socket: any, request: any) => {
      const duplex = createWebSocketStream(socket);
      const remoteAddress = request.socket.remoteAddress ?? undefined;

      void handleConnection(config, authorizedClientMap, packetSessionFactory, activeSessions, activeClientSessions, startedAt, {
        transport: "ws",
        stream: duplex,
        remoteAddress
      });
    });

    await new Promise<void>((resolve, reject) => {
      webServer!.once("error", reject);
      webServer!.listen(config.websocket.port, config.websocket.host, () => {
        webServer!.off("error", reject);
        resolve();
      });
    });
  }

  console.log(`[exit-gateway] serverId=${config.serverId}`);
  console.log(`[exit-gateway] hyperdht.publicKey=${config.transportKeyPair.publicKeyHex}`);
  console.log(`[exit-gateway] hyperdht.address=${JSON.stringify(hyperServer.address())}`);

  if (webServer?.address() && typeof webServer.address() === "object") {
    const address = webServer.address() as AddressInfo;
    console.log(`[exit-gateway] ws.listen=${address.address}:${address.port}${config.websocket.path}`);
  }

  return {
    close: async () => {
      if (webSocketServer) {
        await new Promise<void>((resolve) => webSocketServer!.close(() => resolve()));
      }

      if (webServer) {
        await new Promise<void>((resolve, reject) =>
          webServer!.close((error: Error | undefined) => (error ? reject(error) : resolve()))
        );
      }

      await hyperServer.close();
      await dht.destroy();
      await packetSessionFactory.close();
    }
  };
}

async function handleConnection(
  config: ServerConfig,
  authorizedClients: Map<string, AuthorizedClient>,
  packetSessionFactory: PacketSessionFactory,
  activeSessions: Set<string>,
  activeClientSessions: Map<string, ActiveClientSession>,
  startedAt: number,
  context: TransportContext
): Promise<void> {
  const framed = new ProtocolSocket(context.stream);
  let packetSession: PacketSession | null = null;
  let sessionId: string | null = null;
  let clientFingerprint: string | null = null;
  let phase: "handshake" | "active" | "closed" = "handshake";
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    phase = "closed";

    if (sessionId) {
      activeSessions.delete(sessionId);
    }

    if (clientFingerprint) {
      const activeClientSession = activeClientSessions.get(clientFingerprint);
      if (activeClientSession?.sessionId === sessionId) {
        activeClientSessions.delete(clientFingerprint);
      }
    }

    if (packetSession) {
      void packetSession.close();
      packetSession = null;
    }
  };

  const terminateConnection = () => {
    cleanup();
    framed.close();
  };

  const handleActiveStreamError = (error: Error) => {
    if (phase !== "active") {
      return;
    }

    if (isIgnorableStreamError(error)) {
      console.log(`[exit-gateway] connection closed transport=${context.transport}: ${error.message}`);
    } else {
      console.error(`[exit-gateway] connection error transport=${context.transport}: ${error.message}`);
    }

    cleanup();
  };

  framed.on("error", handleActiveStreamError);
  framed.once("close", cleanup);

  try {
    const hello = await waitForMessage(
      framed,
      (message): message is HelloMessage => isMessageType(message, "HELLO"),
      10_000
    );

    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      framed.sendMessage({
        type: "ERROR",
        code: "UNSUPPORTED_PROTOCOL",
        message: `Expected protocol version ${PROTOCOL_VERSION}, received ${hello.protocolVersion}`
      });
      framed.close();
      return;
    }

    const negotiatedDataPlaneMode = negotiateDataPlaneMode(config.dataPlane.mode, hello.requestedDataPlaneMode);
    if (!negotiatedDataPlaneMode) {
      framed.sendMessage({
        type: "ERROR",
        code: "UNSUPPORTED_DATA_PLANE",
        message: `Server data plane '${config.dataPlane.mode}' is incompatible with client request '${hello.requestedDataPlaneMode ?? "unspecified"}'`
      });
      framed.close();
      return;
    }

    sessionId = randomUUID();
    const challenge: AuthChallengeMessage = {
      type: "AUTH_CHALLENGE",
      sessionId,
      serverId: config.serverId,
      nonce: randomUUID().replaceAll("-", ""),
      issuedAt: new Date().toISOString()
    };

    framed.sendMessage(challenge);

    const authResponse = await waitForMessage(
      framed,
      (message): message is AuthResponseMessage => isMessageType(message, "AUTH_RESPONSE"),
      10_000
    );

    if (authResponse.clientFingerprint !== hello.clientFingerprint) {
      framed.sendMessage({
        type: "ERROR",
        code: "CLIENT_FINGERPRINT_MISMATCH",
        message: "HELLO and AUTH_RESPONSE refer to different client fingerprints"
      });
      framed.close();
      return;
    }

    if (config.auth.mode === "allowlist") {
      const authorizedClient = authorizedClients.get(authResponse.clientFingerprint);

      if (!authorizedClient) {
        framed.sendMessage({
          type: "ERROR",
          code: "CLIENT_NOT_AUTHORIZED",
          message: "Client fingerprint is not in the allowlist"
        });
        framed.close();
        return;
      }

      if (!verifyChallengeResponse(challenge, authResponse, authorizedClient.fingerprint)) {
        framed.sendMessage({
          type: "ERROR",
          code: "INVALID_SIGNATURE",
          message: "Client authentication failed"
        });
        framed.close();
        return;
      }
    } else {
      if (!authResponse.tunnelTicket) {
        framed.sendMessage({
          type: "ERROR",
          code: "MISSING_TUNNEL_TICKET",
          message: "Client did not provide a tunnel ticket"
        });
        framed.close();
        return;
      }

      const ticketVerification = verifyTunnelTicket(authResponse.tunnelTicket, config.auth.ticket.issuerPublicKeyPem!, {
        expectedClientFingerprint: authResponse.clientFingerprint,
        expectedNetworkName: config.auth.ticket.expectedNetworkName,
        expectedServerId: config.serverId,
        maxClockSkewMs: config.auth.ticket.maxClockSkewSeconds * 1000
      });

      if (!ticketVerification.valid) {
        framed.sendMessage({
          type: "ERROR",
          code: "INVALID_TUNNEL_TICKET",
          message: ticketVerification.reason ?? "Tunnel ticket verification failed"
        });
        framed.close();
        return;
      }

      if (!verifyChallengeResponse(challenge, authResponse, authResponse.clientFingerprint)) {
        framed.sendMessage({
          type: "ERROR",
          code: "INVALID_SIGNATURE",
          message: "Client challenge signature is invalid"
        });
        framed.close();
        return;
      }
    }

    clientFingerprint = authResponse.clientFingerprint;
    const existingClientSession = activeClientSessions.get(clientFingerprint);
    if (existingClientSession) {
      console.log(`[exit-gateway] replacing existing session fingerprint=${clientFingerprint} previousSession=${existingClientSession.sessionId}`);
      existingClientSession.close();
    }

    const assignedTunnelIpv4 = assignTunnelIp(config.sessionTemplate.addressPoolPrefix, clientFingerprint);
    packetSession = await packetSessionFactory.createSession({
      mode: negotiatedDataPlaneMode,
      sessionId,
      assignedTunnelIpv4
    });
    activeSessions.add(sessionId);
    activeClientSessions.set(clientFingerprint, {
      sessionId,
      close: terminateConnection
    });
    phase = "active";

    framed.sendMessage({
      type: "SESSION_CONFIG",
      sessionId,
      serverId: config.serverId,
      transport: context.transport,
      dataPlaneMode: negotiatedDataPlaneMode,
      assignedTunnelIpv4,
      tunnelPrefixLength: config.sessionTemplate.tunnelPrefixLength,
      gatewayIpv4: config.sessionTemplate.gatewayIpv4,
      dnsServers: config.sessionTemplate.dnsServers,
      mtu: config.sessionTemplate.mtu,
      capabilities: buildSessionCapabilities(negotiatedDataPlaneMode),
      message: describeSessionMessage(negotiatedDataPlaneMode)
    });

    framed.sendMessage({
      type: "STATS",
      activeSessions: activeSessions.size,
      serverUptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      ...(packetSession?.getStats() ?? {})
    });

    console.log(
      `[exit-gateway] connected fingerprint=${clientFingerprint} transport=${context.transport} remote=${context.remoteAddress ?? "n/a"}`
    );

    framed.on("message", (message: ProtocolMessage) => {
      if (message.type === "PING") {
        const ping = message as PingMessage;
        framed.sendMessage({
          type: "PONG",
          ts: ping.ts
        });
      }
    });

    framed.on("packet", (packet) => {
      packetSession?.handleClientPacket(packet);
    });

    if (packetSession) {
      packetSession.on("packet", (packet) => {
        framed.sendPacket(packet);
      });

      packetSession.on("stats", (stats) => {
        framed.sendMessage({
          type: "STATS",
          activeSessions: activeSessions.size,
          serverUptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          ...stats
        });
      });
    }
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));

    if (isIgnorableStreamError(normalizedError)) {
      console.log(`[exit-gateway] connection closed transport=${context.transport}: ${normalizedError.message}`);
    } else {
      console.error(`[exit-gateway] connection error transport=${context.transport}: ${normalizedError.message}`);
    }

    terminateConnection();
  }
}

function assignTunnelIp(addressPoolPrefix: string, clientFingerprint: string): string {
  const hash = createHash("sha256").update(clientFingerprint).digest();
  const hostOctet = 2 + ((hash[0] ?? 0) % 220);
  return `${addressPoolPrefix}.${hostOctet}`;
}

function negotiateDataPlaneMode(
  serverMode: ServerConfig["dataPlane"]["mode"],
  requestedMode: HelloMessage["requestedDataPlaneMode"]
): "none" | "dev-loopback" | "tun" | null {
  if (!requestedMode) {
    return serverMode;
  }

  if (requestedMode === "none") {
    return "none";
  }

  if (serverMode === requestedMode) {
    return requestedMode;
  }

  return null;
}

function buildSessionCapabilities(mode: "none" | "dev-loopback" | "tun"): string[] {
  const capabilities = ["control-plane-ready"];

  if (mode === "dev-loopback") {
    capabilities.push("packet-transport", "dev-loopback-tunnel");
  }

  if (mode === "tun") {
    capabilities.push("packet-transport", "tun");
  }

  return capabilities;
}

function describeSessionMessage(mode: "none" | "dev-loopback" | "tun"): string {
  if (mode === "dev-loopback") {
    return "Control plane established. Dev loopback data plane is available for local testing.";
  }

  if (mode === "tun") {
    return "Control plane established. Native TUN data plane is enabled.";
  }

  return "Control plane established. Data plane is disabled for this session.";
}
