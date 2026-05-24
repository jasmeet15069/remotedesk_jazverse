import json
import os
import random
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HOST = os.environ.get("REMOTEDESK_AI_HOST", "127.0.0.1")
PORT = int(os.environ.get("REMOTEDESK_AI_PORT", "8020"))
MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
SESSION_LOCK = threading.Lock()
SESSION = None
SCREEN_LOCK = threading.Lock()
SCREEN_FRAME = {"image": None, "updatedAt": None, "active": False}


def make_code():
    digits = "".join(str(random.randint(0, 9)) for _ in range(6))
    return f"{digits[:3]} {digits[3:]}"


def default_permissions():
    return {
        "screen": True,
        "mouse": False,
        "keyboard": False,
        "files": False,
        "ai": False,
    }


def new_session():
    return {
        "code": make_code(),
        "approved": False,
        "joinRequested": False,
        "revoked": False,
        "permissions": default_permissions(),
        "rtc": {
            "offer": None,
            "answer": None,
            "hostCandidates": [],
            "viewerCandidates": [],
        },
    }


def get_session():
    global SESSION
    with SESSION_LOCK:
        if SESSION is None:
            SESSION = new_session()
        return dict(SESSION)


def set_session(updates):
    global SESSION
    with SESSION_LOCK:
        if SESSION is None:
            SESSION = new_session()
        SESSION.update(updates)
        return dict(SESSION)


def set_screen_frame(image, active):
    with SCREEN_LOCK:
        SCREEN_FRAME["image"] = image
        SCREEN_FRAME["active"] = active
        SCREEN_FRAME["updatedAt"] = int(time.time() * 1000)
        return dict(SCREEN_FRAME)


def session_allows_screen(code):
    session = get_session()
    return (
        str(code).replace(" ", "") == session["code"].replace(" ", "")
        and session.get("approved")
        and not session.get("revoked")
        and (session.get("permissions") or {}).get("screen")
    )


class RemoteDeskHandler(BaseHTTPRequestHandler):
    server_version = "RemoteDeskAI/1.0"

    def do_POST(self):
        if self.path == "/api/session/new":
            session = set_session(new_session())
            self.send_json({"session": session})
            return

        if self.path == "/api/session/join":
            body = self.safe_read_json()
            if body is None:
                return

            code = str(body.get("code", "")).replace(" ", "")
            session = get_session()
            if code != session["code"].replace(" ", ""):
                self.send_json({"error": "Code rejected", "session": session}, 403)
                return

            session = set_session({"joinRequested": True, "revoked": False})
            self.send_json({"session": session})
            return

        if self.path == "/api/session/approve":
            body = self.safe_read_json()
            if body is None:
                return

            permissions = default_permissions()
            permissions.update({key: bool(value) for key, value in body.get("permissions", {}).items()})
            session = set_session({"approved": True, "revoked": False, "permissions": permissions})
            self.send_json({"session": session})
            return

        if self.path == "/api/session/revoke":
            session = set_session({"approved": False, "joinRequested": False, "revoked": True})
            set_screen_frame(None, False)
            self.send_json({"session": session})
            return

        if self.path == "/api/screen/frame":
            body = self.safe_read_json()
            if body is None:
                return

            if not session_allows_screen(body.get("code", "")):
                self.send_json({"error": "Approved screen session code is required"}, 403)
                return

            image = str(body.get("image", ""))
            if not image.startswith("data:image/jpeg;base64,"):
                self.send_json({"error": "JPEG data URL is required"}, 400)
                return

            frame = set_screen_frame(image, True)
            self.send_json({"ok": True, "updatedAt": frame["updatedAt"]})
            return

        if self.path == "/api/screen/stop":
            frame = set_screen_frame(None, False)
            self.send_json({"ok": True, "updatedAt": frame["updatedAt"]})
            return

        if self.path == "/api/session/signal":
            body = self.safe_read_json()
            if body is None:
                return

            role = body.get("role")
            signal_type = body.get("type")
            value = body.get("value")
            session = get_session()
            rtc = dict(session.get("rtc") or {})
            rtc.setdefault("hostCandidates", [])
            rtc.setdefault("viewerCandidates", [])

            if role == "host" and signal_type == "offer":
                rtc = {"offer": value, "answer": None, "hostCandidates": [], "viewerCandidates": []}
            elif role == "viewer" and signal_type == "answer":
                rtc["answer"] = value
            elif role == "host" and signal_type == "candidate":
                rtc["hostCandidates"].append(value)
            elif role == "viewer" and signal_type == "candidate":
                rtc["viewerCandidates"].append(value)
            else:
                self.send_json({"error": "Invalid signal"}, 400)
                return

            session = set_session({"rtc": rtc})
            self.send_json({"rtc": session["rtc"]})
            return

        if self.path != "/api/ai":
            self.send_json({"error": "Not found"}, 404)
            return

        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            self.send_json({"error": "GROQ_API_KEY is not configured"}, 500)
            return

        try:
            body = self.read_json()
            prompt = str(body.get("prompt", "")).strip()
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 400)
            return

        if not prompt:
            self.send_json({"error": "Prompt is required"}, 400)
            return

        payload = {
            "model": MODEL,
            "temperature": 0.2,
            "max_tokens": 500,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are RemoteDesk AI Assist. Help an approved remote support operator "
                        "plan safe, consent-based troubleshooting steps. Do not provide instructions "
                        "for covert access, credential theft, persistence, evasion, or bypassing user "
                        "consent. For any sensitive action, remind the operator that the host user "
                        "must approve it first."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
        }

        request = urllib.request.Request(
            GROQ_API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": "RemoteDesk-Jazverse/1.0",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            self.send_json({"error": "Groq request failed", "detail": detail}, exc.code)
            return
        except Exception as exc:
            self.send_json({"error": "AI service unavailable", "detail": str(exc)}, 502)
            return

        message = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        usage = result.get("usage", {})
        self.send_json({"model": MODEL, "message": message, "usage": usage})

    def do_GET(self):
        if self.path == "/api/health":
            self.send_json({"ok": True, "model": MODEL})
            return

        if self.path == "/api/session":
            self.send_json({"session": get_session()})
            return

        if self.path == "/api/session/signal":
            session = get_session()
            self.send_json({"rtc": session.get("rtc") or {}})
            return

        if self.path == "/api/screen":
            with SCREEN_LOCK:
                self.send_json({"screen": dict(SCREEN_FRAME)})
            return

        self.send_json({"error": "Not found"}, 404)

    def safe_read_json(self):
        try:
            return self.read_json()
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 400)
            return None

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > 2097152:
            raise ValueError("Request body is too large")

        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("Invalid JSON") from exc

    def send_json(self, payload, status=200):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        return


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), RemoteDeskHandler)
    print(f"RemoteDesk AI proxy listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()
