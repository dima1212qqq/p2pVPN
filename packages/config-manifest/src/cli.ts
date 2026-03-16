import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  generateManifestSigningKeyPair,
  parseManifest,
  signManifest,
  verifyManifest
} from "./index.js";

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
  const baseDirectory = process.env.INIT_CWD ?? process.cwd();

  switch (parsed.command) {
    case "init-signing-key": {
      const publicKeyPath = resolveCliPath(baseDirectory, String(parsed.flags.public ?? "./config/generated/manifest-signing-public-key.pem"));
      const privateKeyPath = resolveCliPath(baseDirectory, String(parsed.flags.private ?? "./config/generated/manifest-signing-private-key.pem"));
      const keyPair = generateManifestSigningKeyPair();

      await writeFile(publicKeyPath, keyPair.publicKeyPem, "utf8");
      await writeFile(privateKeyPath, keyPair.privateKeyPem, "utf8");
      console.log(`[config-manifest] wrote ${publicKeyPath}`);
      console.log(`[config-manifest] wrote ${privateKeyPath}`);
      return;
    }

    case "sign": {
      const manifestPath = resolveCliPath(baseDirectory, String(parsed.flags.manifest ?? "./config/generated/network.hyperdht-only.manifest.json"));
      const privateKeyPath = resolveCliPath(baseDirectory, String(parsed.flags.private ?? "./config/generated/manifest-signing-private-key.pem"));
      const keyId = typeof parsed.flags["key-id"] === "string" ? parsed.flags["key-id"] : undefined;
      const manifest = parseManifest(await readFile(manifestPath, "utf8"));
      const privateKeyPem = await readFile(privateKeyPath, "utf8");
      const signedManifest = signManifest(manifest, privateKeyPem, keyId);

      await writeFile(manifestPath, `${JSON.stringify(signedManifest, null, 2)}\n`, "utf8");
      console.log(`[config-manifest] signed ${manifestPath}`);
      return;
    }

    case "verify": {
      const manifestPath = resolveCliPath(baseDirectory, String(parsed.flags.manifest ?? "./config/generated/network.hyperdht-only.manifest.json"));
      const publicKeyPath = resolveCliPath(baseDirectory, String(parsed.flags.public ?? "./config/generated/manifest-signing-public-key.pem"));
      const manifest = parseManifest(await readFile(manifestPath, "utf8"));
      const publicKeyPem = await readFile(publicKeyPath, "utf8");

      if (!verifyManifest(manifest, publicKeyPem)) {
        throw new Error(`Manifest signature is invalid: ${manifestPath}`);
      }

      console.log(`[config-manifest] signature ok ${manifestPath}`);
      return;
    }

    default:
      printUsage();
  }
}

function resolveCliPath(baseDirectory: string, targetPath: string): string {
  return isAbsolute(targetPath) ? targetPath : resolve(baseDirectory, targetPath);
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  init-signing-key [--public <path>] [--private <path>]");
  console.log("  sign [--manifest <path>] [--private <path>] [--key-id <id>]");
  console.log("  verify [--manifest <path>] [--public <path>]");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
