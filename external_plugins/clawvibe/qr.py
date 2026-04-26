#!/usr/bin/env python3
"""Generate a ClawVibe pairing QR code and wait for the device to connect.

Usage:
    clawvibe qr              # display QR, wait for pairing
    clawvibe qr --text       # output setup code as text, wait for pairing
    clawvibe qr --no-wait    # print QR and exit immediately

Resolves the public URL dynamically from CLAWVIBE_PUBLIC_URL env,
$CLAWVIBE_STATE_DIR/public_url file, or Tailscale hostname.
"""
import base64
import json
import os
import signal
import sys
import time
import urllib.request


def resolve_public_url() -> str | None:
    url = os.environ.get("CLAWVIBE_PUBLIC_URL", "")
    if url:
        return url
    # Check state dir (env or default) and well-known SpongeBob state dir
    candidates = []
    state = os.environ.get("CLAWVIBE_STATE_DIR", "")
    if state:
        candidates.append(os.path.join(state, "public_url"))
    candidates += [
        os.path.expanduser("~/.claude/channels/clawvibe-spongebob/public_url"),
        os.path.expanduser("~/.claude/channels/clawvibe/public_url"),
    ]
    for path in candidates:
        if os.path.exists(path):
            return open(path).read().strip()
    # Auto-discover from Tailscale hostname
    import subprocess
    try:
        result = subprocess.run(
            ["tailscale", "status", "--json"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            dns_name = data.get("Self", {}).get("DNSName", "").rstrip(".")
            if dns_name:
                port = os.environ.get("CLAWVIBE_PORT", "8791")
                return f"https://{dns_name}:{port}"
    except Exception:
        pass
    return None


def to_ws(url: str) -> str:
    if url.startswith("https://"):
        return "wss://" + url[8:]
    if url.startswith("http://"):
        return "ws://" + url[7:]
    return url


def server_url() -> tuple[str, str]:
    hostname = os.environ.get("CLAWVIBE_HOSTNAME", "127.0.0.1")
    port = os.environ.get("CLAWVIBE_PORT", "8791")
    return hostname, port


def api_post(hostname: str, port: str, path: str) -> dict:
    req = urllib.request.Request(
        f"http://{hostname}:{port}{path}",
        method="POST",
        headers={"Content-Type": "application/json"},
        data=b"{}",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def api_get(hostname: str, port: str, path: str) -> dict:
    req = urllib.request.Request(f"http://{hostname}:{port}{path}")
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())


def encode_setup_code(payload: dict) -> str:
    raw = json.dumps(payload).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def print_qr(data: str) -> None:
    try:
        import qrcode
    except ImportError:
        import subprocess
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--break-system-packages",
             "--no-cache-dir", "qrcode"],
            capture_output=True,
        )
        import qrcode

    qr = qrcode.QRCode(box_size=1, border=1)
    qr.add_data(data)
    qr.make()
    qr.print_ascii(invert=True)


def main(args: list[str] | None = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Generate ClawVibe pairing QR code")
    parser.add_argument("--text", action="store_true", help="Print setup code text instead of QR")
    parser.add_argument("--no-wait", action="store_true", help="Print QR and exit without waiting")
    parser.add_argument("--url", help="Override public URL")
    opts = parser.parse_args(args)

    public_url = opts.url or resolve_public_url()
    if not public_url:
        print("ERROR: No public URL configured.", file=sys.stderr)
        print("Set CLAWVIBE_PUBLIC_URL or ensure Tailscale is running.", file=sys.stderr)
        sys.exit(1)

    hostname, port = server_url()

    try:
        resp = api_post(hostname, port, "/bootstrap-token")
        token = resp["bootstrapToken"]
    except Exception as e:
        print(f"ERROR: Could not reach ClawVibe server at {hostname}:{port}", file=sys.stderr)
        print(f"  {e}", file=sys.stderr)
        print("Is the ClawVibe channel plugin running?", file=sys.stderr)
        sys.exit(1)

    payload = {
        "url": to_ws(public_url),
        "bootstrapToken": token,
        "kind": "clawvibe",
    }
    encoded = encode_setup_code(payload)

    if opts.text:
        print(encoded)
    else:
        print_qr(encoded)

    print()
    print(f"  Server:  {to_ws(public_url)}")
    print(f"  Token expires in 10 minutes")
    print()

    if opts.no_wait:
        return

    # Poll for pairing
    print("Waiting for device to scan QR code...", end="", flush=True)

    stop = False
    def _sigint(sig, frame):
        nonlocal stop
        stop = True
    signal.signal(signal.SIGINT, _sigint)

    deadline = time.time() + 10 * 60  # match token TTL
    dots = 0
    while not stop and time.time() < deadline:
        time.sleep(2)
        try:
            status = api_get(hostname, port, f"/bootstrap-token/{token}")
        except Exception:
            continue
        if status.get("status") == "paired":
            name = status.get("device_name", "unknown device")
            print(f"\n\n  Paired with {name}!")
            print()
            return
        if status.get("status") == "expired":
            print("\n\n  Token expired. Run 'clawvibe qr' again.")
            sys.exit(1)
        dots += 1
        if dots % 15 == 0:
            print(".", end="", flush=True)

    if stop:
        print("\n  Cancelled.")
    else:
        print("\n\n  Timed out. Run 'clawvibe qr' again.")
        sys.exit(1)


if __name__ == "__main__":
    main()
