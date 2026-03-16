import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

import { loadManifest } from "@p2pvpn/config-manifest";
import { createAuthorizedClient, generateClientIdentity, loadClientIdentity, saveClientIdentity } from "@p2pvpn/identity";

import { runAgent } from "./agent.js";
import { registerDeviceWithInvite } from "./control-api.js";
import { isRunningAsWindowsAdmin } from "./windows-admin.js";

const require = createRequire(import.meta.url);

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
    case "init-identity": {
      const identityPath = String(parsed.flags.identity ?? "./config/generated/client-identity.json");
      const name = typeof parsed.flags.name === "string" ? parsed.flags.name : "Desktop Client";

      await mkdir(dirname(identityPath), { recursive: true });
      const identity = generateClientIdentity(name);
      await saveClientIdentity(identityPath, identity);

      console.log(`[desktop-agent] wrote ${identityPath}`);
      console.log(`[desktop-agent] fingerprint=${identity.fingerprint}`);
      return;
    }

    case "export-public": {
      const identityPath = String(parsed.flags.identity ?? "./config/generated/client-identity.json");
      const identity = await loadClientIdentity(identityPath);
      process.stdout.write(`${JSON.stringify(createAuthorizedClient(identity), null, 2)}\n`);
      return;
    }

    case "connect": {
      const manifestPath = String(parsed.flags.manifest ?? "./config/generated/network.manifest.json");
      const identityPath = String(parsed.flags.identity ?? "./config/generated/client-identity.json");
      const preferredServerId = typeof parsed.flags.server === "string" ? parsed.flags.server : undefined;
      const controlApiBaseUrl = typeof parsed.flags["control-api"] === "string" ? parsed.flags["control-api"] : undefined;
      const tunnelMode = Boolean(parsed.flags.wintun) ? "wintun" : Boolean(parsed.flags["dev-tunnel"]) ? "dev-loopback" : "none";
      const wintunAdapterName = typeof parsed.flags["wintun-adapter"] === "string" ? parsed.flags["wintun-adapter"] : undefined;
      const wintunDllPath = typeof parsed.flags["wintun-dll"] === "string" ? parsed.flags["wintun-dll"] : undefined;

      await runAgent({
        manifestPath,
        identityPath,
        preferredServerId,
        jsonEvents: Boolean(parsed.flags["json-events"]),
        once: Boolean(parsed.flags.once),
        tunnelMode,
        wintunAdapterName,
        wintunDllPath,
        applyRoutes: Boolean(parsed.flags["apply-routes"]),
        controlApiBaseUrl
      });
      return;
    }

    case "register": {
      const manifestPath = String(parsed.flags.manifest ?? "./config/generated/network.manifest.json");
      const identityPath = String(parsed.flags.identity ?? "./config/generated/client-identity.json");
      const inviteCode = typeof parsed.flags["invite-code"] === "string" ? parsed.flags["invite-code"] : undefined;
      const controlApiBaseUrl = typeof parsed.flags["control-api"] === "string" ? parsed.flags["control-api"] : undefined;

      if (!inviteCode) {
        throw new Error("register requires --invite-code");
      }

      const manifest = await loadManifest(manifestPath);
      const identity = await loadClientIdentity(identityPath);
      const resolvedControlApiBaseUrl = controlApiBaseUrl ?? manifest.controlApiBaseUrl;
      if (!resolvedControlApiBaseUrl) {
        throw new Error("Manifest does not define controlApiBaseUrl and --control-api was not provided");
      }

      await registerDeviceWithInvite({
        controlApiBaseUrl: resolvedControlApiBaseUrl,
        identity,
        inviteCode
      });

      console.log(`[desktop-agent] registered fingerprint=${identity.fingerprint}`);
      return;
    }

    case "doctor-wintun": {
      await runWintunDoctor({
        dllPath: typeof parsed.flags["wintun-dll"] === "string" ? parsed.flags["wintun-dll"] : undefined
      });
      return;
    }

    default:
      printUsage();
  }
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  init-identity --identity <path> [--name <device name>]");
  console.log("  export-public --identity <path>");
  console.log("  register --manifest <path> --identity <path> --invite-code <code> [--control-api <url>]");
  console.log("  connect --manifest <path> --identity <path> [--server <id>] [--json-events] [--once] [--dev-tunnel]");
  console.log("  connect --manifest <path> --identity <path> [--server <id>] [--control-api <url>] [--wintun] [--wintun-adapter <name>] [--wintun-dll <path>] [--apply-routes]");
  console.log("  doctor-wintun [--wintun-dll <path>]");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

interface WintunDoctorOptions {
  dllPath?: string;
}

interface LoadedWintunModule {
  Wintun?: {
    init: () => number;
    set_dll_path: (dllPath: string) => void;
    get_wintun_dll_path: () => string;
  };
}

async function runWintunDoctor(options: WintunDoctorOptions): Promise<void> {
  console.log(`[desktop-agent] platform=${process.platform} arch=${process.arch}`);

  if (process.platform !== "win32") {
    throw new Error("doctor-wintun is only supported on Windows");
  }

  const module = require("@xiaobaidadada/node-tuntap2-wintun") as LoadedWintunModule;
  if (!module.Wintun) {
    throw new Error("Package '@xiaobaidadada/node-tuntap2-wintun' did not export Wintun");
  }

  const dllPath = resolve(options.dllPath ?? process.env.P2PVPN_WINTUN_DLL ?? module.Wintun.get_wintun_dll_path());
  await access(dllPath);

  console.log(`[desktop-agent] dll=${dllPath}`);
  console.log(`[desktop-agent] admin=${await isRunningAsWindowsAdmin()}`);

  module.Wintun.set_dll_path(dllPath);
  const initResult = module.Wintun.init();
  console.log(`[desktop-agent] initResult=${String(initResult)}`);

  if (initResult !== 1) {
    throw new Error(`Unexpected Wintun.init() result ${String(initResult)}`);
  }
}
