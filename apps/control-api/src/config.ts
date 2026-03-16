import { readFile, writeFile } from "node:fs/promises";

import { generateTicketIssuerKeyPair, type TicketIssuerKeyPair } from "@p2pvpn/identity";

export interface ControlApiConfig {
  version: 1;
  networkName: string;
  listen: {
    host: string;
    port: number;
  };
  issuerKeyPair: TicketIssuerKeyPair;
  tickets: {
    ttlSeconds: number;
    maxClockSkewSeconds: number;
  };
}

export function generateControlApiConfig(networkName = "p2pvpn-dev"): ControlApiConfig {
  return {
    version: 1,
    networkName,
    listen: {
      host: "0.0.0.0",
      port: 8787
    },
    issuerKeyPair: generateTicketIssuerKeyPair(),
    tickets: {
      ttlSeconds: 8 * 60 * 60,
      maxClockSkewSeconds: 5 * 60
    }
  };
}

export async function saveControlApiConfig(path: string, config: ControlApiConfig): Promise<void> {
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function loadControlApiConfig(path: string): Promise<ControlApiConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as ControlApiConfig;

  if (parsed.version !== 1) {
    throw new Error("Unsupported control API config version");
  }

  parsed.tickets ??= {
    ttlSeconds: 8 * 60 * 60,
    maxClockSkewSeconds: 5 * 60
  };

  return parsed;
}
