import base64
import io
import threading
import time
import tkinter as tk
from tkinter import messagebox

import requests
from PIL import ImageGrab


DEFAULT_SERVER = "https://remotedesk.jazverse.online"


class RemoteDeskHost:
    def __init__(self, root):
        self.root = root
        self.root.title("RemoteDesk Host")
        self.root.geometry("430x300")
        self.root.resizable(False, False)

        self.running = False
        self.worker = None

        tk.Label(root, text="RemoteDesk Host", font=("Segoe UI", 18, "bold")).pack(anchor="w", padx=18, pady=(16, 4))
        tk.Label(
            root,
            text="Visible consent-based screen sharing for your approved session.",
            font=("Segoe UI", 10),
            wraplength=380,
            justify="left",
        ).pack(anchor="w", padx=18)

        form = tk.Frame(root)
        form.pack(fill="x", padx=18, pady=14)

        tk.Label(form, text="Website").grid(row=0, column=0, sticky="w", pady=5)
        self.server_var = tk.StringVar(value=DEFAULT_SERVER)
        tk.Entry(form, textvariable=self.server_var, width=38).grid(row=0, column=1, sticky="ew", pady=5)

        tk.Label(form, text="Session code").grid(row=1, column=0, sticky="w", pady=5)
        self.code_var = tk.StringVar()
        tk.Entry(form, textvariable=self.code_var, width=38).grid(row=1, column=1, sticky="ew", pady=5)

        controls = tk.Frame(root)
        controls.pack(fill="x", padx=18, pady=8)

        self.start_button = tk.Button(controls, text="Start sharing", command=self.start, height=2, bg="#1e7a4d", fg="white")
        self.start_button.pack(side="left", expand=True, fill="x", padx=(0, 8))

        self.stop_button = tk.Button(controls, text="Stop sharing", command=self.stop, height=2, state="disabled")
        self.stop_button.pack(side="left", expand=True, fill="x")

        self.status_var = tk.StringVar(value="Idle. Enter the approved code, then start sharing.")
        tk.Label(root, textvariable=self.status_var, fg="#617066", wraplength=380, justify="left").pack(
            anchor="w", padx=18, pady=(10, 0)
        )

        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def start(self):
        code = self.code_var.get().strip()
        if not code:
            messagebox.showerror("Session code required", "Enter the code shown on remotedesk.jazverse.online.")
            return

        self.running = True
        self.start_button.config(state="disabled")
        self.stop_button.config(state="normal")
        self.status_var.set("Sharing is active. Keep this window open to continue.")
        self.worker = threading.Thread(target=self.share_loop, daemon=True)
        self.worker.start()

    def stop(self):
        self.running = False
        self.start_button.config(state="normal")
        self.stop_button.config(state="disabled")
        self.status_var.set("Stopped. Your screen is no longer being shared.")
        self.post_stop()

    def on_close(self):
        self.stop()
        self.root.destroy()

    def endpoint(self, path):
        return self.server_var.get().rstrip("/") + path

    def post_stop(self):
        try:
            requests.post(self.endpoint("/api/screen/stop"), json={"code": self.code_var.get().strip()}, timeout=5)
        except requests.RequestException:
            pass

    def share_loop(self):
        while self.running:
            try:
                image = ImageGrab.grab()
                image.thumbnail((960, 540))

                buffer = io.BytesIO()
                image.save(buffer, format="JPEG", quality=58, optimize=True)
                encoded = base64.b64encode(buffer.getvalue()).decode("ascii")

                response = requests.post(
                    self.endpoint("/api/screen/frame"),
                    json={
                        "code": self.code_var.get().strip(),
                        "image": f"data:image/jpeg;base64,{encoded}",
                    },
                    timeout=8,
                )

                if response.status_code == 403:
                    self.root.after(0, self.status_var.set, "Waiting for approved screen permission for this code.")
                elif response.ok:
                    self.root.after(0, self.status_var.set, "Sharing live preview to mobile viewer.")
                else:
                    self.root.after(0, self.status_var.set, f"Server error: {response.status_code}")
            except Exception as exc:
                self.root.after(0, self.status_var.set, f"Capture error: {exc}")

            time.sleep(0.8)


if __name__ == "__main__":
    window = tk.Tk()
    RemoteDeskHost(window)
    window.mainloop()
