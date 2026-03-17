const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { mkdir } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { ensureManagedManifest } = require("./manifest-runtime.cjs");
const projectRoot = path.join(__dirname, "..", "..", "..");

let mainWindow = null;
let agentProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 300,
    height: 220,
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: "#101927",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  void mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopAgent();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("agent:connect", async (_event, options) => {
  const agentCliPath = getAgentCliPath();
  if (!existsSync(agentCliPath)) {
    throw new Error("Desktop agent is not built. Run `npm run build` first.");
  }

  const resolvedOptions = {
    ...(await getDefaultAgentOptions()),
    ...(options ?? {})
  };

  if (!existsSync(resolvedOptions.manifestPath)) {
    throw new Error(`Manifest file not found: ${resolvedOptions.manifestPath}`);
  }

  if (!existsSync(resolvedOptions.identityPath)) {
    throw new Error(`Identity file not found: ${resolvedOptions.identityPath}`);
  }

  const runtimeRoot = getRuntimeRoot();
  stopAgent();

  const args = [
    agentCliPath,
    "connect",
    "--manifest",
    resolvedOptions.manifestPath,
    "--identity",
    resolvedOptions.identityPath,
    "--json-events"
  ];

  if (resolvedOptions.serverId) {
    args.push("--server", resolvedOptions.serverId);
  }

  if (resolvedOptions.useWintun) {
    args.push("--wintun");

    if (resolvedOptions.wintunAdapterName) {
      args.push("--wintun-adapter", resolvedOptions.wintunAdapterName);
    }

    if (resolvedOptions.applyRoutes) {
      args.push("--apply-routes");
    }
  }

  const isPackagedRuntime = app.isPackaged;
  const childCommand = isPackagedRuntime ? process.execPath : "node";
  const childEnv = {
    ...process.env,
    ...(isPackagedRuntime ? { ELECTRON_RUN_AS_NODE: "1" } : {})
  };

  agentProcess = spawn(childCommand, args, {
    cwd: runtimeRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  agentProcess.stdout.setEncoding("utf8");
  agentProcess.stderr.setEncoding("utf8");

  agentProcess.stdout.on("data", (chunk) => {
    const lines = String(chunk)
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        mainWindow?.webContents.send("agent:event", event);
      } catch {
        mainWindow?.webContents.send("agent:event", { event: "log", message: line });
      }
    }
  });

  agentProcess.stderr.on("data", (chunk) => {
    mainWindow?.webContents.send("agent:event", {
      event: "stderr",
      message: String(chunk).trim()
    });
  });

  agentProcess.on("exit", (code, signal) => {
    mainWindow?.webContents.send("agent:event", {
      event: "agent-exit",
      code,
      signal: signal ?? null,
      message: signal ? `Agent exited via signal ${signal}` : `Agent exited with code ${code ?? "null"}`
    });
    agentProcess = null;
  });

  return { started: true };
});

ipcMain.handle("app:defaults", async () => {
  const defaults = await getDefaultAgentOptions();

  return {
    ...defaults,
    manifestExists: existsSync(defaults.manifestPath),
    identityExists: existsSync(defaults.identityPath),
    registrationExists: existsSync(getRegistrationStatePath(defaults.identityPath))
  };
});

ipcMain.handle("agent:disconnect", async () => {
  stopAgent();
  return { stopped: true };
});

ipcMain.handle("agent:register", async (_event, options) => {
  const resolvedOptions = {
    ...(await getDefaultAgentOptions()),
    ...(options ?? {})
  };

  if (!resolvedOptions.inviteCode || typeof resolvedOptions.inviteCode !== "string") {
    throw new Error("Invite code is required");
  }

  stopAgent();
  await runAgentUtilityCommand([
    "register",
    "--manifest",
    resolvedOptions.manifestPath,
    "--identity",
    resolvedOptions.identityPath,
    "--invite-code",
    resolvedOptions.inviteCode
  ]);

  return {
    registered: existsSync(getRegistrationStatePath(resolvedOptions.identityPath))
  };
});

function stopAgent() {
  if (!agentProcess) {
    return;
  }

  agentProcess.kill();
  agentProcess = null;
}

async function getDefaultAgentOptions() {
  const runtimeRoot = getRuntimeRoot();
  const identityPath = app.isPackaged ? await ensurePackagedIdentity() : path.join(runtimeRoot, "config", "generated", "client-identity.json");
  const manifestPath = app.isPackaged
    ? (await ensureManagedManifest({
        runtimeRoot,
        userDataPath: app.getPath("userData"),
        packaged: true
      })).manifestPath
    : path.join(runtimeRoot, "config", "generated", "network.hyperdht-only.manifest.json");

  return {
    manifestPath,
    identityPath,
    useWintun: true,
    applyRoutes: true,
    wintunAdapterName: "p2pvpn"
  };
}

function getRuntimeRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "runtime");
  }

  return projectRoot;
}

function getAgentCliPath() {
  if (app.isPackaged) {
    return path.join(getRuntimeRoot(), "apps", "desktop-agent", "dist", "cli.js");
  }

  return path.join(__dirname, "..", "..", "desktop-agent", "dist", "cli.js");
}

async function ensurePackagedIdentity() {
  const identityPath = path.join(app.getPath("userData"), "client-identity.json");
  if (existsSync(identityPath)) {
    return identityPath;
  }

  await mkdir(path.dirname(identityPath), { recursive: true });
  await runAgentUtilityCommand([
    "init-identity",
    "--identity",
    identityPath,
    "--name",
    `${app.getName()} ${os.hostname()}`
  ]);

  return identityPath;
}

function getRegistrationStatePath(identityPath) {
  return path.join(path.dirname(identityPath), "device-registration.json");
}

async function runAgentUtilityCommand(commandArgs) {
  const agentCliPath = getAgentCliPath();
  const isPackagedRuntime = app.isPackaged;
  const childCommand = isPackagedRuntime ? process.execPath : "node";
  const childEnv = {
    ...process.env,
    ...(isPackagedRuntime ? { ELECTRON_RUN_AS_NODE: "1" } : {})
  };

  await new Promise((resolve, reject) => {
    const child = spawn(childCommand, [agentCliPath, ...commandArgs], {
      cwd: getRuntimeRoot(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Agent utility command failed${signal ? ` via signal ${signal}` : ` with code ${code ?? "null"}`}${stderr ? `: ${stderr.trim()}` : ""}`
        )
      );
    });
  });
}
