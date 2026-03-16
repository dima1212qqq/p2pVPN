import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { generateInviteBotConfig, loadInviteBotConfig, saveInviteBotConfig } from "./config.js";
import { startInviteBot } from "./bot.js";

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
      const configPath = String(parsed.flags.config ?? "./config/generated/invite-bot.json");
      await mkdir(dirname(configPath), { recursive: true });
      await saveInviteBotConfig(configPath, generateInviteBotConfig());
      console.log(`[invite-bot] wrote ${configPath}`);
      return;
    }

    case "run": {
      const configPath = String(parsed.flags.config ?? "./config/generated/invite-bot.json");
      const config = await loadInviteBotConfig(configPath);
      const running = await startInviteBot({
        config,
        projectRoot: resolve(dirname(configPath), "..", "..")
      });

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
  console.log("  init-config --config <path>");
  console.log("  run --config <path>");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
