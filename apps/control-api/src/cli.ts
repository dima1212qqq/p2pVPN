import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { loadControlApiConfig, generateControlApiConfig, saveControlApiConfig } from "./config.js";
import {
  createInviteCode,
  loadInviteCodes,
  saveInviteCodes,
  saveRegisteredDevices,
  type InviteCodesFile,
  type RegisteredDevicesFile
} from "./storage.js";
import { startControlApi } from "./server.js";

interface ParsedArgs {
  command?: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (!token || !token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = rest[index + 1];

    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return { command, flags };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  switch (parsed.command) {
    case "init-config": {
      const configPath = String(parsed.flags.config ?? "./config/generated/control-api.json");
      const invitesPath = String(parsed.flags.invites ?? "./config/generated/invite-codes.json");
      const devicesPath = String(parsed.flags.devices ?? "./config/generated/registered-devices.json");
      const networkName = typeof parsed.flags["network-name"] === "string" ? parsed.flags["network-name"] : "p2pvpn-dev";
      const host = typeof parsed.flags.host === "string" ? parsed.flags.host : "0.0.0.0";
      const port = typeof parsed.flags.port === "string" ? Number(parsed.flags.port) : 8787;

      await mkdir(dirname(configPath), { recursive: true });
      await mkdir(dirname(invitesPath), { recursive: true });
      await mkdir(dirname(devicesPath), { recursive: true });

      const config = generateControlApiConfig(networkName);
      config.listen.host = host;
      config.listen.port = port;

      await saveControlApiConfig(configPath, config);
      await saveInviteCodes(invitesPath, { version: 1, invites: [] });
      await saveRegisteredDevices(devicesPath, { version: 1, devices: [] });

      console.log(`[control-api] wrote ${configPath}`);
      console.log(`[control-api] wrote ${invitesPath}`);
      console.log(`[control-api] wrote ${devicesPath}`);
      console.log(config.issuerKeyPair.publicKeyPem.trim());
      return;
    }

    case "create-invite": {
      const invitesPath = String(parsed.flags.invites ?? "./config/generated/invite-codes.json");
      const label = typeof parsed.flags.label === "string" ? parsed.flags.label : undefined;
      const maxUses = typeof parsed.flags["max-uses"] === "string" ? Number(parsed.flags["max-uses"]) : 1;
      const expiresAt = typeof parsed.flags["expires-at"] === "string" ? parsed.flags["expires-at"] : undefined;

      const invitesFile: InviteCodesFile = await loadInviteCodes(invitesPath);
      const invite = createInviteCode({ label, maxUses, expiresAt });
      invitesFile.invites.push(invite);
      await saveInviteCodes(invitesPath, invitesFile);

      console.log(`[control-api] invite=${invite.code}`);
      return;
    }

    case "run": {
      const configPath = String(parsed.flags.config ?? "./config/generated/control-api.json");
      const invitesPath = String(parsed.flags.invites ?? "./config/generated/invite-codes.json");
      const devicesPath = String(parsed.flags.devices ?? "./config/generated/registered-devices.json");
      const config = await loadControlApiConfig(configPath);
      const running = await startControlApi({ config, invitesPath, devicesPath });

      const shutdown = async () => {
        await running.close();
        process.exit(0);
      };

      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
      return;
    }

    case "show-issuer-public-key": {
      const configPath = String(parsed.flags.config ?? "./config/generated/control-api.json");
      const config = await loadControlApiConfig(configPath);
      console.log(config.issuerKeyPair.publicKeyPem.trim());
      return;
    }

    default:
      printUsage();
  }
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  init-config --config <path> --invites <path> --devices <path> [--network-name <name>] [--host <host>] [--port <port>]");
  console.log("  create-invite --invites <path> [--label <text>] [--max-uses <n>] [--expires-at <iso>]");
  console.log("  show-issuer-public-key --config <path>");
  console.log("  run --config <path> --invites <path> --devices <path>");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
