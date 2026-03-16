import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { RouteBypassTarget } from "./network-types.js";

export async function resolveWsBypassTargets(
  endpoint: string,
  activeRemoteAddress?: string | null
): Promise<RouteBypassTarget[]> {
  const url = new URL(endpoint);
  const targets = new Map<string, RouteBypassTarget>();

  if (activeRemoteAddress && isIP(activeRemoteAddress) === 4) {
    targets.set(activeRemoteAddress, {
      ip: activeRemoteAddress,
      reason: `Preserve active WebSocket control-plane path to ${endpoint}`
    });
  }

  for (const ip of await resolveHostnameToIpv4(url.hostname)) {
    targets.set(ip, {
      ip,
      reason: `Preserve WebSocket endpoint reachability for ${endpoint}`
    });
  }

  return [...targets.values()];
}

export async function resolveHyperDhtBypassTargets(
  bootstrap: string[],
  activeRemoteHost?: string | null
): Promise<RouteBypassTarget[]> {
  const targets = new Map<string, RouteBypassTarget>();

  if (activeRemoteHost && isIP(activeRemoteHost) === 4) {
    targets.set(activeRemoteHost, {
      ip: activeRemoteHost,
      reason: "Preserve active HyperDHT peer/relay path"
    });
  }

  for (const entry of bootstrap) {
    const parsed = parseBootstrapEntry(entry);
    const candidates = parsed.suggestedIp ? [parsed.suggestedIp] : await resolveHostnameToIpv4(parsed.host);

    for (const ip of candidates) {
      targets.set(ip, {
        ip,
        reason: `Preserve HyperDHT bootstrap reachability for ${parsed.host}:${parsed.port}`
      });
    }
  }

  return [...targets.values()];
}

export function dedupeBypassTargets(targets: RouteBypassTarget[]): RouteBypassTarget[] {
  const deduped = new Map<string, RouteBypassTarget>();

  for (const target of targets) {
    if (!deduped.has(target.ip)) {
      deduped.set(target.ip, target);
    }
  }

  return [...deduped.values()];
}

async function resolveHostnameToIpv4(hostname: string): Promise<string[]> {
  if (isIP(hostname) === 4) {
    return [hostname];
  }

  if (isIP(hostname) === 6) {
    return [];
  }

  const results = await lookup(hostname, { all: true, family: 4, verbatim: true }).catch(() => []);
  return results.map((result) => result.address);
}

function parseBootstrapEntry(entry: string): { suggestedIp?: string; host: string; port: number } {
  const [suggestedPart, hostPortPart] = entry.includes("@") ? entry.split("@", 2) : [undefined, entry];
  const separatorIndex = hostPortPart.lastIndexOf(":");

  if (separatorIndex === -1) {
    throw new Error(`Invalid HyperDHT bootstrap entry '${entry}'`);
  }

  const host = hostPortPart.slice(0, separatorIndex);
  const port = Number.parseInt(hostPortPart.slice(separatorIndex + 1), 10);

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid HyperDHT bootstrap entry '${entry}'`);
  }

  return {
    suggestedIp: suggestedPart && isIP(suggestedPart) === 4 ? suggestedPart : undefined,
    host,
    port
  };
}
