import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

export const DEFAULT_PUBLIC_BOOTSTRAP = [
  "88.99.3.86@node1.hyperdht.org:49737",
  "142.93.90.113@node2.hyperdht.org:49737",
  "138.68.147.8@node3.hyperdht.org:49737"
];

export interface NetworkServerEntry {
  id: string;
  displayName: string;
  country: string;
  city?: string;
  enabled: boolean;
  weight: number;
  hyperdhtPublicKey: string;
  wsEndpoints: string[];
  dnsServers: string[];
  mtu: number;
  bootstrap?: string[];
}

export interface ManifestSignature {
  algorithm: "ed25519";
  keyId?: string;
  value: string;
}

export interface NetworkManifest {
  version: 1;
  networkName: string;
  generatedAt: string;
  bootstrap: string[];
  controlApiBaseUrl?: string;
  servers: NetworkServerEntry[];
  signature?: ManifestSignature;
}

export interface ManifestSelectionOptions {
  preferredServerId?: string;
  lastUsedServerId?: string;
  excludedServerIds?: string[];
}

export interface ManifestSigningKeyPair {
  version: 1;
  createdAt: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

function expectString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid manifest field: ${fieldName}`);
  }

  return value;
}

function expectNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Invalid manifest field: ${fieldName}`);
  }

  return value;
}

function expectStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`Invalid manifest field: ${fieldName}`);
  }

  return value;
}

function expectManifestSignature(value: unknown, fieldName: string): ManifestSignature {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid manifest field: ${fieldName}`);
  }

  const record = value as Record<string, unknown>;
  if (record.algorithm !== "ed25519") {
    throw new Error(`Invalid manifest field: ${fieldName}.algorithm`);
  }

  return {
    algorithm: "ed25519",
    keyId: typeof record.keyId === "string" ? record.keyId : undefined,
    value: expectString(record.value, `${fieldName}.value`)
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeys(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const sortedEntries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => [key, sortKeys(record[key])] as const);

  return Object.fromEntries(sortedEntries);
}

export function parseManifest(raw: string): NetworkManifest {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  if (parsed.version !== 1) {
    throw new Error("Unsupported manifest version");
  }

  if (!Array.isArray(parsed.servers)) {
    throw new Error("Invalid manifest field: servers");
  }

  return {
    version: 1,
    networkName: expectString(parsed.networkName, "networkName"),
    generatedAt: expectString(parsed.generatedAt, "generatedAt"),
    bootstrap: parsed.bootstrap ? expectStringArray(parsed.bootstrap, "bootstrap") : [...DEFAULT_PUBLIC_BOOTSTRAP],
    controlApiBaseUrl: typeof parsed.controlApiBaseUrl === "string" ? parsed.controlApiBaseUrl : undefined,
    servers: parsed.servers.map((server, index) => {
      if (!server || typeof server !== "object") {
        throw new Error(`Invalid manifest server entry at index ${index}`);
      }

      const record = server as Record<string, unknown>;

      return {
        id: expectString(record.id, `servers[${index}].id`),
        displayName: expectString(record.displayName, `servers[${index}].displayName`),
        country: expectString(record.country, `servers[${index}].country`),
        city: typeof record.city === "string" ? record.city : undefined,
        enabled: record.enabled === undefined ? true : Boolean(record.enabled),
        weight: record.weight === undefined ? 100 : expectNumber(record.weight, `servers[${index}].weight`),
        hyperdhtPublicKey: expectString(record.hyperdhtPublicKey, `servers[${index}].hyperdhtPublicKey`),
        wsEndpoints: expectStringArray(record.wsEndpoints, `servers[${index}].wsEndpoints`),
        dnsServers: expectStringArray(record.dnsServers, `servers[${index}].dnsServers`),
        mtu: record.mtu === undefined ? 1380 : expectNumber(record.mtu, `servers[${index}].mtu`),
        bootstrap: record.bootstrap ? expectStringArray(record.bootstrap, `servers[${index}].bootstrap`) : undefined
      };
    }),
    signature: parsed.signature ? expectManifestSignature(parsed.signature, "signature") : undefined
  };
}

export async function loadManifest(
  path: string,
  options: {
    trustedPublicKeyPem?: string;
    requireSignature?: boolean;
  } = {}
): Promise<NetworkManifest> {
  const raw = await readFile(path, "utf8");
  const manifest = parseManifest(raw);

  if (options.trustedPublicKeyPem) {
    if (!manifest.signature) {
      throw new Error("Manifest is unsigned but a trusted public key was provided");
    }

    if (!verifyManifest(manifest, options.trustedPublicKeyPem)) {
      throw new Error("Manifest signature is invalid");
    }
  } else if (options.requireSignature && !manifest.signature) {
    throw new Error("Manifest signature is required");
  }

  return manifest;
}

export function selectServer(manifest: NetworkManifest, preferredServerId?: string): NetworkServerEntry {
  return orderServers(manifest, { preferredServerId })[0]!;
}

export function resolveBootstrap(manifest: NetworkManifest, server: NetworkServerEntry): string[] {
  return server.bootstrap?.length ? [...server.bootstrap] : [...manifest.bootstrap];
}

export function orderServers(manifest: NetworkManifest, options: ManifestSelectionOptions = {}): NetworkServerEntry[] {
  if (options.preferredServerId) {
    const selected = manifest.servers.find((server) => server.id === options.preferredServerId && server.enabled);
    if (!selected) {
      throw new Error(`Server '${options.preferredServerId}' not found or disabled`);
    }

    return [selected];
  }

  const excludedServerIds = new Set(options.excludedServerIds ?? []);
  const enabledServers = manifest.servers.filter((server) => server.enabled && !excludedServerIds.has(server.id));

  if (enabledServers.length === 0) {
    throw new Error("Manifest does not contain any enabled servers");
  }

  return enabledServers.sort((left, right) => {
    const leftLastUsed = left.id === options.lastUsedServerId ? 1 : 0;
    const rightLastUsed = right.id === options.lastUsedServerId ? 1 : 0;

    if (leftLastUsed !== rightLastUsed) {
      return rightLastUsed - leftLastUsed;
    }

    if (left.weight !== right.weight) {
      return right.weight - left.weight;
    }

    return left.id.localeCompare(right.id);
  });
}

export function generateManifestSigningKeyPair(): ManifestSigningKeyPair {
  const keyPair = generateKeyPairSync("ed25519");

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    publicKeyPem: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

export function buildManifestPayload(manifest: NetworkManifest): Buffer {
  const unsignedManifest: Omit<NetworkManifest, "signature"> = {
    version: manifest.version,
    networkName: manifest.networkName,
    generatedAt: manifest.generatedAt,
    bootstrap: manifest.bootstrap,
    controlApiBaseUrl: manifest.controlApiBaseUrl,
    servers: manifest.servers
  };

  return Buffer.from(JSON.stringify(sortKeys(unsignedManifest)), "utf8");
}

export function signManifest(
  manifest: NetworkManifest,
  privateKeyPem: string,
  keyId?: string
): NetworkManifest {
  const privateKey = createPrivateKey(privateKeyPem);

  return {
    ...manifest,
    signature: {
      algorithm: "ed25519",
      keyId,
      value: sign(null, buildManifestPayload(manifest), privateKey).toString("base64")
    }
  };
}

export function verifyManifest(manifest: NetworkManifest, publicKeyPem: string): boolean {
  if (!manifest.signature || manifest.signature.algorithm !== "ed25519") {
    return false;
  }

  const publicKey = createPublicKey(publicKeyPem);
  return verify(null, buildManifestPayload(manifest), publicKey, Buffer.from(manifest.signature.value, "base64"));
}
