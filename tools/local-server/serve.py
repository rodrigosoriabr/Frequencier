"""
HTTPS server for testing Frequencier on a phone over Tailscale.

Serves a published copy of the site (see publish.sh) on <tailnet-ip>:8443 with a real
Let's Encrypt certificate from `tailscale cert`, so the PWA, service worker and wake lock
all work on the phone. Run by launchd (eu.rodrigosoria.frequencier.plist).

Why it looks like this:
- Binds to the tailnet IP, not 0.0.0.0, so the port is not exposed on home/café Wi-Fi.
- The tailnet IP can change; when it does the socket listens on a dead address while the
  process looks healthy. A watchdog exits so launchd restarts on the new IP.
- At boot launchd starts before Tailscale is up, so we wait for an IP instead of crashing.
- Serves a copy on the internal disk: launchd jobs can't read /Volumes/Work (macOS TCC).
"""

import functools
import http.server
import json
import os
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse

TAILSCALE = "/usr/local/bin/tailscale"
PORT = 8443
BASE = os.path.expanduser("~/Library/Application Support/Frequencier")
SITE = os.path.join(BASE, "site")
CERT = os.path.join(BASE, "certs", "tailnet.crt")
KEY = os.path.join(BASE, "certs", "tailnet.key")


def log(message):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), message, flush=True)


def tailnet_ip():
    try:
        out = subprocess.run([TAILSCALE, "ip", "-4"], capture_output=True, text=True, timeout=10)
        return out.stdout.strip().splitlines()[0] if out.returncode == 0 and out.stdout.strip() else None
    except Exception:
        return None


def tailnet_name():
    out = subprocess.run([TAILSCALE, "status", "--json"], capture_output=True, text=True, timeout=10)
    return json.loads(out.stdout)["Self"]["DNSName"].rstrip(".")


class Handler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        # Decode first so %2E / %63 tricks can't reach dotfiles.
        parts = urllib.parse.unquote(self.path.split("?")[0]).replace("\\", "/").split("/")
        if any(part.startswith(".") for part in parts):
            self.send_error(404)
            return None
        return super().send_head()

    def end_headers(self):
        # Always revalidate, so a republish shows up on the next reload.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


def watch_ip(bound_ip):
    while True:
        time.sleep(60)
        current = tailnet_ip()
        if current and current != bound_ip:
            log(f"tailnet IP changed {bound_ip} -> {current}; exiting so launchd restarts")
            os._exit(3)


def main():
    ip = tailnet_ip()
    while not ip:
        log("waiting for Tailscale...")
        time.sleep(10)
        ip = tailnet_ip()

    name = tailnet_name()
    os.makedirs(os.path.dirname(CERT), exist_ok=True)
    # Idempotent: only re-issues near expiry, so calling it on every start handles renewal.
    subprocess.run([TAILSCALE, "cert", "--cert-file", CERT, "--key-file", KEY, name], check=True, timeout=120)

    if not os.path.isfile(os.path.join(SITE, "index.html")):
        log(f"nothing published in {SITE}; run tools/local-server/publish.sh")
        sys.exit(1)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(CERT, KEY)
    server = http.server.ThreadingHTTPServer((ip, PORT), functools.partial(Handler, directory=SITE))
    server.socket = context.wrap_socket(server.socket, server_side=True)

    threading.Thread(target=watch_ip, args=(ip,), daemon=True).start()
    log(f"serving https://{name}:{PORT}/ on {ip}")
    server.serve_forever()


if __name__ == "__main__":
    main()
