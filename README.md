# RemoteDesk — Setup Guide

## Files
```
remotedesk/
├── server.py      ← Python async server (aiohttp)
├── index.html     ← Web UI
├── app.js         ← Frontend logic (WebSocket + WebRTC)
├── styles.css     ← Styles
└── nginx.conf     ← Nginx reverse-proxy config
```

## 1. Install dependencies
```bash
pip install aiohttp
```

## 2. Run the server
```bash
python server.py
# Listening on http://127.0.0.1:8020
```

## 3. Nginx setup (for remotedesk.jazverse.online)
```bash
sudo cp nginx.conf /etc/nginx/sites-available/remotedesk
sudo ln -s /etc/nginx/sites-available/remotedesk /etc/nginx/sites-enabled/
sudo certbot --nginx -d remotedesk.jazverse.online   # free SSL
sudo nginx -t && sudo systemctl reload nginx
```

## 4. Run as a service (systemd)
```ini
# /etc/systemd/system/remotedesk.service
[Unit]
Description=RemoteDesk Server
After=network.target

[Service]
WorkingDirectory=/path/to/remotedesk
ExecStart=/usr/bin/python3 server.py
Restart=always
RestartSec=3
Environment=RD_HOST=127.0.0.1
Environment=RD_PORT=8020

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now remotedesk
```

## Architecture
```
Mobile browser ──WSS──► Nginx ──WS──► server.py
                 HTTPS               │
PC browser ──────────────────────────┘
                                     │
PC shares screen → MJPEG frames → /api/screen/stream → Mobile
PC / Mobile ───► WebRTC offer/answer via /ws ───► P2P video (fastest)
Mobile sends control events via WebSocket → /ws → queued for agent
Host agent polls /api/control/poll (or receives via WebSocket)
```

## How it works
1. **Computer side**: Open site, generate code, click "Start screen share"
2. **Mobile side**: Open `https://remotedesk.jazverse.online`, enter code, Connect → View Live
3. Video streams via **WebRTC P2P** (lowest latency) with **MJPEG fallback**
4. Mouse/keyboard events go via **WebSocket** (no HTTP round-trip per command)
5. All events broadcast instantly — no polling delays

## Environment variables
| Variable  | Default     | Description          |
|-----------|-------------|----------------------|
| RD_HOST   | 127.0.0.1   | Bind address         |
| RD_PORT   | 8020        | Bind port            |
