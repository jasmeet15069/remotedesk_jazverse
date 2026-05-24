#!/usr/bin/env python3
"""
RemoteDesk Server - production real-time remote desktop relay.

Install:  pip install aiohttp
Run:      python server.py
Nginx:    proxy_pass http://127.0.0.1:8020;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection "upgrade";
          proxy_set_header Host $host;
          proxy_buffering off;
          proxy_read_timeout 3600;
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import mimetypes
import os
import secrets
import time
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web


HOST = os.getenv("RD_HOST", os.getenv("REMOTEDESK_HOST", "127.0.0.1"))
PORT = int(os.getenv("RD_PORT", os.getenv("REMOTEDESK_PORT", "8020")))
MAX_VIEWERS = int(os.getenv("REMOTEDESK_MAX_VIEWERS", "4"))
CONTROL_QUEUE_MAX = 256
WS_HEARTBEAT = 20
DEFAULT_FPS = int(os.getenv("REMOTEDESK_FPS", "30"))
AUDIT_MAX = 500
STATIC_DIR = Path(__file__).parent

_started_at = time.time()
_state_lock = asyncio.Lock()
_audit_log: list[dict[str, Any]] = []


def audit(event: str, detail: dict[str, Any] | None = None) -> None:
    entry = {"ts": time.time(), "event": event, **(detail or {})}
    _audit_log.append(entry)
    if len(_audit_log) > AUDIT_MAX:
        del _audit_log[: len(_audit_log) - AUDIT_MAX]


def make_code() -> str:
    digits = "".join(str(secrets.randbelow(10)) for _ in range(6))
    return f"{digits[:3]} {digits[3:]}"


def new_session() -> dict[str, Any]:
    return {
        "code": make_code(),
        "approved": False,
        "revoked": False,
        "joinRequested": False,
        "permissions": {
            "screen": True,
            "mouse": False,
            "keyboard": False,
            "files": False,
        },
    }


_session = new_session()
_screen: dict[str, Any] = {
    "jpeg": None,
    "active": False,
    "width": 0,
    "height": 0,
    "updatedAt": 0,
}
_rtc: dict[str, Any] = {
    "offer": None,
    "answer": None,
    "hostCandidates": [],
    "viewerCandidates": [],
}
_target_fps = max(1, min(60, DEFAULT_FPS))
_control_queue: list[dict[str, Any]] = []
_ws_pools: dict[str, set[web.WebSocketResponse]] = {
    "host": set(),
    "viewer": set(),
    "all": set(),
}
_frame_event = asyncio.Event()


def code_ok(code: str) -> bool:
    expected = str(_session["code"]).replace(" ", "")
    provided = str(code).replace(" ", "")
    if len(expected) != len(provided):
        return False
    return hmac.compare_digest(expected.encode(), provided.encode())


def session_pub() -> dict[str, Any]:
    return dict(_session)


def screen_pub() -> dict[str, Any]:
    return {k: v for k, v in _screen.items() if k != "jpeg"}


def status_pub() -> dict[str, Any]:
    return {
        "uptime": round(time.time() - _started_at, 1),
        "viewers": len(_ws_pools["viewer"]),
        "maxViewers": MAX_VIEWERS,
        "hostOnline": bool(_ws_pools["host"]),
        "screenActive": bool(_screen["active"]),
        "targetFps": _target_fps,
        "auditEntries": len(_audit_log),
        "session": {
            "approved": _session["approved"],
            "revoked": _session["revoked"],
            "joinRequested": _session["joinRequested"],
            "permissions": dict(_session["permissions"]),
        },
    }


async def json_body(req: web.Request) -> dict[str, Any]:
    try:
        return await req.json()
    except Exception:
        return {}


async def broadcast(role: str, data: dict[str, Any]) -> None:
    msg = json.dumps(data, separators=(",", ":"))
    if role == "all":
        targets = set().union(*_ws_pools.values())
    else:
        targets = set(_ws_pools.get(role, set())) | set(_ws_pools["all"])
    if not targets:
        return

    async def send(ws: web.WebSocketResponse) -> web.WebSocketResponse | None:
        try:
            await ws.send_str(msg)
            return None
        except Exception:
            return ws

    dead = {ws for ws in await asyncio.gather(*(send(ws) for ws in targets)) if ws}
    for pool in _ws_pools.values():
        pool.difference_update(dead)


async def broadcast_control(cmd: dict[str, Any]) -> None:
    await broadcast("host", {"type": "control", "command": cmd, "event": cmd})


def queue_control(cmd: dict[str, Any]) -> None:
    cmd.setdefault("id", int(time.time() * 1000))
    _control_queue.append(cmd)
    if len(_control_queue) > CONTROL_QUEUE_MAX:
        del _control_queue[: len(_control_queue) - CONTROL_QUEUE_MAX]


def control_allowed(cmd_type: str) -> bool:
    perms = _session["permissions"]
    mouse = {
        "mouseMove",
        "mouseDelta",
        "mousemove",
        "mouseDown",
        "mousedown",
        "mouseUp",
        "mouseup",
        "click",
        "leftClick",
        "rightClick",
        "scroll",
    }
    keyboard = {"key", "text", "keydown", "keyup", "keypress"}
    if cmd_type in mouse:
        return bool(perms.get("mouse"))
    if cmd_type in keyboard:
        return bool(perms.get("keyboard"))
    return False


def normalize_control(data: dict[str, Any]) -> dict[str, Any]:
    if isinstance(data.get("command"), dict):
        source = dict(data["command"])
        cmd_type = str(source.get("type", ""))
    else:
        source = dict(data)
        cmd_type = str(source.get("type") or source.get("eventType") or "")

    button = str(source.get("button", "")).lower()
    if cmd_type in {"mousemove", "mouseMove"} and ("dx" in source or "dy" in source):
        cmd_type = "mouseDelta"
    elif cmd_type == "mousemove":
        cmd_type = "mouseMove"
    elif cmd_type == "mousedown":
        cmd_type = "mouseDown"
    elif cmd_type == "mouseup":
        cmd_type = "mouseUp"
    elif cmd_type == "click" and button == "right":
        cmd_type = "rightClick"
    elif cmd_type == "click":
        cmd_type = "leftClick"
    elif cmd_type == "keypress" and "text" in source:
        cmd_type = "text"
    elif cmd_type in {"keydown", "keyup"}:
        cmd_type = "key"

    cmd: dict[str, Any] = {"type": cmd_type}
    for key in ("x", "y", "dx", "dy", "deltaY", "key", "text", "button"):
        if key in source:
            cmd[key] = source[key]
    return cmd


async def reset_session() -> dict[str, Any]:
    async with _state_lock:
        _session.clear()
        _session.update(new_session())
        _screen.update({"jpeg": None, "active": False, "width": 0, "height": 0, "updatedAt": 0})
        _rtc.update({"offer": None, "answer": None, "hostCandidates": [], "viewerCandidates": []})
        _control_queue.clear()
        session = session_pub()
    audit("session_reset")
    await broadcast("all", {"type": "session_reset", "session": session})
    return session


async def api_status(_req: web.Request) -> web.Response:
    return web.json_response(status_pub())


async def api_audit(req: web.Request) -> web.Response:
    limit = min(max(int(req.query.get("limit", "100")), 1), AUDIT_MAX)
    return web.json_response({"log": _audit_log[-limit:]})


async def api_reset(_req: web.Request) -> web.Response:
    session = await reset_session()
    return web.json_response({"ok": True, "code": session["code"], "session": session})


async def r_session_get(_req: web.Request) -> web.Response:
    return web.json_response({"session": session_pub(), "status": status_pub()})


async def r_session_new(_req: web.Request) -> web.Response:
    session = await reset_session()
    return web.json_response({"session": session})


async def r_session_join(req: web.Request) -> web.Response:
    body = await json_body(req)
    if not code_ok(body.get("code", "")):
        audit("bad_code_attempt", {"remote": str(req.remote)})
        return web.json_response({"error": "Code rejected", "session": session_pub()}, status=403)
    async with _state_lock:
        _session.update({"joinRequested": True, "revoked": False})
        session = session_pub()
    audit("join_requested", {"remote": str(req.remote)})
    await broadcast("host", {"type": "join_request", "session": session})
    await broadcast("all", {"type": "session_update", "session": session})
    return web.json_response({"session": session})


async def r_session_approve(req: web.Request) -> web.Response:
    body = await json_body(req)
    async with _state_lock:
        perms = dict(_session["permissions"])
        perms.update({k: bool(v) for k, v in body.get("permissions", {}).items()})
        _session.update({"approved": True, "revoked": False, "permissions": perms})
        session = session_pub()
    audit("session_approved", {"permissions": dict(session["permissions"])})
    await broadcast("all", {"type": "session_update", "session": session})
    return web.json_response({"session": session})


async def r_session_revoke(_req: web.Request) -> web.Response:
    async with _state_lock:
        _session.update({"approved": False, "revoked": True})
        _screen.update({"active": False, "jpeg": None})
        session = session_pub()
    audit("session_revoked")
    await broadcast("all", {"type": "session_update", "session": session})
    return web.json_response({"session": session})


async def r_screen_meta(_req: web.Request) -> web.Response:
    return web.json_response({"screen": screen_pub()})


async def r_screen_frame(req: web.Request) -> web.Response:
    body = await json_body(req)
    if not code_ok(body.get("code", "")):
        return web.json_response({"error": "Wrong code"}, status=403)
    if not _session.get("approved") or _session.get("revoked"):
        return web.json_response({"error": "Not approved"}, status=403)
    if not _session["permissions"].get("screen"):
        return web.json_response({"error": "No screen perm"}, status=403)

    img = str(body.get("image", ""))
    if img.startswith("data:image/jpeg;base64,"):
        payload = img.split(",", 1)[1]
    elif "jpeg" in body:
        payload = str(body["jpeg"])
    else:
        return web.json_response({"error": "JPEG data required"}, status=400)

    try:
        jpeg = base64.b64decode(payload, validate=False)
    except Exception:
        return web.json_response({"error": "Bad JPEG data"}, status=400)

    ts = int(time.time() * 1000)
    async with _state_lock:
        _screen.update({
            "jpeg": jpeg,
            "active": True,
            "width": int(body.get("width", 0) or 0),
            "height": int(body.get("height", 0) or 0),
            "updatedAt": ts,
        })
    _frame_event.set()
    await broadcast("viewer", {"type": "screen_update", "screen": screen_pub()})
    return web.json_response({"ok": True, "updatedAt": ts})


async def r_screen_stop(_req: web.Request) -> web.Response:
    async with _state_lock:
        _screen.update({"active": False, "jpeg": None})
    await broadcast("viewer", {"type": "screen_update", "screen": screen_pub()})
    return web.json_response({"ok": True})


async def r_screen_stream(req: web.Request) -> web.StreamResponse:
    code = req.query.get("code", "")
    if code and not code_ok(code):
        raise web.HTTPForbidden(reason="Wrong code")
    if not _session.get("approved") or _session.get("revoked"):
        raise web.HTTPForbidden(reason="Not approved")

    resp = web.StreamResponse(headers={
        "Content-Type": "multipart/x-mixed-replace; boundary=remotedesk",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
    })
    await resp.prepare(req)
    audit("mjpeg_started", {"remote": str(req.remote)})

    last_ts = None
    try:
        while True:
            scr = _screen
            if scr.get("active") and scr.get("jpeg") and scr.get("updatedAt") != last_ts:
                jpeg = scr["jpeg"]
                last_ts = scr["updatedAt"]
                header = (
                    "--remotedesk\r\n"
                    "Content-Type: image/jpeg\r\n"
                    f"Content-Length: {len(jpeg)}\r\n\r\n"
                ).encode()
                await resp.write(header + jpeg + b"\r\n")
                await asyncio.sleep(1 / max(1, _target_fps))
                continue

            _frame_event.clear()
            try:
                await asyncio.wait_for(_frame_event.wait(), timeout=10)
            except asyncio.TimeoutError:
                await resp.write(b"--remotedesk\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n")
    except Exception:
        pass
    finally:
        audit("mjpeg_ended", {"remote": str(req.remote)})
    return resp


async def r_control(req: web.Request) -> web.Response:
    body = await json_body(req)
    if not code_ok(body.get("code", "")):
        return web.json_response({"error": "Wrong code"}, status=403)
    if not _session.get("approved") or _session.get("revoked"):
        return web.json_response({"error": "Not approved"}, status=403)

    cmd = normalize_control(body)
    if not control_allowed(cmd.get("type", "")):
        return web.json_response({"error": "Permission denied"}, status=403)

    queue_control(cmd)
    await broadcast_control(cmd)
    return web.json_response({"ok": True, "command": cmd})


async def r_control_poll(req: web.Request) -> web.Response:
    if not code_ok(req.query.get("code", "")):
        return web.json_response({"commands": []})
    cmds = list(_control_queue)
    _control_queue.clear()
    return web.json_response({"commands": cmds})


def apply_signal(role: str, sig_type: str, value: Any) -> None:
    if sig_type in {"offer", "rtc_offer"}:
        _rtc.update({"offer": value, "answer": None, "viewerCandidates": []})
    elif sig_type in {"answer", "rtc_answer"}:
        _rtc["answer"] = value
    elif sig_type in {"candidate", "rtc_candidate"}:
        key = "hostCandidates" if role == "host" else "viewerCandidates"
        _rtc.setdefault(key, []).append(value)


async def r_signal_get(_req: web.Request) -> web.Response:
    return web.json_response({"rtc": _rtc})


async def r_signal_post(req: web.Request) -> web.Response:
    body = await json_body(req)
    role = body.get("role", "host")
    sig_type = body.get("type") or body.get("sigType")
    value = body.get("value")
    async with _state_lock:
        apply_signal(role, sig_type, value)
        rtc = dict(_rtc)
    other = "viewer" if role == "host" else "host"
    await broadcast(other, {"type": "signal", "rtc": rtc})
    return web.json_response({"ok": True})


async def ws_handler(req: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=WS_HEARTBEAT, max_msg_size=50 * 1024 * 1024)
    await ws.prepare(req)

    role = req.query.get("role", "all")
    if role not in {"host", "viewer", "all"}:
        await ws.close(code=4000, message=b"invalid role")
        return ws
    if role == "viewer" and len(_ws_pools["viewer"]) >= MAX_VIEWERS:
        await ws.send_str(json.dumps({"type": "error", "msg": "server_full"}))
        await ws.close(code=4001, message=b"server full")
        audit("viewer_rejected", {"reason": "server_full"})
        return ws

    _ws_pools[role].add(ws)
    audit(f"{role}_connected", {"remote": str(req.remote)})
    await ws.send_str(json.dumps({
        "type": "init",
        "session": session_pub(),
        "screen": screen_pub(),
        "rtc": dict(_rtc),
        "status": status_pub(),
    }))

    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                break
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")
            if msg_type == "join":
                if not code_ok(data.get("code", "")):
                    await ws.send_str(json.dumps({"type": "error", "msg": "bad_code"}))
                    continue
                async with _state_lock:
                    _session.update({"joinRequested": True, "revoked": False})
                    session = session_pub()
                audit("join_requested", {"remote": str(req.remote)})
                await broadcast("host", {"type": "join_request", "session": session})
                await broadcast("all", {"type": "session_update", "session": session})
                await ws.send_str(json.dumps({"type": "join_pending"}))

            elif msg_type == "approve":
                async with _state_lock:
                    _session.update({"approved": True, "revoked": False})
                    session = session_pub()
                audit("session_approved")
                await broadcast("all", {"type": "session_update", "session": session})

            elif msg_type == "revoke":
                async with _state_lock:
                    _session.update({"approved": False, "revoked": True})
                    _screen.update({"active": False, "jpeg": None})
                    session = session_pub()
                audit("session_revoked")
                await broadcast("all", {"type": "session_update", "session": session})

            elif msg_type == "set_permissions":
                async with _state_lock:
                    for key, value in data.get("permissions", {}).items():
                        if key in _session["permissions"]:
                            _session["permissions"][key] = bool(value)
                    session = session_pub()
                audit("permissions_changed", {"permissions": dict(session["permissions"])})
                await broadcast("all", {"type": "session_update", "session": session})

            elif msg_type == "set_fps":
                global _target_fps
                _target_fps = max(1, min(60, int(data.get("fps", DEFAULT_FPS))))
                audit("fps_changed", {"fps": _target_fps})
                await broadcast("all", {"type": "fps_update", "fps": _target_fps})

            elif msg_type == "reset":
                await reset_session()

            elif msg_type == "frame":
                fake_req = req.clone()
                del fake_req
                body = {
                    "code": data.get("code", _session["code"]),
                    "jpeg": data.get("jpeg", ""),
                    "width": data.get("width", 0),
                    "height": data.get("height", 0),
                }
                if code_ok(body["code"]) and _session.get("approved"):
                    try:
                        jpeg = base64.b64decode(str(body["jpeg"]), validate=False)
                    except Exception:
                        continue
                    ts = int(time.time() * 1000)
                    async with _state_lock:
                        _screen.update({
                            "jpeg": jpeg,
                            "active": True,
                            "width": int(body["width"] or 0),
                            "height": int(body["height"] or 0),
                            "updatedAt": ts,
                        })
                    _frame_event.set()

            elif msg_type == "screen_inactive":
                async with _state_lock:
                    _screen.update({"active": False, "jpeg": None})
                await broadcast("viewer", {"type": "screen_update", "screen": screen_pub()})

            elif msg_type == "control":
                code = data.get("code", _session["code"] if role == "viewer" else "")
                if not code_ok(code) or not _session.get("approved") or _session.get("revoked"):
                    continue
                cmd = normalize_control(data)
                if control_allowed(cmd.get("type", "")):
                    queue_control(cmd)
                    await broadcast_control(cmd)

            elif msg_type == "signal":
                sig_role = data.get("role", role if role in {"host", "viewer"} else "host")
                sig_type = data.get("sigType") or data.get("type")
                value = data.get("value")
                async with _state_lock:
                    apply_signal(sig_role, sig_type, value)
                    rtc = dict(_rtc)
                other = "viewer" if sig_role == "host" else "host"
                await broadcast(other, {"type": "signal", "rtc": rtc})

            elif msg_type in {"rtc_offer", "rtc_answer", "rtc_candidate"}:
                sig_role = role if role in {"host", "viewer"} else data.get("role", "host")
                value = data.get("offer") or data.get("answer") or data.get("candidate")
                async with _state_lock:
                    apply_signal(sig_role, msg_type, value)
                    rtc = dict(_rtc)
                other = "viewer" if sig_role == "host" else "host"
                await broadcast(other, {"type": msg_type, **{msg_type.replace("rtc_", ""): value}, "rtc": rtc})
    finally:
        _ws_pools.get(role, set()).discard(ws)
        audit(f"{role}_disconnected", {"remote": str(req.remote)})
        if role == "host":
            async with _state_lock:
                _screen["active"] = False
            await broadcast("viewer", {"type": "host_disconnected"})
        elif role == "viewer":
            await broadcast("host", {"type": "viewer_left", "viewers": len(_ws_pools["viewer"])})

    return ws


STATIC_MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ps1": "text/plain; charset=utf-8",
    ".bat": "application/octet-stream",
}


async def r_index(_req: web.Request) -> web.FileResponse:
    return web.FileResponse(STATIC_DIR / "index.html")


async def r_static(req: web.Request) -> web.FileResponse:
    filename = req.match_info.get("filename", "")
    path = (STATIC_DIR / filename).resolve()
    try:
        path.relative_to(STATIC_DIR.resolve())
    except ValueError:
        raise web.HTTPForbidden()
    if not path.exists() or not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Content-Type": STATIC_MIME.get(path.suffix, mimetypes.guess_type(str(path))[0] or "application/octet-stream")})


async def on_startup(_app: web.Application) -> None:
    audit("server_started", {"port": PORT})
    print(f"RemoteDesk running -> http://{HOST}:{PORT} code={_session['code']}")


async def on_shutdown(_app: web.Application) -> None:
    all_ws = set().union(*_ws_pools.values())
    if all_ws:
        await asyncio.gather(
            *(ws.close(code=1001, message=b"server shutdown") for ws in all_ws),
            return_exceptions=True,
        )
    audit("server_stopped")


def create_app() -> web.Application:
    app = web.Application(client_max_size=60 * 1024 * 1024)
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)

    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/stream", r_screen_stream)

    app.router.add_get("/api/status", api_status)
    app.router.add_get("/api/audit", api_audit)
    app.router.add_post("/api/reset", api_reset)

    app.router.add_get("/api/session", r_session_get)
    app.router.add_post("/api/session/new", r_session_new)
    app.router.add_post("/api/session/join", r_session_join)
    app.router.add_post("/api/session/approve", r_session_approve)
    app.router.add_post("/api/session/revoke", r_session_revoke)

    app.router.add_get("/api/screen", r_screen_meta)
    app.router.add_post("/api/screen/frame", r_screen_frame)
    app.router.add_post("/api/screen/stop", r_screen_stop)
    app.router.add_get("/api/screen/stream", r_screen_stream)

    app.router.add_post("/api/control", r_control)
    app.router.add_get("/api/control/poll", r_control_poll)

    app.router.add_get("/api/session/signal", r_signal_get)
    app.router.add_post("/api/session/signal", r_signal_post)

    app.router.add_get("/", r_index)
    app.router.add_get("/{filename:.+}", r_static)
    return app


make_app = create_app


if __name__ == "__main__":
    web.run_app(create_app(), host=HOST, port=PORT, access_log=None)
