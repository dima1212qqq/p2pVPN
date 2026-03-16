import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AuthChallengeMessage, AuthResponseMessage } from "@p2pvpn/protocol";

export interface ClientIdentity {
  version: 1;
  createdAt: string;
  name: string;
  fingerprint: string;
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

function toBase64Url(data: Buffer): string {
  return data
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
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
  return Buffer.from(
    [
      "p2pvpn-auth-v1",
      challenge.sessionId,
      challenge.serverId,
      challenge.nonce,
      challenge.issuedAt
    ].join("\n"),
    "utf8"
  );
}

export function signChallenge(challenge: AuthChallengeMessage, privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, buildChallengePayload(challenge), privateKey);
  return signature.toString("base64");
}

export function verifyChallengeResponse(
  challenge: AuthChallengeMessage,
  response: AuthResponseMessage,
  expectedFingerprint?: string
): boolean {
  const publicKey = createPublicKey(response.publicKeyPem);
  const fingerprint = fingerprintPublicKeyPem(response.publicKeyPem);

  if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    return false;
  }

  if (response.clientFingerprint !== fingerprint) {
    return false;
  }

  return verify(null, buildChallengePayload(challenge), publicKey, Buffer.from(response.signature, "base64"));
}

export async function ensureParentDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
