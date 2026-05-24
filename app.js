"use strict";

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  code: "--- ---",
  approved: false,
  joinRequested: false,
  revoked: false,
  serverBacked: false,
  targetFps: 30,
  permissions: { screen: true, mouse: false, keyboard: false, files: false },
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const sessionCode    = $("sessionCode");
const joinCode       = $("joinCode");
const connectionStatus = $("connectionStatus");
const remoteScreen   = $("remoteScreen");
const auditLog       = $("auditLog");
const permissionForm = $("permissionForm");
const viewScreenButton  = $("viewScreenButton");
const remoteVideo    = $("remoteVideo");
const remoteFrame    = $("remoteFrame");
const controlButtons = [...document.querySelectorAll(".tool")];
const keyboardButtons = [...document.querySelectorAll(".virtual-keyboard button")];
const textInput      = $("textInput");
const touchpad       = $("touchpad");
const leftClickButton = $("leftClickButton");
const rightClickButton = $("rightClickButton");
const leftClickPadButton = $("leftClickPadButton");
const rightClickPadButton = $("rightClickPadButton");
const fpsRange = $("fpsRange");
const fpsLabel = $("fpsLabel");

// ── WebSocket ─────────────────────────────────────────────────────────────────
let ws = null;
let wsReady = false;
let wsRole = "all";
let reconnectDelay = 1000;

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?role=${wsRole}`);

  ws.addEventListener("open", () => {
    wsReady = true;
    reconnectDelay = 1000;
  });

  ws.addEventListener("message", (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleWsMsg(msg);
  });

  ws.addEventListener("close", () => {
    wsReady = false;
    setTimeout(connectWS, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
  });

  ws.addEventListener("error", () => ws.close());
}

function wsSend(data) {
  if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function handleWsMsg(msg) {
  switch (msg.type) {
    case "init":
    case "session_update":
      applySession(msg.session);
      if (msg.status) applyStatus(msg.status);
      if (msg.rtc) pendingRtc = msg.rtc;
      if (peerConnection && msg.rtc) processPendingRtc(msg.rtc);
      break;

    case "fps_update":
      applyStatus({ targetFps: msg.fps });
      break;

    case "signal":
      pendingRtc = msg.rtc;
      if (peerConnection) processPendingRtc(msg.rtc);
      break;

    case "control":
      // Host agent receives this; browser side just acknowledges
      break;
  }
}

// ── REST helper ───────────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function renderIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function addAudit(title, detail) {
  const item = document.createElement("li");
  const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  item.innerHTML = `<strong>${title}</strong>${detail ? ` — ${detail}` : ""} <em>${t}</em>`;
  auditLog.prepend(item);
  // Trim to last 60 entries
  while (auditLog.children.length > 60) auditLog.removeChild(auditLog.lastChild);
}

function setStatus(kind, label, icon) {
  connectionStatus.className = `status-pill ${kind}`.trim();
  connectionStatus.innerHTML = `<i data-lucide="${icon}"></i><span>${label}</span>`;
  renderIcons();
}

function readPermissions() {
  const fd = new FormData(permissionForm);
  state.permissions = {
    screen:   fd.has("screen"),
    mouse:    fd.has("mouse"),
    keyboard: fd.has("keyboard"),
    files:    fd.has("files"),
  };
}

function applySession(session) {
  if (!session) return;
  state.code          = session.code        || state.code;
  state.approved      = Boolean(session.approved);
  state.joinRequested = Boolean(session.joinRequested);
  state.revoked       = Boolean(session.revoked);
  state.permissions   = { ...state.permissions, ...(session.permissions || {}) };

  sessionCode.textContent = state.code;
  if (document.activeElement !== joinCode) joinCode.value = state.code;

  if (state.approved || state.revoked) {
    Object.entries(state.permissions).forEach(([name, enabled]) => {
      const inp = permissionForm.querySelector(`[name="${name}"]`);
      if (inp) inp.checked = enabled;
    });
  }

  if (state.approved) {
    setStatus("connected", "Session approved", "radio-tower");
    if (state.permissions.screen && !framePollTimer) startFrameViewer(false);
  } else if (state.joinRequested) {
    setStatus("pending", "Mobile waiting", "badge-check");
  } else if (state.revoked) {
    setStatus("revoked", "Access revoked", "octagon-x");
  } else {
    setStatus("", "Waiting for consent", "shield-check");
  }

  updateControls();
}

function applyStatus(status) {
  if (!status) return;
  state.targetFps = Number(status.targetFps || state.targetFps || 30);
  if (fpsRange) fpsRange.value = String(state.targetFps);
  if (fpsLabel) fpsLabel.textContent = String(state.targetFps);
}

function updateControls() {
  remoteScreen.classList.toggle("connected", state.approved && state.permissions.screen);

  controlButtons.forEach((btn) => {
    const action = btn.dataset.action;
    const allowed = action === "call" || Boolean(state.permissions[action]);
    btn.disabled = !state.approved || !allowed;
    btn.classList.toggle("allowed", state.approved && allowed);
  });

  keyboardButtons.forEach((btn) => {
    btn.disabled = !state.approved || !state.permissions.keyboard;
  });
  if (textInput) textInput.disabled = !state.approved || !state.permissions.keyboard;
  [leftClickPadButton, rightClickPadButton].forEach((btn) => {
    if (btn) btn.disabled = !state.approved || !state.permissions.mouse;
  });

  viewScreenButton.disabled  = !state.approved || !state.permissions.screen;
}

// ── Control delivery ──────────────────────────────────────────────────────────
async function sendControl(command) {
  if (!state.approved) return;

  // WebSocket path (fastest — skips HTTP overhead)
  const sent = wsSend({ type: "control", code: state.code, command });
  if (sent) return;

  // HTTP fallback
  try {
    await api("/api/control", {
      method: "POST",
      body: JSON.stringify({ code: state.code, ...command }),
    });
  } catch (err) {
    addAudit("Control failed", err.message);
  }
}

// ── Session buttons ───────────────────────────────────────────────────────────
$("newCodeButton").addEventListener("click", async () => {
  try {
    const d = await api("/api/session/new", { method: "POST", body: "{}" });
    applySession(d.session);
    stopFrameTimers();
    closePeerConnection();
    remoteFrame.removeAttribute("src");
    remoteScreen.classList.remove("live", "frame-live");
    addAudit("New code", "Previous session invalidated");
  } catch (err) { addAudit("Error", err.message); }
});

$("joinButton").addEventListener("click", async () => {
  try {
    const d = await api("/api/session/join", {
      method: "POST",
      body: JSON.stringify({ code: joinCode.value }),
    });
    applySession(d.session);
    addAudit("Join request sent", "Awaiting host approval");
  } catch (err) {
    state.approved = false;
    setStatus("revoked", "Code rejected", "triangle-alert");
    updateControls();
    addAudit("Denied", err.message);
  }
});

$("approveButton").addEventListener("click", async () => {
  readPermissions();
  try {
    const d = await api("/api/session/approve", {
      method: "POST",
      body: JSON.stringify({ permissions: state.permissions }),
    });
    applySession(d.session);
    const allowed = Object.entries(state.permissions).filter(([, v]) => v).map(([k]) => k).join(", ");
    addAudit("Session approved", `Permissions: ${allowed || "none"}`);
  } catch (err) { addAudit("Approve failed", err.message); }
});

$("revokeButton").addEventListener("click", async () => {
  try {
    const d = await api("/api/session/revoke", { method: "POST", body: "{}" });
    applySession(d.session);
    stopFrameTimers();
    closePeerConnection();
    remoteFrame.removeAttribute("src");
    remoteScreen.classList.remove("live", "frame-live");
    addAudit("Access revoked", "Session ended");
  } catch (err) { addAudit("Revoke failed", err.message); }
});

permissionForm.addEventListener("change", async () => {
  readPermissions();
  updateControls();
  if (state.approved) {
    try {
      await api("/api/session/approve", {
        method: "POST",
        body: JSON.stringify({ permissions: state.permissions }),
      });
    } catch {}
  }
  const active = Object.entries(state.permissions).filter(([,v]) => v).map(([k]) => k).join(", ");
  addAudit("Permissions", active || "none");
});

let fpsTimer = null;
fpsRange?.addEventListener("input", () => {
  const fps = Number(fpsRange.value || 30);
  state.targetFps = fps;
  if (fpsLabel) fpsLabel.textContent = String(fps);
  clearTimeout(fpsTimer);
  fpsTimer = setTimeout(() => wsSend({ type: "set_fps", fps }), 250);
});

// ── Tool buttons ──────────────────────────────────────────────────────────────
controlButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.id === "viewScreenButton") return;
    const action = btn.dataset.action;
    if (btn.id === "leftClickButton") {
      sendControl({ type: "leftClick" });
      addAudit("Left click", "Sent to host agent");
      return;
    }
    if (btn.id === "rightClickButton") {
      sendControl({ type: "rightClick" });
      addAudit("Right click", "Sent to host agent");
      return;
    }
    if (action === "keyboard") {
      if (!state.approved || !state.permissions.keyboard) {
        addAudit("Blocked", "Keyboard input not approved");
        return;
      }
      textInput?.focus({ preventScroll: true });
    }
    if (btn.id === "mousePadButton") {
      touchpad?.classList.add("hint");
      setTimeout(() => touchpad?.classList.remove("hint"), 450);
    }
    const label = btn.querySelector("span")?.textContent || "";
    addAudit(`${label} control`, "Ready");
  });
});

keyboardButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (!state.permissions.keyboard) return;
    sendControl({ type: "key", key: btn.dataset.key });
    addAudit("Key", btn.dataset.key);
    textInput?.focus({ preventScroll: true });
  });
});

function sendMouseButton(button) {
  if (!state.approved || !state.permissions.mouse) {
    addAudit("Blocked", "Mouse control not approved");
    return;
  }
  sendControl({ type: button === "right" ? "rightClick" : "leftClick" });
  addAudit(button === "right" ? "Right click" : "Left click", "Sent to host agent");
}

leftClickPadButton?.addEventListener("click", () => sendMouseButton("left"));
rightClickPadButton?.addEventListener("click", () => sendMouseButton("right"));

if (textInput) {
  textInput.addEventListener("beforeinput", (e) => {
    if (!state.approved || !state.permissions.keyboard) return;
    if (e.inputType === "insertText" && e.data) {
      e.preventDefault();
      sendControl({ type: "text", text: e.data });
      textInput.value = "";
    }
  });

  textInput.addEventListener("input", () => {
    if (!state.approved || !state.permissions.keyboard || !textInput.value) return;
    sendControl({ type: "text", text: textInput.value });
    textInput.value = "";
  });

  textInput.addEventListener("keydown", (e) => {
    if (!state.approved || !state.permissions.keyboard) return;
    const keyMap = { Enter: "Enter", Backspace: "Backspace", Escape: "Esc", Tab: "Tab" };
    if (keyMap[e.key]) {
      e.preventDefault();
      sendControl({ type: "key", key: keyMap[e.key] });
      textInput.value = "";
    }
  });
}

// ── Touchpad ──────────────────────────────────────────────────────────────────
let touchpadPointerId = null;
let touchpadLast = null;
let touchpadLastSent = 0;
let touchpadMoved = false;

function canUseTouchpad() {
  if (!state.approved || !state.permissions.mouse) {
    addAudit("Blocked", "Mouse control not approved");
    return false;
  }
  return true;
}

touchpad.addEventListener("pointerdown", (e) => {
  if (!canUseTouchpad()) return;
  e.preventDefault();
  touchpadPointerId = e.pointerId;
  touchpadLast = { x: e.clientX, y: e.clientY };
  touchpadMoved = false;
  touchpad.classList.add("active");
  touchpad.setPointerCapture(e.pointerId);
});

touchpad.addEventListener("pointermove", (e) => {
  if (touchpadPointerId !== e.pointerId || !touchpadLast) return;
  e.preventDefault();
  const now = Date.now();
  const dx = e.clientX - touchpadLast.x;
  const dy = e.clientY - touchpadLast.y;
  touchpadLast = { x: e.clientX, y: e.clientY };
  if (Math.abs(dx) + Math.abs(dy) < 1 || now - touchpadLastSent < 24) return;
  touchpadMoved = true;
  touchpadLastSent = now;
  sendControl({ type: "mouseDelta", dx, dy });
});

touchpad.addEventListener("pointerup", (e) => {
  if (touchpadPointerId !== e.pointerId) return;
  e.preventDefault();
  touchpad.releasePointerCapture?.(e.pointerId);
  touchpad.classList.remove("active");
  touchpadPointerId = null;
  touchpadLast = null;
});

touchpad.addEventListener("pointercancel", () => {
  touchpad.classList.remove("active");
  touchpadPointerId = null;
  touchpadLast = null;
});

// ── Fullscreen ────────────────────────────────────────────────────────────────
function setViewerFocus(enabled) {
  document.body.classList.toggle("viewer-focus", enabled);
  $("fullscreenButton").innerHTML = enabled
    ? '<i data-lucide="minimize"></i> Exit full screen'
    : '<i data-lucide="maximize"></i> Full screen';
  renderIcons();
  if (enabled) {
    document.activeElement?.blur?.();
    screen.orientation?.lock?.("landscape").catch(() => {});
  } else {
    screen.orientation?.unlock?.();
  }
}

$("fullscreenButton").addEventListener("click", () => {
  setViewerFocus(!document.body.classList.contains("viewer-focus"));
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("viewer-focus")) {
    setViewerFocus(false);
  }
});

// ── Remote screen pointer events ──────────────────────────────────────────────
let activePointerId = null;
let lastMoveSent = 0;
let latestScreenSize = { width: 0, height: 0 };

function pointerToRemote(e) {
  if (!state.approved || !state.permissions.mouse) return null;
  if (!remoteScreen.classList.contains("frame-live") && !remoteScreen.classList.contains("live")) return null;

  const target = remoteFrame.getAttribute("src") ? remoteFrame : remoteScreen;
  const rect = target.getBoundingClientRect();
  let aL = rect.left, aT = rect.top, aW = rect.width, aH = rect.height;

  if (latestScreenSize.width > 0 && latestScreenSize.height > 0) {
    const ir = latestScreenSize.width / latestScreenSize.height;
    const br = rect.width / rect.height;
    if (br > ir) {
      aH = rect.height; aW = aH * ir; aL = rect.left + (rect.width - aW) / 2;
    } else {
      aW = rect.width; aH = aW / ir; aT = rect.top + (rect.height - aH) / 2;
    }
  }

  const x = (e.clientX - aL) / aW;
  const y = (e.clientY - aT) / aH;
  return (x < 0 || x > 1 || y < 0 || y > 1) ? null : { x, y };
}

remoteScreen.addEventListener("pointerdown", (e) => {
  const p = pointerToRemote(e);
  if (!p) return;
  e.preventDefault();
  activePointerId = e.pointerId;
  remoteScreen.setPointerCapture?.(e.pointerId);
  sendControl({ type: "mouseDown", ...p });
});

remoteScreen.addEventListener("pointermove", (e) => {
  if (activePointerId !== e.pointerId) return;
  const now = Date.now();
  if (now - lastMoveSent < 28) return; // ~35fps max for mouse moves
  const p = pointerToRemote(e);
  if (!p) return;
  e.preventDefault();
  lastMoveSent = now;
  sendControl({ type: "mouseMove", ...p });
});

remoteScreen.addEventListener("pointerup", (e) => {
  if (activePointerId !== e.pointerId) return;
  const p = pointerToRemote(e);
  activePointerId = null;
  remoteScreen.releasePointerCapture?.(e.pointerId);
  if (!p) return;
  e.preventDefault();
  sendControl({ type: "mouseUp", ...p });
});

remoteScreen.addEventListener("pointercancel", (e) => {
  if (activePointerId === e.pointerId) activePointerId = null;
});

remoteScreen.addEventListener("wheel", (e) => {
  const p = pointerToRemote(e);
  if (!p) return;
  e.preventDefault();
  sendControl({ type: "scroll", deltaY: Math.max(-600, Math.min(600, e.deltaY)), ...p });
}, { passive: false });

// ── WebRTC ────────────────────────────────────────────────────────────────────
let peerConnection   = null;
let signalPollTimer  = null;
let pendingRtc       = null;
let hostCandCount    = 0;
let viewerCandCount  = 0;

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

async function processPendingRtc(rtc) {
  if (!peerConnection || !rtc) return;
  try {
    if (rtc.answer && !peerConnection.currentRemoteDescription) {
      await peerConnection.setRemoteDescription(rtc.answer);
      addAudit("Viewer connected", "Mobile is now receiving screen");
    }
    const hc = rtc.hostCandidates || [];
    for (let i = hostCandCount; i < hc.length; i++) {
      if (hc[i]) await peerConnection.addIceCandidate(hc[i]).catch(() => {});
    }
    hostCandCount = hc.length;
    const vc = rtc.viewerCandidates || [];
    for (let i = viewerCandCount; i < vc.length; i++) {
      if (vc[i]) await peerConnection.addIceCandidate(vc[i]).catch(() => {});
    }
    viewerCandCount = vc.length;
  } catch {}
}

async function sendSignal(role, type, value) {
  // WebSocket is fastest
  if (wsSend({ type: "signal", role, sigType: type, value })) return;
  // REST fallback
  await api("/api/session/signal", {
    method: "POST",
    body: JSON.stringify({ role, type, value }),
  });
}

function closePeerConnection() {
  if (signalPollTimer) { clearInterval(signalPollTimer); signalPollTimer = null; }
  if (peerConnection)  { peerConnection.close(); peerConnection = null; }
  hostCandCount = 0; viewerCandCount = 0;
}

// ── Frame relay (host → server) ───────────────────────────────────────────────
let frameRelayTimer  = null;
let framePollTimer   = null;
let frameStreamStarted = false;

function stopFrameTimers() {
  if (frameRelayTimer) { clearInterval(frameRelayTimer); frameRelayTimer = null; }
  if (framePollTimer)  { clearInterval(framePollTimer);  framePollTimer  = null; }
  frameStreamStarted = false;
}

function startFrameRelay(stream) {
  const vid  = document.createElement("video");
  const cvs  = document.createElement("canvas");
  const ctx  = cvs.getContext("2d", { alpha: false });
  let quality = 0.62;
  let lastSendMs = 0;

  vid.srcObject = stream;
  vid.muted = true;
  vid.playsInline = true;
  vid.play().catch(() => {});

  frameRelayTimer = setInterval(async () => {
    if (!vid.videoWidth || !vid.videoHeight) return;
    const now = Date.now();
    // Adaptive frame rate: skip if previous upload still slow
    if (now - lastSendMs < 80) return;

    const maxW = 1280;
    const scale = Math.min(1, maxW / vid.videoWidth);
    cvs.width  = Math.round(vid.videoWidth * scale);
    cvs.height = Math.round(vid.videoHeight * scale);
    ctx.drawImage(vid, 0, 0, cvs.width, cvs.height);

    const t0  = performance.now();
    const img = cvs.toDataURL("image/jpeg", quality);
    try {
      await api("/api/screen/frame", {
        method: "POST",
        body: JSON.stringify({ code: state.code, image: img, width: cvs.width, height: cvs.height }),
      });
      const dt = performance.now() - t0;
      // Adaptive quality: speed up on fast link, throttle on slow
      if (dt < 80)       quality = Math.min(0.78, quality + 0.02);
      else if (dt > 250) quality = Math.max(0.32, quality - 0.05);
      lastSendMs = Date.now();
    } catch (err) {
      addAudit("Frame relay failed", err.message);
    }
  }, 50); // poll at 20fps, actual sends adapt
}

function startFrameStream() {
  if (frameStreamStarted) return;
  remoteFrame.src = `/api/screen/stream?code=${encodeURIComponent(state.code)}&t=${Date.now()}`;
  remoteScreen.classList.add("frame-live");
  frameStreamStarted = true;
}

async function updateFrameMeta(log = true) {
  try {
    const d = await api("/api/screen");
    const scr = d.screen || {};
    if (scr.active) {
      latestScreenSize = { width: Number(scr.width || 0), height: Number(scr.height || 0) };
      return true;
    }
    if (log) addAudit("Preview waiting", "No frames from host yet");
  } catch {}
  return false;
}

function startFrameViewer(log = true) {
  if (framePollTimer) return;
  startFrameStream();
  updateFrameMeta(log);
  framePollTimer = setInterval(() => updateFrameMeta(false), 1500);
}

// ── Screen share (host side) ──────────────────────────────────────────────────
async function startHostScreenShare() {
  if (!state.approved || !state.permissions.screen) {
    addAudit("Blocked", "Screen sharing not approved");
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    addAudit("Unavailable", "Browser doesn't support screen capture");
    return;
  }

  closePeerConnection();
  stopFrameTimers();

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, frameRate: { ideal: 30 }, cursor: "always" },
      audio: false,
    });

    remoteVideo.srcObject = stream;
    remoteScreen.classList.add("live");
    startFrameRelay(stream); // MJPEG relay as fallback path

    peerConnection = new RTCPeerConnection(rtcConfig);
    stream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, stream);
      track.addEventListener("ended", () => {
        closePeerConnection();
        stopFrameTimers();
        api("/api/screen/stop", { method: "POST", body: "{}" }).catch(() => {});
        remoteVideo.srcObject = null;
        remoteFrame.removeAttribute("src");
        remoteScreen.classList.remove("live", "frame-live");
        addAudit("Screen share stopped", "");
      });
    });

    peerConnection.onicecandidate = (e) => {
      if (e.candidate) sendSignal("host", "candidate", e.candidate.toJSON());
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await sendSignal("host", "offer", offer);
    addAudit("Screen share started", "Tap View Live on mobile");

    // Fallback poll for signals (WebSocket handles most of them)
    signalPollTimer = setInterval(async () => {
      try {
        const d = await api("/api/session/signal");
        await processPendingRtc(d.rtc || {});
      } catch {}
    }, 3000);

  } catch (err) {
    addAudit("Share cancelled", err.message);
  }
}

// ── Screen viewer (mobile side) ───────────────────────────────────────────────
async function startViewerScreen() {
  if (!state.approved || !state.permissions.screen) {
    addAudit("Blocked", "Screen sharing not approved");
    return;
  }

  closePeerConnection();
  startFrameViewer();

  try {
    const d   = await api("/api/session/signal");
    const rtc = d.rtc || {};

    if (!rtc.offer) {
      addAudit("Preview active", "MJPEG stream running — WebRTC offer pending");
      return;
    }

    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.ontrack = (e) => {
      const [stream] = e.streams;
      remoteVideo.srcObject = stream;
      remoteVideo.muted = false;
      remoteScreen.classList.add("live");
      addAudit("Live stream", "Receiving host screen via WebRTC");
    };

    peerConnection.onicecandidate = (e) => {
      if (e.candidate) sendSignal("viewer", "candidate", e.candidate.toJSON());
    };

    await peerConnection.setRemoteDescription(rtc.offer);
    await processPendingRtc(rtc);

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await sendSignal("viewer", "answer", answer);
    addAudit("Viewer started", "Connecting to host stream");

    signalPollTimer = setInterval(async () => {
      try {
        const latest = await api("/api/session/signal");
        await processPendingRtc(latest.rtc || {});
      } catch {}
    }, 3000);

  } catch (err) {
    addAudit("Viewer failed", err.message);
  }
}

viewScreenButton.addEventListener("click", () => {
  wsRole = "viewer";
  startViewerScreen();
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async function init() {
  updateControls();
  connectWS();

  // Initial session load via REST (in case WS init hasn't arrived yet)
  try {
    const d = await api("/api/session");
    state.serverBacked = true;
    applySession(d.session);
  } catch {}

  addAudit("RemoteDesk ready", "One-time code created");
})();

// Fallback REST poll — only runs if WebSocket is down
setInterval(async () => {
  if (wsReady) return;
  try {
    const d = await api("/api/session");
    applySession(d.session);
  } catch {}
}, 4000);

window.addEventListener("load", renderIcons);
