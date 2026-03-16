import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import {
  signTunnelTicket,
  verifyDeviceRegistrationRequest,
  verifyTunnelTicketRequest,
  type DeviceRegistrationRequest,
  type TunnelTicketRequest
} from "@p2pvpn/identity";

import type { TunnelTicketPayload } from "@p2pvpn/protocol";

import type { ControlApiConfig } from "./config.js";
import {
  loadInviteCodes,
  loadRegisteredDevices,
  saveInviteCodes,
  saveRegisteredDevices,
  type InviteCodeRecord,
  type RegisteredDevice
} from "./storage.js";

interface RunningControlApi {
  close: () => Promise<void>;
}

interface StartControlApiOptions {
  config: ControlApiConfig;
  invitesPath: string;
  devicesPath: string;
}

export async function startControlApi(options: StartControlApiOptions): Promise<RunningControlApi> {
  const server = createServer((request, response) => {
    void handleRequest(request, response, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.config.listen.port, options.config.listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log(`[control-api] network=${options.config.networkName}`);
  console.log(`[control-api] listen=${options.config.listen.host}:${options.config.listen.port}`);

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  options: StartControlApiOptions
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { ok: true, networkName: options.config.networkName });
      return;
    }

    if (request.method === "POST" && request.url === "/v1/devices/register") {
      const body = await readJson<DeviceRegistrationRequest>(request);
      const registration = await registerDevice(body, options);
      sendJson(response, registration.created ? 201 : 200, {
        registered: true,
        created: registration.created,
        clientFingerprint: registration.device.clientFingerprint
      });
      return;
    }

    if (request.method === "POST" && request.url === "/v1/tickets") {
      const body = await readJson<TunnelTicketRequest>(request);
      const ticket = await issueTunnelTicket(body, options);
      sendJson(response, 200, { ticket });
      return;
    }

    sendJson(response, 404, { error: "NOT_FOUND", message: "Not found" });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const statusCode = normalized.message.startsWith("AUTH:")
      ? 403
      : normalized.message.startsWith("BAD_REQUEST:")
        ? 400
        : normalized.message.startsWith("CONFLICT:")
          ? 409
          : 500;

    sendJson(response, statusCode, {
      error: statusCode === 500 ? "INTERNAL_ERROR" : normalized.message.split(":")[0],
      message: normalized.message.replace(/^[A-Z_]+:\s*/u, "")
    });
  }
}

async function registerDevice(
  request: DeviceRegistrationRequest,
  options: StartControlApiOptions
): Promise<{ created: boolean; device: RegisteredDevice }> {
  if (!verifyDeviceRegistrationRequest(request)) {
    throw new Error("AUTH: Device registration signature is invalid");
  }

  assertFreshTimestamp(request.issuedAt, options.config.tickets.maxClockSkewSeconds * 1000, "registration");

  const invitesFile = await loadInviteCodes(options.invitesPath);
  const invite = selectUsableInvite(invitesFile.invites, request.inviteCode);
  if (!invite) {
    throw new Error("AUTH: Invite code is invalid or exhausted");
  }

  const devicesFile = await loadRegisteredDevices(options.devicesPath);
  const existing = devicesFile.devices.find((device) => device.clientFingerprint === request.clientFingerprint);

  if (existing) {
    if (existing.publicKeyPem !== request.publicKeyPem) {
      throw new Error("CONFLICT: Client fingerprint is already registered with another public key");
    }

    if (existing.disabled) {
      throw new Error("AUTH: Device is disabled");
    }

    return { created: false, device: existing };
  }

  invite.uses += 1;

  const device: RegisteredDevice = {
    clientFingerprint: request.clientFingerprint,
    publicKeyPem: request.publicKeyPem,
    name: request.deviceName,
    registeredAt: new Date().toISOString(),
    inviteId: invite.id,
    disabled: false
  };

  devicesFile.devices.push(device);
  await saveInviteCodes(options.invitesPath, invitesFile);
  await saveRegisteredDevices(options.devicesPath, devicesFile);

  console.log(`[control-api] registered fingerprint=${device.clientFingerprint} name=${device.name}`);
  return { created: true, device };
}

async function issueTunnelTicket(request: TunnelTicketRequest, options: StartControlApiOptions) {
  assertFreshTimestamp(request.issuedAt, options.config.tickets.maxClockSkewSeconds * 1000, "ticket");

  const devicesFile = await loadRegisteredDevices(options.devicesPath);
  const device = devicesFile.devices.find((item) => item.clientFingerprint === request.clientFingerprint);
  if (!device || device.disabled) {
    throw new Error("AUTH: Device is not registered");
  }

  if (!verifyTunnelTicketRequest(request, device.publicKeyPem)) {
    throw new Error("AUTH: Tunnel ticket request signature is invalid");
  }

  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + options.config.tickets.ttlSeconds * 1000);
  const payload: TunnelTicketPayload = {
    version: 1,
    ticketId: randomUUID(),
    networkName: options.config.networkName,
    clientFingerprint: device.clientFingerprint,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    allowedServerIds: request.requestedServerId ? [request.requestedServerId] : undefined
  };

  const ticket = signTunnelTicket(payload, options.config.issuerKeyPair.privateKeyPem);
  console.log(`[control-api] issued ticket fingerprint=${device.clientFingerprint} ticketId=${payload.ticketId}`);
  return ticket;
}

function selectUsableInvite(invites: InviteCodeRecord[], inviteCode: string): InviteCodeRecord | null {
  const now = Date.now();

  return (
    invites.find((invite) => {
      if (invite.code !== inviteCode || invite.revoked) {
        return false;
      }

      if (invite.maxUses > 0 && invite.uses >= invite.maxUses) {
        return false;
      }

      if (invite.expiresAt && Date.parse(invite.expiresAt) < now) {
        return false;
      }

      return true;
    }) ?? null
  );
}

function assertFreshTimestamp(timestamp: string, maxClockSkewMs: number, label: string): void {
  const issuedAtMs = Date.parse(timestamp);
  if (!Number.isFinite(issuedAtMs)) {
    throw new Error(`BAD_REQUEST: ${label} timestamp is invalid`);
  }

  const delta = Math.abs(Date.now() - issuedAtMs);
  if (delta > maxClockSkewMs) {
    throw new Error(`AUTH: ${label} timestamp is outside the allowed clock skew window`);
  }
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    throw new Error("BAD_REQUEST: Request body is required");
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sendJson(response: ServerResponse<IncomingMessage>, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}
