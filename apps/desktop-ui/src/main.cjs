const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const agentCliPath = path.join(__dirname, "..", "..", "desktop-agent", "dist", "cli.js");

let mainWindow = null;
let agentProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
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

ipcMain.handle("dialog:pick-file", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"]
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("agent:connect", async (_event, options) => {
  if (!existsSync(agentCliPath)) {
    throw new Error("Desktop agent is not built. Run `npm run build` first.");
  }

  if (!options?.manifestPath || !options?.identityPath) {
    throw new Error("Manifest Path and Identity Path are required.");
  }

  stopAgent();

  const args = [
    agentCliPath,
    "connect",
    "--manifest",
    options.manifestPath,
    "--identity",
    options.identityPath,
    "--json-events"
  ];

  if (options.serverId) {
    args.push("--server", options.serverId);
  }

  agentProcess = spawn("node", args, {
    cwd: path.join(__dirname, "..", "..", ".."),
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

  agentProcess.on("exit", (code) => {
    mainWindow?.webContents.send("agent:event", {
      event: "agent-exit",
      code,
      message: `Agent exited with code ${code ?? "null"}`
    });
    agentProcess = null;
  });

  return { started: true };
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
