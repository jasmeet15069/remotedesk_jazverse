# RemoteDesk Host Agent

This is a visible Windows desktop host agent for approved RemoteDesk sessions.
It captures your screen and sends preview frames to `remotedesk.jazverse.online`
only while you keep the app open and press **Start sharing**.

## Run

For the one-file background tray app, double-click:

```text
RemoteDeskHost.vbs
```

This is the recommended desktop host. It prompts for the session code, then runs
from the Windows system tray.

Developer/source launchers:

```text
start_remotedesk_host.vbs
```

This opens a small code prompt, then runs from the Windows system tray. Right-click
the tray icon and choose **Stop RemoteDesk Host** to disable it.

Console fallback:

```text
start_remotedesk_host.bat
```

The launchers use built-in Windows PowerShell, so Python is not required.

Or run the older Python version manually:

```powershell
cd host_agent
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python remotedesk_host.py
```

## Flow

1. Open `https://remotedesk.jazverse.online` on PC and mobile.
2. Generate a fresh code on the website.
3. Connect from mobile with that code.
4. Approve the session on PC with **Share screen** enabled.
5. Open this host agent, enter the same code, and click **Start sharing**.
6. On mobile, tap **View Live**.

The app is intentionally visible and stoppable. It is not designed to hide from
the desktop user, monitoring tools, exams, or administrators.
