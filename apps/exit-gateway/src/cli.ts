import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";

import { saveAuthorizedClients } from "@p2pvpn/identity";

import { generateServerConfig, loadServerConfig, saveServerConfig } from "./config.js";
import { startExitGateway } from "./server.js";

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
    case "init-server": {
      const configPath = String(parsed.flags.config ?? "./config/generated/server.json");
      const allowlistPath = String(parsed.flags.allowlist ?? "./config/generated/authorized-clients.json");
      const serverId = typeof parsed.flags["server-id"] === "string" ? parsed.flags["server-id"] : "pl-dev-1";
      const authMode = typeof parsed.flags["auth-mode"] === "string" ? parsed.flags["auth-mode"] : undefined;
      const ticketIssuerPublicKeyPath =
        typeof parsed.flags["ticket-issuer-public-key"] === "string" ? parsed.flags["ticket-issuer-public-key"] : undefined;
      const ticketNetworkName =
        typeof parsed.flags["ticket-network-name"] === "string" ? parsed.flags["ticket-network-name"] : undefined;
      const requestedDataPlane =
        typeof parsed.flags["data-plane"] === "string" ? parsed.flags["data-plane"] : undefined;

      await mkdir(dirname(configPath), { recursive: true });
      await mkdir(dirname(allowlistPath), { recursive: true });

      const config = generateServerConfig(serverId);
      if (requestedDataPlane === "none" || requestedDataPlane === "dev-loopback" || requestedDataPlane === "tun") {
        config.dataPlane.mode = requestedDataPlane;
      }
      if (authMode === "allowlist" || authMode === "ticket") {
        config.auth.mode = authMode;
      }
      if (ticketNetworkName) {
        config.auth.ticket.expectedNetworkName = ticketNetworkName;
      }
      if (ticketIssuerPublicKeyPath) {
        config.auth.ticket.issuerPublicKeyPem = await readFile(ticketIssuerPublicKeyPath, "utf8");
      }

      await saveServerConfig(configPath, config);
      await saveAuthorizedClients(allowlistPath, { version: 1, clients: [] });

      console.log(`[exit-gateway] wrote ${configPath}`);
      console.log(`[exit-gateway] wrote ${allowlistPath}`);
      console.log(`[exit-gateway] hyperdht.publicKey=${config.transportKeyPair.publicKeyHex}`);
      return;
    }

    case "run": {
      const configPath = String(parsed.flags.config ?? "./config/generated/server.json");
      const allowlistPath = String(parsed.flags.allowlist ?? "./config/generated/authorized-clients.json");
      const config = await loadServerConfig(configPath);
      const running = await startExitGateway(config, allowlistPath);

      const shutdown = async () => {
        await running.close();
        process.exit(0);
      };

      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
      return;
    }

    default:
      printUsage();
  }
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  init-server --config <path> --allowlist <path> [--server-id <id>] [--data-plane <none|dev-loopback|tun>] [--auth-mode <allowlist|ticket>] [--ticket-issuer-public-key <path>] [--ticket-network-name <name>]");
  console.log("  run --config <path> --allowlist <path>");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
