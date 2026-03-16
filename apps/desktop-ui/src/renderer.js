const elements = {
  actionButton: document.getElementById("actionButton")
};
let defaults = null;
let connectionState = "idle";

function renderActionButton() {
  if (connectionState === "connecting") {
    elements.actionButton.textContent = "Connecting...";
    elements.actionButton.className = "button-primary";
    elements.actionButton.disabled = true;
    return;
  }

  if (connectionState === "connected") {
    elements.actionButton.textContent = "Disconnect";
    elements.actionButton.className = "button-danger";
    elements.actionButton.disabled = false;
    return;
  }

  elements.actionButton.textContent = "Connect";
  elements.actionButton.className = "button-primary";
  elements.actionButton.disabled = false;
}

function applyDefaults(config) {
  defaults = config;
  if (!config.manifestExists || !config.identityExists) {
    elements.actionButton.disabled = true;
    return;
  }

  renderActionButton();
}

function reportUiError(error) {
  connectionState = "idle";
  renderActionButton();
  console.error(error);
}

if (!window.desktopUi) {
  reportUiError(new Error("Electron preload bridge is unavailable."));
}

if (window.desktopUi) {
  try {
    window.desktopUi.getDefaults().then(applyDefaults).catch(reportUiError);
  } catch (error) {
    reportUiError(error);
  }
}

elements.actionButton.addEventListener("click", async () => {
  try {
    if (!defaults) {
      throw new Error("Application defaults are not loaded yet.");
    }

    if (connectionState === "connecting" || connectionState === "connected") {
      connectionState = "idle";
      renderActionButton();
      await window.desktopUi.disconnect();
      return;
    }

    connectionState = "connecting";
    renderActionButton();
    await window.desktopUi.connect(defaults);
  } catch (error) {
    reportUiError(error);
  }
});

if (window.desktopUi) {
  window.desktopUi.onAgentEvent((event) => {
    if (event.event === "connected") {
      connectionState = "connected";
      renderActionButton();
    } else if (event.event === "tunnel-started") {
      connectionState = "connected";
      renderActionButton();
    } else if (event.event === "error" || event.event === "stderr" || event.event === "ui-error") {
      connectionState = "idle";
      renderActionButton();
    } else if (event.event === "disconnected" || event.event === "agent-exit") {
      connectionState = "idle";
      renderActionButton();
    } else if (event.event === "connecting") {
      connectionState = "connecting";
      renderActionButton();
    } else if (event.event === "tunnel-stopped") {
      connectionState = "idle";
      renderActionButton();
    }
  });
}
