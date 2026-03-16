const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const projectRoot = path.join(__dirname, "..", "..", "..");
const agentCliPath = path.join(__dirname, "..", "..", "desktop-agent", "dist", "cli.js");

let mainWindow = null;
let agentProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 260,
    height: 180,
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
  if (!existsSync(agentCliPath)) {
    throw new Error("Desktop agent is not built. Run `npm run build` first.");
  }

  const resolvedOptions = {
    ...getDefaultAgentOptions(),
    ...(options ?? {})
  };

  if (!existsSync(resolvedOptions.manifestPath)) {
    throw new Error(`Manifest file not found: ${resolvedOptions.manifestPath}`);
  }

  if (!existsSync(resolvedOptions.identityPath)) {
    throw new Error(`Identity file not found: ${resolvedOptions.identityPath}`);
  }

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

  agentProcess = spawn("node", args, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"]
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
  const defaults = getDefaultAgentOptions();

  return {
    ...defaults,
    manifestExists: existsSync(defaults.manifestPath),
    identityExists: existsSync(defaults.identityPath)
  };
});

ipcMain.handle("agent:disconnect", async () => {
  stopAgent();
  return { stopped: true };
});

function stopAgent() {
  if (!agentProcess) {
    return;
  }

  agentProcess.kill();
  agentProcess = null;
}

function getDefaultAgentOptions() {
  return {
    manifestPath: path.join(projectRoot, "config", "generated", "network.hyperdht-only.manifest.json"),
    identityPath: path.join(projectRoot, "config", "generated", "client-identity.json"),
    serverId: "pl-dev-1",
    useWintun: true,
    applyRoutes: true,
    wintunAdapterName: "p2pvpn"
  };
}
