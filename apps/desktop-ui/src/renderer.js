const elements = {
  manifestPath: document.getElementById("manifestPath"),
  identityPath: document.getElementById("identityPath"),
  serverId: document.getElementById("serverId"),
  status: document.getElementById("status"),
  events: document.getElementById("events"),
  connectButton: document.getElementById("connectButton"),
  disconnectButton: document.getElementById("disconnectButton"),
  pickManifestButton: document.getElementById("pickManifestButton"),
  pickIdentityButton: document.getElementById("pickIdentityButton")
};

function appendEvent(event) {
  const item = document.createElement("li");
  item.className = "event-row";
  item.textContent = `[${new Date().toLocaleTimeString()}] ${event.event ?? "log"}: ${event.message ?? JSON.stringify(event)}`;
  elements.events.prepend(item);
}

function setStatus(text) {
  elements.status.textContent = text;
}

function reportUiError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus("Error");
  appendEvent({ event: "ui-error", message });
}

if (!window.desktopUi) {
  reportUiError(new Error("Electron preload bridge is unavailable."));
}

elements.pickManifestButton.addEventListener("click", async () => {
  try {
    const selected = await window.desktopUi.pickFile();
    if (selected) {
      elements.manifestPath.value = selected;
    }
  } catch (error) {
    reportUiError(error);
  }
});

elements.pickIdentityButton.addEventListener("click", async () => {
  try {
    const selected = await window.desktopUi.pickFile();
    if (selected) {
      elements.identityPath.value = selected;
    }
  } catch (error) {
    reportUiError(error);
  }
});

elements.connectButton.addEventListener("click", async () => {
  try {
    await window.desktopUi.connect({
      manifestPath: elements.manifestPath.value.trim(),
      identityPath: elements.identityPath.value.trim(),
      serverId: elements.serverId.value.trim() || undefined
    });

    setStatus("Connecting");
  } catch (error) {
    reportUiError(error);
  }
});

elements.disconnectButton.addEventListener("click", async () => {
  try {
    await window.desktopUi.disconnect();
    setStatus("Disconnected");
  } catch (error) {
    reportUiError(error);
  }
});

if (window.desktopUi) {
  window.desktopUi.onAgentEvent((event) => {
    appendEvent(event);

    if (event.event === "connected") {
      setStatus(`Connected via ${event.transport}`);
    } else if (event.event === "disconnected" || event.event === "agent-exit") {
      setStatus("Disconnected");
    } else if (event.event === "connecting") {
      setStatus("Connecting");
    } else if (event.event === "ui-error") {
      setStatus("Error");
    }
  });
}
