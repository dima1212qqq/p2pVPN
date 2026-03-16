const elements = {
  actionButton: document.getElementById("actionButton"),
  inviteShell: document.getElementById("inviteShell"),
  inviteInput: document.getElementById("inviteInput"),
  message: document.getElementById("message")
};
let defaults = null;
let viewState = "loading";

function setMessage(text = "") {
  elements.message.textContent = text;
  elements.message.hidden = text.length === 0;
}

function renderActionButton() {
  const inviteMode = viewState === "needs-registration" || viewState === "registering";
  elements.inviteShell.hidden = !inviteMode;

  if (viewState === "registering") {
    elements.actionButton.textContent = "Activating...";
    elements.actionButton.className = "button-primary";
    elements.actionButton.disabled = true;
    elements.inviteInput.disabled = true;
    return;
  }

  if (viewState === "needs-registration") {
    elements.actionButton.textContent = "Activate";
    elements.actionButton.className = "button-primary";
    elements.actionButton.disabled = false;
    elements.inviteInput.disabled = false;
    return;
  }

  if (viewState === "connecting") {
    elements.actionButton.textContent = "Connecting...";
    elements.actionButton.className = "button-primary";
    elements.actionButton.disabled = true;
    elements.inviteInput.disabled = true;
    return;
  }

  if (viewState === "connected") {
    elements.actionButton.textContent = "Disconnect";
    elements.actionButton.className = "button-danger";
    elements.actionButton.disabled = false;
    elements.inviteInput.disabled = true;
    return;
  }

  elements.actionButton.textContent = "Connect";
  elements.actionButton.className = "button-primary";
  elements.actionButton.disabled = false;
  elements.inviteInput.disabled = true;
}

function applyDefaults(config) {
  defaults = config;
  if (!config.manifestExists || !config.identityExists) {
    viewState = "disabled";
    elements.actionButton.disabled = true;
    setMessage("Missing local config");
    return;
  }

  viewState = config.registrationExists ? "idle" : "needs-registration";
  setMessage("");
  renderActionButton();
}

function reportUiError(error) {
  viewState = defaults?.registrationExists ? "idle" : "needs-registration";
  renderActionButton();
  setMessage(error instanceof Error ? error.message : String(error));
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

    if (viewState === "needs-registration") {
      const inviteCode = elements.inviteInput.value.trim();
      if (!inviteCode) {
        throw new Error("Enter invite code");
      }

      viewState = "registering";
      renderActionButton();
      setMessage("");
      const result = await window.desktopUi.register({
        ...defaults,
        inviteCode
      });
      defaults.registrationExists = Boolean(result?.registered);
      viewState = defaults.registrationExists ? "idle" : "needs-registration";
      elements.inviteInput.value = "";
      setMessage(defaults.registrationExists ? "Device activated" : "Activation failed");
      renderActionButton();
      return;
    }

    if (viewState === "connecting" || viewState === "connected") {
      viewState = "idle";
      renderActionButton();
      setMessage("");
      await window.desktopUi.disconnect();
      return;
    }

    viewState = "connecting";
    renderActionButton();
    setMessage("");
    await window.desktopUi.connect(defaults);
  } catch (error) {
    reportUiError(error);
  }
});

if (window.desktopUi) {
  window.desktopUi.onAgentEvent((event) => {
    if (event.event === "connected") {
      viewState = "connected";
      setMessage("");
      renderActionButton();
    } else if (event.event === "tunnel-started") {
      viewState = "connected";
      setMessage("");
      renderActionButton();
    } else if (event.event === "error" || event.event === "stderr" || event.event === "ui-error") {
      if (typeof event.message === "string" && event.message.includes("Device is not registered")) {
        defaults.registrationExists = false;
        viewState = "needs-registration";
      } else {
        viewState = defaults?.registrationExists ? "idle" : "needs-registration";
      }
      setMessage(typeof event.message === "string" ? event.message : "Operation failed");
      renderActionButton();
    } else if (event.event === "disconnected" || event.event === "agent-exit") {
      viewState = defaults?.registrationExists ? "idle" : "needs-registration";
      renderActionButton();
    } else if (event.event === "connecting") {
      viewState = "connecting";
      renderActionButton();
    } else if (event.event === "tunnel-stopped") {
      viewState = defaults?.registrationExists ? "idle" : "needs-registration";
      renderActionButton();
    }
  });
}
