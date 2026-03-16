import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Duplex } from "node:stream";

import b4a from "b4a";
import DHT from "hyperdht";
import WebSocket, { createWebSocketStream } from "ws";

import { loadManifest, orderServers, resolveBootstrap, type NetworkServerEntry } from "@p2pvpn/config-manifest";
import { createAuthorizedClient, loadClientIdentity, signChallenge, type ClientIdentity } from "@p2pvpn/identity";
import {
  ProtocolSocket,
  PROTOCOL_VERSION,
  isMessageType,
  waitForMessageOrThrowRemoteError,
  type AuthChallengeMessage,
  type SessionConfigMessage,
  type StatsMessage,
  type TunnelTicket
} from "@p2pvpn/protocol";

import { getTunnelTicket, resolveControlApiBaseUrl } from "./control-api.js";
import type { TransportNetworkContext } from "./network-types.js";
import { loadServerSelectionState, saveServerSelectionState } from "./server-selection-state.js";
import { dedupeBypassTargets, resolveHyperDhtBypassTargets, resolveWsBypassTargets } from "./transport-network.js";
import { createTunnelAdapter, type TunnelAdapter, type TunnelEvent } from "./tunnel.js";

export interface AgentConnectOptions {
  manifestPath: string;
  identityPath: string;
  preferredServerId?: string;
  jsonEvents?: boolean;
  once?: boolean;
  tunnelMode?: "none" | "dev-loopback" | "wintun";
  wintunAdapterName?: string;
  wintunDllPath?: string;
  applyRoutes?: boolean;
  controlApiBaseUrl?: string;
}

interface ConnectedTransport {
  name: "hyperdht" | "ws";
  stream: Duplex;
  networkContext: TransportNetworkContext;
  close: () => Promise<void>;
}

interface SessionRuntime {
  waitForTunnelIdle: Promise<void>;
  close: () => Promise<void>;
}

function emitEvent(jsonEvents: boolean, event: Record<string, unknown>): void {
  if (jsonEvents) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return;
  }

  const message = typeof event.message === "string" ? event.message : JSON.stringify(event);
  console.log(`[desktop-agent] ${message}`);
}

export async function runAgent(options: AgentConnectOptions): Promise<void> {
  const manifestTrustPublicKeyPem = await loadOptionalManifestTrustPublicKey(options.manifestPath);
  const manifest = await loadManifest(options.manifestPath, {
    trustedPublicKeyPem: manifestTrustPublicKeyPem
  });
  const identity = await loadClientIdentity(options.identityPath);
  const controlApiBaseUrl = await resolveControlApiBaseUrl({
    explicitControlApiBaseUrl: options.controlApiBaseUrl,
    manifestControlApiBaseUrl: manifest.controlApiBaseUrl,
    identityPath: options.identityPath,
    expectedClientFingerprint: identity.fingerprint
  });
  let selectionState = await loadServerSelectionState(options.identityPath, manifest.networkName);

  let attempt = 0;

  while (true) {
    attempt += 1;
    const excludedServerIds = new Set<string>();
    const errors: Error[] = [];

    while (excludedServerIds.size < manifest.servers.filter((server) => server.enabled).length) {
      const orderedServers = orderServers(manifest, {
        preferredServerId: options.preferredServerId,
        lastUsedServerId: selectionState?.lastServerId,
        excludedServerIds: [...excludedServerIds]
      });

      const server = orderedServers[0];
      if (!server) {
        break;
      }

      let transport: ConnectedTransport | null = null;

      try {
        const tunnelTicket = controlApiBaseUrl
          ? await getTunnelTicket({
              controlApiBaseUrl,
              identity,
              networkName: manifest.networkName,
              identityPath: options.identityPath,
              requestedServerId: server.id
            })
          : undefined;

        emitEvent(options.jsonEvents ?? false, {
          event: "connecting",
          attempt,
          serverId: server.id,
          message: `Connecting to ${server.displayName} (attempt ${attempt})`
        });

        transport = await connectWithFallback(server, resolveBootstrap(manifest, server));
        const session = await performHandshake(transport, server, identity, tunnelTicket, options);
        await saveServerSelectionState(options.identityPath, manifest.networkName, server.id);
        selectionState = {
          version: 1,
          networkName: manifest.networkName,
          lastServerId: server.id,
          updatedAt: new Date().toISOString()
        };

        if (options.once) {
          await session.waitForTunnelIdle;
          await session.close();
          await transport.close();
          return;
        }

        transport.stream.once("close", () => void session.close());
        transport.stream.once("end", () => void session.close());
        transport.stream.once("error", () => void session.close());

        const activeTransport = transport;
        await new Promise<void>((resolve, reject) => {
          activeTransport.stream.once("close", resolve);
          activeTransport.stream.once("end", resolve);
          activeTransport.stream.once("error", reject);
        });

        emitEvent(options.jsonEvents ?? false, {
          event: "disconnected",
          serverId: server.id,
          message: `Disconnected from ${server.displayName}; retrying`
        });

        break;
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        errors.push(normalizedError);
        excludedServerIds.add(server.id);

        emitEvent(options.jsonEvents ?? false, {
          event: "error",
          serverId: server.id,
          message: normalizedError.message
        });

        if (transport) {
          await transport.close().catch(() => undefined);
        }

        if (options.preferredServerId) {
          break;
        }
      }
    }

    if (options.once) {
      throw new AggregateError(errors, "All server connection attempts failed");
    }

    await delay(Math.min(30_000, 2_000 * attempt));
  }
}

async function performHandshake(
  transport: ConnectedTransport,
  server: NetworkServerEntry,
  identity: ClientIdentity,
  tunnelTicket: TunnelTicket | undefined,
  options: AgentConnectOptions
): Promise<SessionRuntime> {
  const jsonEvents = options.jsonEvents ?? false;
  const framed = new ProtocolSocket(transport.stream);

  framed.sendMessage({
    type: "HELLO",
    protocolVersion: PROTOCOL_VERSION,
    clientFingerprint: identity.fingerprint,
    clientName: identity.name,
    requestedServerId: server.id,
    requestedDataPlaneMode: mapTunnelModeToRequestedDataPlane(options.tunnelMode ?? "none"),
    capabilities: ["control-plane-only"]
  });

  const challenge = await waitForMessageOrThrowRemoteError(
    framed,
    (message): message is AuthChallengeMessage => isMessageType(message, "AUTH_CHALLENGE"),
    10_000
  );

  framed.sendMessage({
    type: "AUTH_RESPONSE",
    sessionId: challenge.sessionId,
    clientFingerprint: identity.fingerprint,
    publicKeyPem: identity.publicKeyPem,
    signature: signChallenge(challenge, identity.privateKeyPem),
    tunnelTicket
  });

  const sessionConfig = await waitForMessageOrThrowRemoteError(
    framed,
    (message): message is SessionConfigMessage => isMessageType(message, "SESSION_CONFIG"),
    10_000
  );

  emitEvent(jsonEvents, {
    event: "connected",
    serverId: server.id,
    transport: transport.name,
    clientFingerprint: createAuthorizedClient(identity).fingerprint,
    tunnelIpv4: sessionConfig.assignedTunnelIpv4,
    dataPlaneMode: sessionConfig.dataPlaneMode,
    dnsServers: sessionConfig.dnsServers,
    message: `Connected via ${transport.name}; assigned ${sessionConfig.assignedTunnelIpv4}`
  });

  const resolvedTunnelMode = resolveTunnelMode(options.tunnelMode ?? "none", sessionConfig);
  const tunnelAdapter = createTunnelAdapter(resolvedTunnelMode, {
    wintunAdapterName: options.wintunAdapterName,
    wintunDllPath: options.wintunDllPath,
    applyRoutes: options.applyRoutes,
    networkContext: transport.networkContext
  });
  await wireTunnelAdapter(tunnelAdapter, framed, sessionConfig, jsonEvents);

  framed.on("message", (message) => {
    if (message.type === "STATS") {
      const stats = message as StatsMessage;
      emitEvent(jsonEvents, {
        event: "stats",
        activeSessions: stats.activeSessions,
        serverUptimeSec: stats.serverUptimeSec,
        sessionPacketsTx: stats.sessionPacketsTx,
        sessionPacketsRx: stats.sessionPacketsRx,
        message: `Server sessions=${stats.activeSessions} uptime=${stats.serverUptimeSec}s tx=${stats.sessionPacketsTx ?? 0} rx=${stats.sessionPacketsRx ?? 0}`
      });
    }

    if (message.type === "PONG") {
      emitEvent(jsonEvents, {
        event: "pong",
        ts: message.ts,
        message: `Heartbeat ok (${new Date(message.ts).toISOString()})`
      });
    }

    if (message.type === "ERROR") {
      emitEvent(jsonEvents, {
        event: "remote-error",
        code: message.code,
        message: message.message
      });
    }
  });

  const interval = setInterval(() => {
    framed.sendMessage({
      type: "PING",
      ts: Date.now()
    });
  }, 15_000);

  transport.stream.once("close", () => clearInterval(interval));
  transport.stream.once("end", () => clearInterval(interval));
  transport.stream.once("error", () => clearInterval(interval));

  return {
    waitForTunnelIdle: tunnelAdapter.whenIdle(),
    close: async () => {
      clearInterval(interval);
      await tunnelAdapter.close();
    }
  };
}

async function connectWithFallback(server: NetworkServerEntry, bootstrap: string[]): Promise<ConnectedTransport> {
  const attempts: Array<Promise<ConnectedTransport>> = [
    connectHyperDht(server.hyperdhtPublicKey, bootstrap)
  ];

  for (const endpoint of server.wsEndpoints) {
    attempts.push(connectWebSocket(endpoint));
  }

  return raceConnections(attempts);
}

async function loadOptionalManifestTrustPublicKey(manifestPath: string): Promise<string | undefined> {
  try {
    return await readFile(join(dirname(manifestPath), "manifest-signing-public-key.pem"), "utf8");
  } catch {
    return undefined;
  }
}

async function raceConnections(attempts: Array<Promise<ConnectedTransport>>): Promise<ConnectedTransport> {
  return new Promise<ConnectedTransport>((resolve, reject) => {
    const errors: Error[] = [];
    let settled = false;

    attempts.forEach((attempt) => {
      attempt
        .then((connection) => {
          if (settled) {
            void connection.close();
            return;
          }

          settled = true;
          resolve(connection);
        })
        .catch((error: unknown) => {
          errors.push(error instanceof Error ? error : new Error(String(error)));

          if (errors.length === attempts.length && !settled) {
            reject(new AggregateError(errors, "All transport attempts failed"));
          }
        });
    });
  });
}

async function connectHyperDht(serverPublicKeyHex: string, bootstrap: string[]): Promise<ConnectedTransport> {
  const dht = new DHT({ bootstrap });
  const socket = dht.connect(b4a.from(serverPublicKeyHex, "hex"));

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      socket.destroy();
      void dht.destroy();
      reject(new Error("hyperdht connection timed out"));
    }, 8_000);

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      void dht.destroy();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };

    socket.once("open", onOpen);
    socket.once("error", onError);
  });

  return {
    name: "hyperdht",
    stream: socket,
    networkContext: {
      transportName: "hyperdht",
      bypassTargets: dedupeBypassTargets(
        await resolveHyperDhtBypassTargets(
          bootstrap,
          getHyperDhtRemoteHost(socket)
        )
      )
    },
    close: async () => {
      socket.destroy();
      await dht.destroy();
    }
  };
}

async function connectWebSocket(endpoint: string): Promise<ConnectedTransport> {
  const socket = new WebSocket(endpoint);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new Error(`WebSocket connection to ${endpoint} timed out`));
    }, 8_000);

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      socket.close();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };

    socket.once("open", onOpen);
    socket.once("error", onError);
  });

  return {
    name: "ws",
    stream: createWebSocketStream(socket),
    networkContext: {
      transportName: "ws",
      bypassTargets: dedupeBypassTargets(await resolveWsBypassTargets(endpoint, getWsRemoteAddress(socket)))
    },
    close: async () => {
      socket.close();
    }
  };
}

async function wireTunnelAdapter(
  tunnelAdapter: TunnelAdapter,
  framed: ProtocolSocket,
  sessionConfig: SessionConfigMessage,
  jsonEvents: boolean
): Promise<void> {
  let active = true;

  const onTunnelEvent = (event: TunnelEvent) => {
    emitEvent(jsonEvents, {
      event: `tunnel-${event.type}`,
      packetBytes: event.packetBytes,
      message: event.message
    });
  };

  const onTunnelPacket = (packet: Buffer) => {
    if (!active) {
      return;
    }

    try {
      framed.sendPacket(packet);
    } catch {
      active = false;
    }
  };

  const onFramedPacket = (packet: Buffer) => {
    if (!active) {
      return;
    }

    tunnelAdapter.injectInbound(packet);
  };

  const onFramedClosed = () => {
    active = false;
  };

  tunnelAdapter.on("event", onTunnelEvent);
  tunnelAdapter.on("packet", onTunnelPacket);
  framed.on("packet", onFramedPacket);
  framed.once("close", onFramedClosed);
  framed.once("error", onFramedClosed);

  try {
    await tunnelAdapter.start(sessionConfig);
  } catch (error) {
    active = false;
    tunnelAdapter.off("event", onTunnelEvent);
    tunnelAdapter.off("packet", onTunnelPacket);
    framed.off("packet", onFramedPacket);
    framed.off("close", onFramedClosed);
    framed.off("error", onFramedClosed);
    await tunnelAdapter.close().catch(() => undefined);
    throw error;
  }
}

function mapTunnelModeToRequestedDataPlane(mode: "none" | "dev-loopback" | "wintun"): "none" | "dev-loopback" | "tun" {
  if (mode === "wintun") {
    return "tun";
  }

  return mode;
}

function resolveTunnelMode(
  requestedMode: "none" | "dev-loopback" | "wintun",
  sessionConfig: SessionConfigMessage
): "none" | "dev-loopback" | "wintun" {
  if (requestedMode === "none") {
    return "none";
  }

  const expectedDataPlaneMode = mapTunnelModeToRequestedDataPlane(requestedMode);
  if (sessionConfig.dataPlaneMode !== expectedDataPlaneMode) {
    throw new Error(
      `Server negotiated data plane '${sessionConfig.dataPlaneMode}', but client was started with '${requestedMode}'`
    );
  }

  return requestedMode;
}

function getHyperDhtRemoteHost(socket: Duplex): string | null {
  const rawStream = (socket as Duplex & { rawStream?: { remoteHost?: string } }).rawStream;
  return typeof rawStream?.remoteHost === "string" ? rawStream.remoteHost : null;
}

function getWsRemoteAddress(socket: WebSocket): string | null {
  const rawSocket = (socket as WebSocket & { _socket?: { remoteAddress?: string } })._socket;
  return typeof rawSocket?.remoteAddress === "string" ? rawSocket.remoteAddress : null;
}
