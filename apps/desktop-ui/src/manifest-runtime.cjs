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

  if (!existsSync(managedManifestPath)) {
    await copyFile(bundledManifestPath, managedManifestPath);
  }

  const bundledManifest = await loadManifestUnchecked(manifestModule, bundledManifestPath);
  const currentManifest = await loadManifestUnchecked(manifestModule, managedManifestPath);
  const localTrustKeyPem = existsSync(managedTrustKeyPath) ? await readFile(managedTrustKeyPath, "utf8") : undefined;
  const bundledTrustKeyPem = existsSync(bundledTrustKeyPath) ? await readFile(bundledTrustKeyPath, "utf8") : undefined;
  const currentVerification = verifyManifestWithCandidates(
    manifestModule,
    currentManifest,
    getPinnedTrustCandidates(localTrustKeyPem, bundledTrustKeyPem)
  );
  const updateUrl = currentManifest.updateUrl ?? bundledManifest?.updateUrl;
  const trustKeyUrl =
    currentManifest.trustKeyUrl ??
    bundledManifest?.trustKeyUrl ??
    deriveTrustKeyUrl(updateUrl);

  if (!updateUrl) {
    if (!currentVerification.valid) {
      throw new Error("Manifest signature is invalid and no update URL is configured");
    }

    if (!localTrustKeyPem && currentVerification.trustKeyPem) {
      await writeFile(managedTrustKeyPath, currentVerification.trustKeyPem, "utf8");
    }
    return;
  }

  try {
    const response = await fetch(updateUrl, {
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
    const remoteTrust = await resolveRemoteTrustKey({
      localTrustKeyPem,
      bundledTrustKeyPem,
      trustKeyUrl,
      remoteManifest,
      manifestModule
    });

    if (remoteManifest.networkName !== currentManifest.networkName) {
      throw new Error("Remote manifest belongs to a different network");
    }

    if (!remoteTrust.valid) {
      throw new Error(remoteTrust.errorMessage ?? "Remote manifest signature is invalid");
    }

    if (remoteTrust.persistedTrustKeyPem) {
      await writeFile(managedTrustKeyPath, remoteTrust.persistedTrustKeyPem, "utf8");
    } else if (!localTrustKeyPem && currentVerification.trustKeyPem) {
      await writeFile(managedTrustKeyPath, currentVerification.trustKeyPem, "utf8");
    }

    if (currentVerification.valid && !isRemoteManifestPreferred(currentManifest, remoteManifest)) {
      return;
    }

    const tempPath = `${managedManifestPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(remoteManifest, null, 2)}\n`, "utf8");
    await rm(managedManifestPath, { force: true });
    await rename(tempPath, managedManifestPath);
  } catch (error) {
    if (!currentVerification.valid) {
      throw error;
    }

    if (!localTrustKeyPem && currentVerification.trustKeyPem) {
      await writeFile(managedTrustKeyPath, currentVerification.trustKeyPem, "utf8");
    }

    console.warn(`[desktop-ui] manifest update skipped: ${error instanceof Error ? error.message : String(error)}`);
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

async function loadManifestUnchecked(manifestModule, manifestPath) {
  const raw = await readFile(manifestPath, "utf8");
  return manifestModule.parseManifest(raw);
}

function verifyManifestWithCandidates(manifestModule, manifest, trustKeyCandidates) {
  for (const trustKeyPem of trustKeyCandidates) {
    if (!trustKeyPem) {
      continue;
    }

    if (manifest.signature && manifestModule.verifyManifest(manifest, trustKeyPem)) {
      return {
        valid: true,
        trustKeyPem
      };
    }
  }

  return {
    valid: false,
    trustKeyPem: undefined
  };
}

function getPinnedTrustCandidates(localTrustKeyPem, bundledTrustKeyPem) {
  if (localTrustKeyPem) {
    return [localTrustKeyPem];
  }

  return bundledTrustKeyPem ? [bundledTrustKeyPem] : [];
}

function deriveTrustKeyUrl(updateUrl) {
  if (!updateUrl) {
    return undefined;
  }

  try {
    return new URL(TRUST_KEY_FILE_NAME, updateUrl).toString();
  } catch {
    return undefined;
  }
}

async function resolveRemoteTrustKey(options) {
  const pinnedVerification = verifyManifestWithCandidates(
    options.manifestModule,
    options.remoteManifest,
    getPinnedTrustCandidates(options.localTrustKeyPem, options.bundledTrustKeyPem)
  );

  if (pinnedVerification.valid) {
    return {
      valid: true,
      persistedTrustKeyPem: options.localTrustKeyPem ? undefined : pinnedVerification.trustKeyPem
    };
  }

  if (options.localTrustKeyPem) {
    return {
      valid: false,
      persistedTrustKeyPem: undefined,
      errorMessage: "Pinned manifest trust key does not match the remote manifest signature"
    };
  }

  if (!options.trustKeyUrl) {
    return {
      valid: false,
      persistedTrustKeyPem: undefined,
      errorMessage: "Remote manifest signature is invalid and no trust key URL is configured"
    };
  }

  const response = await fetch(options.trustKeyUrl, {
    method: "GET",
    headers: {
      accept: "text/plain"
    }
  });

  if (!response.ok) {
    throw new Error(`Trust key request failed with HTTP ${response.status}`);
  }

  const fetchedTrustKeyPem = await response.text();
  if (!options.manifestModule.verifyManifest(options.remoteManifest, fetchedTrustKeyPem)) {
    return {
      valid: false,
      persistedTrustKeyPem: undefined,
      errorMessage: "Fetched trust key does not verify the remote manifest"
    };
  }

  return {
    valid: true,
    persistedTrustKeyPem: fetchedTrustKeyPem.trimEnd().concat("\n")
  };
}

module.exports = {
  ensureManagedManifest
};
