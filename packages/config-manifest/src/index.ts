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

export interface NetworkManifest {
  version: 1;
  networkName: string;
  generatedAt: string;
  bootstrap: string[];
  controlApiBaseUrl?: string;
  servers: NetworkServerEntry[];
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
    })
  };
}

export async function loadManifest(path: string): Promise<NetworkManifest> {
  const raw = await readFile(path, "utf8");
  return parseManifest(raw);
}

export function selectServer(manifest: NetworkManifest, preferredServerId?: string): NetworkServerEntry {
  if (preferredServerId) {
    const selected = manifest.servers.find((server) => server.id === preferredServerId && server.enabled);
    if (!selected) {
      throw new Error(`Server '${preferredServerId}' not found or disabled`);
    }

    return selected;
  }

  const enabledServers = manifest.servers.filter((server) => server.enabled);

  if (enabledServers.length === 0) {
    throw new Error("Manifest does not contain any enabled servers");
  }

  enabledServers.sort((left, right) => right.weight - left.weight);
  return enabledServers[0]!;
}

export function resolveBootstrap(manifest: NetworkManifest, server: NetworkServerEntry): string[] {
  return server.bootstrap?.length ? [...server.bootstrap] : [...manifest.bootstrap];
}
