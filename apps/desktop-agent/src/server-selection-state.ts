import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ensureParentDirectory } from "@p2pvpn/identity";

export interface ServerSelectionState {
  version: 1;
  networkName: string;
  lastServerId: string;
  updatedAt: string;
}

export function getServerSelectionStatePath(identityPath: string): string {
  return join(dirname(identityPath), "server-selection.json");
}

export async function loadServerSelectionState(
  identityPath: string,
  expectedNetworkName: string
): Promise<ServerSelectionState | null> {
  try {
    const raw = await readFile(getServerSelectionStatePath(identityPath), "utf8");
    const parsed = JSON.parse(raw) as Partial<ServerSelectionState>;

    if (
      parsed.version !== 1 ||
      parsed.networkName !== expectedNetworkName ||
      typeof parsed.lastServerId !== "string" ||
      parsed.lastServerId.trim() === "" ||
      typeof parsed.updatedAt !== "string" ||
      parsed.updatedAt.trim() === ""
    ) {
      return null;
    }

    return {
      version: 1,
      networkName: parsed.networkName,
      lastServerId: parsed.lastServerId,
      updatedAt: parsed.updatedAt
    };
  } catch {
    return null;
  }
}

export async function saveServerSelectionState(
  identityPath: string,
  networkName: string,
  serverId: string
): Promise<void> {
  const path = getServerSelectionStatePath(identityPath);
  await ensureParentDirectory(path);
  await writeFile(
    path,
    `${JSON.stringify(
      {
        version: 1,
        networkName,
        lastServerId: serverId,
        updatedAt: new Date().toISOString()
      } satisfies ServerSelectionState,
      null,
      2
    )}\n`,
    "utf8"
  );
}
