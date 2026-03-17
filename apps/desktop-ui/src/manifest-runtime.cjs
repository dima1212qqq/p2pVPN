const { copyFile, mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const MANIFEST_FILE_NAME = "network.hyperdht-only.manifest.json";
const TRUST_KEY_FILE_NAME = "manifest-signing-public-key.pem";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let lastRefreshAt = 0;
let inFlightRefresh = null;

async function ensureManagedManifest(options) {
  const managedManifestPath = getManagedManifestPath(options.userDataPath);

  if (!options.packaged) {
    return {
      manifestPath: path.join(options.runtimeRoot, "config", "generated", MANIFEST_FILE_NAME),
      updated: false
    };
  }

  if (!inFlightRefresh || options.forceRefresh || Date.now() - lastRefreshAt > REFRESH_INTERVAL_MS) {
    inFlightRefresh = refreshManagedManifest(options).finally(() => {
      lastRefreshAt = Date.now();
      inFlightRefresh = null;
    });
  }

  await inFlightRefresh;

  return {
    manifestPath: managedManifestPath,
    updated: true
  };
}

function getManagedManifestPath(userDataPath) {
  return path.join(userDataPath, MANIFEST_FILE_NAME);
}

async function refreshManagedManifest(options) {
  const manifestModule = await loadManifestModule(options.runtimeRoot, options.packaged);
  const bundledManifestPath = path.join(options.runtimeRoot, "config", "generated", MANIFEST_FILE_NAME);
  const bundledTrustKeyPath = path.join(options.runtimeRoot, "config", "generated", TRUST_KEY_FILE_NAME);
  const managedManifestPath = getManagedManifestPath(options.userDataPath);
  const managedTrustKeyPath = path.join(options.userDataPath, TRUST_KEY_FILE_NAME);

  await mkdir(options.userDataPath, { recursive: true });

  if (existsSync(bundledTrustKeyPath)) {
    await copyFile(bundledTrustKeyPath, managedTrustKeyPath);
  }

  if (!existsSync(managedManifestPath)) {
    await copyFile(bundledManifestPath, managedManifestPath);
  } else {
    await syncBundledFallbackManifest({
      bundledManifestPath,
      managedManifestPath,
      manifestModule
    });
  }

  const trustPublicKeyPem = existsSync(managedTrustKeyPath) ? await readFile(managedTrustKeyPath, "utf8") : undefined;
  const currentManifest = await manifestModule.loadManifest(managedManifestPath, {
    trustedPublicKeyPem: trustPublicKeyPem
  });

  if (!currentManifest.updateUrl) {
    return;
  }

  if (!trustPublicKeyPem) {
    return;
  }

  try {
    const response = await fetch(currentManifest.updateUrl, {
      method: "GET",
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Manifest update request failed with HTTP ${response.status}`);
    }

    const rawManifest = await response.text();
    const remoteManifest = manifestModule.parseManifest(rawManifest);

    if (!remoteManifest.signature) {
      throw new Error("Remote manifest is unsigned");
    }

    if (!manifestModule.verifyManifest(remoteManifest, trustPublicKeyPem)) {
      throw new Error("Remote manifest signature is invalid");
    }

    if (remoteManifest.networkName !== currentManifest.networkName) {
      throw new Error("Remote manifest belongs to a different network");
    }

    if (!isRemoteManifestPreferred(currentManifest, remoteManifest)) {
      return;
    }

    const tempPath = `${managedManifestPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(remoteManifest, null, 2)}\n`, "utf8");
    await rm(managedManifestPath, { force: true });
    await rename(tempPath, managedManifestPath);
  } catch (error) {
    console.warn(`[desktop-ui] manifest update skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function syncBundledFallbackManifest(options) {
  const bundledManifest = await options.manifestModule.loadManifest(options.bundledManifestPath);
  const managedManifest = await options.manifestModule.loadManifest(options.managedManifestPath);

  if (isRemoteManifestPreferred(managedManifest, bundledManifest)) {
    await copyFile(options.bundledManifestPath, options.managedManifestPath);
  }
}

function isRemoteManifestPreferred(currentManifest, remoteManifest) {
  const currentGeneratedAt = Date.parse(currentManifest.generatedAt);
  const remoteGeneratedAt = Date.parse(remoteManifest.generatedAt);

  if (Number.isFinite(currentGeneratedAt) && Number.isFinite(remoteGeneratedAt)) {
    return remoteGeneratedAt > currentGeneratedAt;
  }

  return JSON.stringify(currentManifest) !== JSON.stringify(remoteManifest);
}

async function loadManifestModule(runtimeRoot, packaged) {
  const preferredModulePath = packaged
    ? path.join(runtimeRoot, "node_modules", "@p2pvpn", "config-manifest", "dist", "index.js")
    : path.join(runtimeRoot, "packages", "config-manifest", "dist", "index.js");
  const fallbackModulePath = path.join(process.cwd(), "packages", "config-manifest", "dist", "index.js");
  const modulePath = existsSync(preferredModulePath) ? preferredModulePath : fallbackModulePath;

  return import(pathToFileURL(modulePath).href);
}

module.exports = {
  ensureManagedManifest
};
