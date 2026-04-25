#!/usr/bin/env python3
"""Generate a ClawVibe pairing QR code.

Usage:
    python3 qr.py
    python3 qr.py --url https://my-host:8791
    python3 qr.py --text   # output the setup code as text instead of QR

Reads CLAWVIBE_PUBLIC_URL / CLAWVIBE_STATE_DIR / CLAWVIBE_PORT / CLAWVIBE_HOSTNAME
from the environment. Falls back to sensible defaults.
"""
import argparse
import base64
import json
import os
import sys
import urllib.request


def resolve_public_url() -> str | None:
    url = os.environ.get("CLAWVIBE_PUBLIC_URL", "")
    if url:
        return url
    state = os.environ.get(
        "CLAWVIBE_STATE_DIR",
        os.path.expanduser("~/.claude/channels/clawvibe"),
    )
    path = os.path.join(state, "public_url")
    if os.path.exists(path):
        return open(path).read().strip()
    return None


def to_ws(url: str) -> str:
    if url.startswith("https://"):
        return "wss://" + url[8:]
    if url.startswith("http://"):
        return "ws://" + url[7:]
    return url


def get_bootstrap_token(hostname: str, port: str) -> str:
    endpoint = f"http://{hostname}:{port}/bootstrap-token"
    req = urllib.request.Request(
        endpoint,
        method="POST",
        headers={"Content-Type": "application/json"},
        data=b"{}",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())["bootstrapToken"]


def encode_setup_code(payload: dict) -> str:
    raw = json.dumps(payload).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def main():
    parser = argparse.ArgumentParser(description="Generate ClawVibe pairing QR code")
    parser.add_argument("--url", help="Override public URL")
    parser.add_argument("--text", action="store_true", help="Print setup code text instead of QR")
    args = parser.parse_args()

    public_url = args.url or resolve_public_url()
    if not public_url:
        print("ERROR: No public URL configured.", file=sys.stderr)
        print("Set CLAWVIBE_PUBLIC_URL, create $CLAWVIBE_STATE_DIR/public_url,", file=sys.stderr)
        print("or pass --url https://your-host:8791", file=sys.stderr)
        sys.exit(1)

    hostname = os.environ.get("CLAWVIBE_HOSTNAME", "127.0.0.1")
    port = os.environ.get("CLAWVIBE_PORT", "8791")

    try:
        token = get_bootstrap_token(hostname, port)
    except Exception as e:
        print(f"ERROR: Could not get bootstrap token from http://{hostname}:{port}/bootstrap-token", file=sys.stderr)
        print(f"  {e}", file=sys.stderr)
        print("Is the ClawVibe server running?", file=sys.stderr)
        sys.exit(1)

    payload = {
        "url": to_ws(public_url),
        "bootstrapToken": token,
        "kind": "clawvibe",
    }
    encoded = encode_setup_code(payload)

    if args.text:
        print(encoded)
        return

    try:
        import qrcode
    except ImportError:
        import subprocess
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "qrcode"],
            capture_output=True,
        )
        import qrcode

    qr = qrcode.QRCode(box_size=1, border=1)
    qr.add_data(encoded)
    qr.make()
    qr.print_ascii(invert=True)
    print()
    print(f"Server:  {to_ws(public_url)}")
    print("Token expires in 10 minutes")


if __name__ == "__main__":
    main()
