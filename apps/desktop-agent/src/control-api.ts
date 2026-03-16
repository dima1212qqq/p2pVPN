import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ensureParentDirectory, signDeviceRegistrationRequest, signTunnelTicketRequest, type ClientIdentity } from "@p2pvpn/identity";
import type { TunnelTicket } from "@p2pvpn/protocol";

interface TicketResponse {
  ticket: TunnelTicket;
}

interface RegisterDeviceResponse {
  registered: boolean;
}

export interface DeviceRegistrationState {
  version: 1;
  controlApiBaseUrl: string;
  clientFingerprint: string;
  registeredAt: string;
}

export async function registerDeviceWithInvite(options: {
  controlApiBaseUrl: string;
  identity: ClientIdentity;
  inviteCode: string;
  identityPath?: string;
}): Promise<void> {
  const issuedAt = new Date().toISOString();
  const response = await fetchJson<RegisterDeviceResponse>(`${normalizeBaseUrl(options.controlApiBaseUrl)}/v1/devices/register`, {
    method: "POST",
    body: {
      clientFingerprint: options.identity.fingerprint,
      publicKeyPem: options.identity.publicKeyPem,
      deviceName: options.identity.name,
      inviteCode: options.inviteCode,
      issuedAt,
      signature: signDeviceRegistrationRequest(
        {
          clientFingerprint: options.identity.fingerprint,
          deviceName: options.identity.name,
          inviteCode: options.inviteCode,
          issuedAt
        },
        options.identity.privateKeyPem
      )
    }
  });

  if (!response || response.registered !== true) {
    throw new Error("Control API registration did not return a success response");
  }

  if (options.identityPath) {
    const registrationStatePath = getDeviceRegistrationStatePath(options.identityPath);
    await ensureParentDirectory(registrationStatePath);
    await writeFile(
      registrationStatePath,
      `${JSON.stringify(
        {
          version: 1,
          controlApiBaseUrl: normalizeBaseUrl(options.controlApiBaseUrl),
          clientFingerprint: options.identity.fingerprint,
          registeredAt: new Date().toISOString()
        } satisfies DeviceRegistrationState,
        null,
        2
      )}\n`,
      "utf8"
    );
  }
}

export async function getTunnelTicket(options: {
  controlApiBaseUrl: string;
  identity: ClientIdentity;
  networkName: string;
  identityPath: string;
  requestedServerId?: string;
}): Promise<TunnelTicket> {
  const cachePath = getTunnelTicketCachePath(options.identityPath);
  const cached = await loadCachedTunnelTicket(cachePath);

  if (cached && isTicketLocallyUsable(cached, options.identity.fingerprint, options.networkName, options.requestedServerId)) {
    return cached;
  }

  const issuedAt = new Date().toISOString();
  const response = await fetchJson<TicketResponse>(`${normalizeBaseUrl(options.controlApiBaseUrl)}/v1/tickets`, {
    method: "POST",
    body: {
      clientFingerprint: options.identity.fingerprint,
      requestedServerId: options.requestedServerId,
      issuedAt,
      signature: signTunnelTicketRequest(
        {
          clientFingerprint: options.identity.fingerprint,
          requestedServerId: options.requestedServerId,
          issuedAt
        },
        options.identity.privateKeyPem
      )
    }
  });

  if (!response.ticket) {
    throw new Error("Control API did not return a tunnel ticket");
  }

  await ensureParentDirectory(cachePath);
  await writeFile(cachePath, `${JSON.stringify(response.ticket, null, 2)}\n`, "utf8");
  return response.ticket;
}

export function getTunnelTicketCachePath(identityPath: string): string {
  return join(dirname(identityPath), "tunnel-ticket.json");
}

export function getDeviceRegistrationStatePath(identityPath: string): string {
  return join(dirname(identityPath), "device-registration.json");
}

async function loadCachedTunnelTicket(path: string): Promise<TunnelTicket | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as TunnelTicket;
  } catch {
    return null;
  }
}

function isTicketLocallyUsable(
  ticket: TunnelTicket,
  expectedClientFingerprint: string,
  expectedNetworkName: string,
  expectedServerId?: string
): boolean {
  if (ticket.version !== 1 || ticket.payload.version !== 1) {
    return false;
  }

  if (ticket.payload.clientFingerprint !== expectedClientFingerprint) {
    return false;
  }

  if (ticket.payload.networkName !== expectedNetworkName) {
    return false;
  }

  if (expectedServerId && ticket.payload.allowedServerIds?.length) {
    if (!ticket.payload.allowedServerIds.includes(expectedServerId)) {
      return false;
    }
  }

  const expiresAtMs = Date.parse(ticket.payload.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }

  return expiresAtMs - Date.now() > 60_000;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

async function fetchJson<TResponse>(
  url: string,
  options: {
    method: "POST";
    body: Record<string, unknown>;
  }
): Promise<TResponse> {
  const response = await fetch(url, {
    method: options.method,
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(options.body)
  });

  const raw = await response.text();
  const parsed = raw ? (JSON.parse(raw) as TResponse & { error?: string; message?: string }) : ({} as TResponse & { error?: string; message?: string });

  if (!response.ok) {
    throw new Error(parsed.message ?? `Control API request failed with HTTP ${response.status}`);
  }

  return parsed as TResponse;
}
