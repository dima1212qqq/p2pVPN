import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AuthChallengeMessage, AuthResponseMessage, TunnelTicket, TunnelTicketPayload } from "@p2pvpn/protocol";

export interface ClientIdentity {
  version: 1;
  createdAt: string;
  name: string;
  fingerprint: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface TicketIssuerKeyPair {
  version: 1;
  createdAt: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface AuthorizedClient {
  name: string;
  fingerprint: string;
  publicKeyPem: string;
}

export interface AuthorizedClientsFile {
  version: 1;
  clients: AuthorizedClient[];
}

export interface DeviceRegistrationRequest {
  clientFingerprint: string;
  publicKeyPem: string;
  deviceName: string;
  inviteCode: string;
  issuedAt: string;
  signature: string;
}

export interface TunnelTicketRequest {
  clientFingerprint: string;
  requestedServerId?: string;
  issuedAt: string;
  signature: string;
}

export interface TunnelTicketVerificationOptions {
  expectedClientFingerprint?: string;
  expectedNetworkName?: string;
  expectedServerId?: string;
  now?: Date;
  maxClockSkewMs?: number;
}

export interface TunnelTicketVerificationResult {
  valid: boolean;
  reason?: string;
}

function toBase64Url(data: Buffer): string {
  return data
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function buildDelimitedPayload(prefix: string, fields: Array<string | undefined>): Buffer {
  return Buffer.from(
    [
      prefix,
      ...fields.map((field) => field ?? "")
    ].join("\n"),
    "utf8"
  );
}

function signPayload(payload: Buffer, privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  return sign(null, payload, privateKey).toString("base64");
}

function verifyPayload(payload: Buffer, signatureBase64: string, publicKeyPem: string): boolean {
  const publicKey = createPublicKey(publicKeyPem);
  return verify(null, payload, publicKey, Buffer.from(signatureBase64, "base64"));
}

export function fingerprintPublicKeyPem(publicKeyPem: string): string {
  const publicKey = createPublicKey(publicKeyPem);
  const der = publicKey.export({ type: "spki", format: "der" });
  return toBase64Url(createHash("sha256").update(der).digest());
}

export function generateClientIdentity(name: string): ClientIdentity {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKeyPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    name,
    fingerprint: fingerprintPublicKeyPem(publicKeyPem),
    publicKeyPem,
    privateKeyPem
  };
}

export function generateTicketIssuerKeyPair(): TicketIssuerKeyPair {
  const keyPair = generateKeyPairSync("ed25519");

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

export async function saveClientIdentity(path: string, identity: ClientIdentity): Promise<void> {
  await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}

export async function loadClientIdentity(path: string): Promise<ClientIdentity> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as ClientIdentity;

  if (parsed.version !== 1) {
    throw new Error("Unsupported client identity version");
  }

  if (fingerprintPublicKeyPem(parsed.publicKeyPem) !== parsed.fingerprint) {
    throw new Error("Client identity fingerprint does not match public key");
  }

  return parsed;
}

export function createAuthorizedClient(identity: ClientIdentity): AuthorizedClient {
  return {
    name: identity.name,
    fingerprint: identity.fingerprint,
    publicKeyPem: identity.publicKeyPem
  };
}

export async function loadAuthorizedClients(path: string): Promise<AuthorizedClientsFile> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as AuthorizedClientsFile;

  if (parsed.version !== 1 || !Array.isArray(parsed.clients)) {
    throw new Error("Invalid authorized clients file");
  }

  return {
    version: 1,
    clients: parsed.clients.map((client) => ({
      name: client.name,
      fingerprint: client.fingerprint,
      publicKeyPem: client.publicKeyPem
    }))
  };
}

export async function saveAuthorizedClients(path: string, file: AuthorizedClientsFile): Promise<void> {
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export function buildChallengePayload(challenge: AuthChallengeMessage): Buffer {
  return buildDelimitedPayload("p2pvpn-auth-v1", [
    challenge.sessionId,
    challenge.serverId,
    challenge.nonce,
    challenge.issuedAt
  ]);
}

export function signChallenge(challenge: AuthChallengeMessage, privateKeyPem: string): string {
  return signPayload(buildChallengePayload(challenge), privateKeyPem);
}

export function verifyChallengeResponse(
  challenge: AuthChallengeMessage,
  response: AuthResponseMessage,
  expectedFingerprint?: string
): boolean {
  const fingerprint = fingerprintPublicKeyPem(response.publicKeyPem);

  if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    return false;
  }

  if (response.clientFingerprint !== fingerprint) {
    return false;
  }

  return verifyPayload(buildChallengePayload(challenge), response.signature, response.publicKeyPem);
}

export function buildDeviceRegistrationPayload(request: Omit<DeviceRegistrationRequest, "signature" | "publicKeyPem">): Buffer {
  return buildDelimitedPayload("p2pvpn-register-v1", [
    request.clientFingerprint,
    request.deviceName,
    request.inviteCode,
    request.issuedAt
  ]);
}

export function signDeviceRegistrationRequest(
  request: Omit<DeviceRegistrationRequest, "signature" | "publicKeyPem">,
  privateKeyPem: string
): string {
  return signPayload(buildDeviceRegistrationPayload(request), privateKeyPem);
}

export function verifyDeviceRegistrationRequest(request: DeviceRegistrationRequest): boolean {
  const fingerprint = fingerprintPublicKeyPem(request.publicKeyPem);
  if (fingerprint !== request.clientFingerprint) {
    return false;
  }

  return verifyPayload(
    buildDeviceRegistrationPayload({
      clientFingerprint: request.clientFingerprint,
      deviceName: request.deviceName,
      inviteCode: request.inviteCode,
      issuedAt: request.issuedAt
    }),
    request.signature,
    request.publicKeyPem
  );
}

export function buildTunnelTicketRequestPayload(request: Omit<TunnelTicketRequest, "signature">): Buffer {
  return buildDelimitedPayload("p2pvpn-ticket-request-v1", [
    request.clientFingerprint,
    request.requestedServerId,
    request.issuedAt
  ]);
}

export function signTunnelTicketRequest(
  request: Omit<TunnelTicketRequest, "signature">,
  privateKeyPem: string
): string {
  return signPayload(buildTunnelTicketRequestPayload(request), privateKeyPem);
}

export function verifyTunnelTicketRequest(request: TunnelTicketRequest, publicKeyPem: string): boolean {
  const fingerprint = fingerprintPublicKeyPem(publicKeyPem);
  if (fingerprint !== request.clientFingerprint) {
    return false;
  }

  return verifyPayload(
    buildTunnelTicketRequestPayload({
      clientFingerprint: request.clientFingerprint,
      requestedServerId: request.requestedServerId,
      issuedAt: request.issuedAt
    }),
    request.signature,
    publicKeyPem
  );
}

export function buildTunnelTicketPayload(payload: TunnelTicketPayload): Buffer {
  const allowedServerIds = payload.allowedServerIds?.slice().sort().join(",") ?? "";

  return buildDelimitedPayload("p2pvpn-tunnel-ticket-v1", [
    String(payload.version),
    payload.ticketId,
    payload.networkName,
    payload.clientFingerprint,
    payload.issuedAt,
    payload.expiresAt,
    allowedServerIds
  ]);
}

export function signTunnelTicket(payload: TunnelTicketPayload, issuerPrivateKeyPem: string): TunnelTicket {
  return {
    version: 1,
    payload,
    signature: signPayload(buildTunnelTicketPayload(payload), issuerPrivateKeyPem)
  };
}

export function verifyTunnelTicket(
  ticket: TunnelTicket,
  issuerPublicKeyPem: string,
  options: TunnelTicketVerificationOptions = {}
): TunnelTicketVerificationResult {
  if (ticket.version !== 1 || ticket.payload.version !== 1) {
    return { valid: false, reason: "Unsupported tunnel ticket version" };
  }

  if (!verifyPayload(buildTunnelTicketPayload(ticket.payload), ticket.signature, issuerPublicKeyPem)) {
    return { valid: false, reason: "Tunnel ticket signature is invalid" };
  }

  if (options.expectedClientFingerprint && ticket.payload.clientFingerprint !== options.expectedClientFingerprint) {
    return { valid: false, reason: "Tunnel ticket client fingerprint does not match this device" };
  }

  if (options.expectedNetworkName && ticket.payload.networkName !== options.expectedNetworkName) {
    return { valid: false, reason: "Tunnel ticket network does not match this server" };
  }

  if (options.expectedServerId && ticket.payload.allowedServerIds?.length) {
    if (!ticket.payload.allowedServerIds.includes(options.expectedServerId)) {
      return { valid: false, reason: "Tunnel ticket is not valid for this server" };
    }
  }

  const now = options.now ?? new Date();
  const maxClockSkewMs = options.maxClockSkewMs ?? 5 * 60_000;
  const issuedAtMs = Date.parse(ticket.payload.issuedAt);
  const expiresAtMs = Date.parse(ticket.payload.expiresAt);

  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    return { valid: false, reason: "Tunnel ticket timestamps are invalid" };
  }

  if (expiresAtMs < issuedAtMs) {
    return { valid: false, reason: "Tunnel ticket expiry is earlier than issuance" };
  }

  if (issuedAtMs - now.getTime() > maxClockSkewMs) {
    return { valid: false, reason: "Tunnel ticket appears to be issued in the future" };
  }

  if (now.getTime() - expiresAtMs > maxClockSkewMs) {
    return { valid: false, reason: "Tunnel ticket has expired" };
  }

  return { valid: true };
}

export async function ensureParentDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
