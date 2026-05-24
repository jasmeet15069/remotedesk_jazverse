const state = {
  code: "739 184",
  approved: false,
  joinRequested: false,
  revoked: false,
  serverBacked: false,
  permissions: {
    screen: true,
    mouse: false,
    keyboard: false,
    files: false,
    ai: false,
  },
};

const sessionCode = document.querySelector("#sessionCode");
const joinCode = document.querySelector("#joinCode");
const connectionStatus = document.querySelector("#connectionStatus");
const remoteScreen = document.querySelector("#remoteScreen");
const auditLog = document.querySelector("#auditLog");
const permissionForm = document.querySelector("#permissionForm");
const controlButtons = [...document.querySelectorAll(".tool")];
const keyboardButtons = [...document.querySelectorAll(".virtual-keyboard button")];
const touchpad = document.querySelector("#touchpad");
const aiPrompt = document.querySelector("#aiPrompt");
const aiButton = document.querySelector("#aiButton");
let lastServerStatus = "";

function renderIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function addAudit(title, detail) {
  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  item.innerHTML = `<strong>${title}</strong>${detail} - ${time}`;
  auditLog.prepend(item);
}

function setStatus(kind, label, icon) {
  connectionStatus.className = `status-pill ${kind}`;
  connectionStatus.innerHTML = `<i data-lucide="${icon}"></i><span>${label}</span>`;
  renderIcons();
}

function readPermissions() {
  const data = new FormData(permissionForm);
  state.permissions = {
    screen: data.has("screen"),
    mouse: data.has("mouse"),
    keyboard: data.has("keyboard"),
    files: data.has("files"),
    ai: data.has("ai"),
  };
}

function applySession(session) {
  state.code = session.code || state.code;
  state.approved = Boolean(session.approved);
  state.joinRequested = Boolean(session.joinRequested);
  state.revoked = Boolean(session.revoked);
  state.permissions = { ...state.permissions, ...(session.permissions || {}) };

  sessionCode.textContent = state.code;
  if (!joinCode.value || joinCode.value === "739 184") {
    joinCode.value = state.code;
  }

  if (state.approved || state.revoked) {
    Object.entries(state.permissions).forEach(([name, enabled]) => {
      const input = permissionForm.querySelector(`[name="${name}"]`);
      if (input) {
        input.checked = enabled;
      }
    });
  }

  if (state.approved) {
    setStatus("connected", "Session approved", "radio-tower");
  } else if (state.joinRequested) {
    setStatus("", "Mobile waiting", "badge-check");
  } else if (state.revoked) {
    setStatus("revoked", "Access revoked", "octagon-x");
  } else {
    setStatus("", "Waiting for consent", "shield-check");
  }

  updateControls();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

async function refreshSession() {
  try {
    const data = await api("/api/session");
    state.serverBacked = true;
    applySession(data.session);

    const status = JSON.stringify({
      approved: state.approved,
      joinRequested: state.joinRequested,
      revoked: state.revoked,
      code: state.code,
    });
    if (status !== lastServerStatus) {
      lastServerStatus = status;
      if (state.joinRequested && !state.approved) {
        addAudit("Mobile join request", "Approve the session on the computer");
      }
      if (state.approved) {
        addAudit("Session synced", "Mobile and computer are connected through the server");
      }
    }
  } catch (error) {
    state.serverBacked = false;
  }
}

function updateControls() {
  remoteScreen.classList.toggle("connected", state.approved && state.permissions.screen);

  controlButtons.forEach((button) => {
    const action = button.dataset.action;
    const allowed = action === "call" || Boolean(state.permissions[action]);
    button.disabled = !state.approved || !allowed;
    button.classList.toggle("allowed", state.approved && allowed);
  });

  keyboardButtons.forEach((button) => {
    button.disabled = !state.approved || !state.permissions.keyboard;
  });

  aiPrompt.disabled = !state.approved || !state.permissions.ai;
  aiButton.disabled = !state.approved || !state.permissions.ai;
}

async function generateCode() {
  if (state.serverBacked) {
    try {
      const data = await api("/api/session/new", { method: "POST", body: "{}" });
      applySession(data.session);
      addAudit("New code generated", "Server session reset for mobile connection");
      return;
    } catch (error) {
      addAudit("Server sync failed", error.message);
    }
  }

  const digits = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join("");
  state.code = `${digits.slice(0, 3)} ${digits.slice(3)}`;
  state.approved = false;
  sessionCode.textContent = state.code;
  joinCode.value = "";
  setStatus("", "Waiting for consent", "shield-check");
  updateControls();
  addAudit("New code generated", "Previous session invalidated");
}

document.querySelector("#newCodeButton").addEventListener("click", generateCode);

document.querySelector("#joinButton").addEventListener("click", async () => {
  const normalizedInput = joinCode.value.replace(/\s/g, "");
  const normalizedCode = state.code.replace(/\s/g, "");

  if (state.serverBacked) {
    try {
      const data = await api("/api/session/join", {
        method: "POST",
        body: JSON.stringify({ code: joinCode.value }),
      });
      applySession(data.session);
      addAudit("Join request sent", "Approve the session on the computer");
      return;
    } catch (error) {
      state.approved = false;
      setStatus("revoked", "Code rejected", "triangle-alert");
      updateControls();
      addAudit("Connection denied", error.message);
      return;
    }
  }

  if (normalizedInput !== normalizedCode) {
    state.approved = false;
    setStatus("revoked", "Code rejected", "triangle-alert");
    updateControls();
    addAudit("Connection denied", "The entered one-time code did not match");
    return;
  }

  setStatus("", "Code verified", "badge-check");
  addAudit("Join request received", "Computer approval is still required");
});

document.querySelector("#approveButton").addEventListener("click", async () => {
  readPermissions();

  if (state.serverBacked) {
    try {
      const data = await api("/api/session/approve", {
        method: "POST",
        body: JSON.stringify({ permissions: state.permissions }),
      });
      applySession(data.session);
      const allowed = Object.entries(state.permissions)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
        .join(", ");
      addAudit("Session approved", `Allowed permissions: ${allowed || "none"}`);
      return;
    } catch (error) {
      addAudit("Approval failed", error.message);
    }
  }

  state.approved = true;
  setStatus("connected", "Session approved", "radio-tower");
  updateControls();
  const allowed = Object.entries(state.permissions)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(", ");
  addAudit("Session approved", `Allowed permissions: ${allowed || "none"}`);
});

document.querySelector("#revokeButton").addEventListener("click", async () => {
  if (state.serverBacked) {
    try {
      const data = await api("/api/session/revoke", { method: "POST", body: "{}" });
      applySession(data.session);
      addAudit("Access revoked", "The computer ended the remote session");
      return;
    } catch (error) {
      addAudit("Revoke failed", error.message);
    }
  }

  state.approved = false;
  setStatus("revoked", "Access revoked", "octagon-x");
  updateControls();
  addAudit("Access revoked", "The computer ended the remote session");
});

permissionForm.addEventListener("change", () => {
  readPermissions();
  updateControls();
  addAudit("Permissions updated", "The computer changed what the helper can do");
});

controlButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const label = button.textContent.trim();
    addAudit(`${label} control used`, "Action queued for the approved host agent");
  });
});

keyboardButtons.forEach((button) => {
  button.addEventListener("click", () => {
    addAudit("Keyboard input queued", `${button.dataset.key} sent to approved host agent`);
  });
});

touchpad.addEventListener("pointerdown", (event) => {
  if (!state.approved || !state.permissions.mouse) {
    addAudit("Touch blocked", "Mouse control is not approved by the computer");
    return;
  }

  touchpad.classList.add("active");
  touchpad.setPointerCapture(event.pointerId);
  addAudit("Touch control started", `Pointer at ${Math.round(event.offsetX)}, ${Math.round(event.offsetY)}`);
});

touchpad.addEventListener("pointerup", () => {
  touchpad.classList.remove("active");
});

document.querySelector("#fullscreenButton").addEventListener("click", async () => {
  if (!remoteScreen.requestFullscreen) {
    addAudit("Full screen unavailable", "This browser does not expose full screen mode");
    return;
  }

  await remoteScreen.requestFullscreen();
  addAudit("Full screen opened", "Remote viewer expanded on this device");
});

aiButton.addEventListener("click", async () => {
  const prompt = aiPrompt.value.trim();
  if (!prompt) {
    addAudit("AI assist blocked", "Enter a request before queueing assistance");
    return;
  }

  aiButton.disabled = true;
  addAudit("AI assist queued", "Sending request to Groq Llama 70B");

  try {
    const response = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "AI request failed");
    }

    addAudit("AI assist response", data.message || "No response returned");
    aiPrompt.value = "";
  } catch (error) {
    addAudit("AI assist failed", error.message);
  } finally {
    updateControls();
  }
});

joinCode.value = state.code;
updateControls();
addAudit("Agent ready", "One-time code created on the computer");
refreshSession();
setInterval(refreshSession, 2000);

window.addEventListener("load", renderIcons);
