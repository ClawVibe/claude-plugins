---
name: qr
description: Generate a ClawVibe pairing QR code for the iOS app to scan. Use when the user wants to pair their iPhone, set up ClawVibe, or connect the iOS app to this ClawCode session.
---

# Generate ClawVibe pairing QR code

The ClawVibe iOS app pairs by scanning a QR code containing the server URL. This skill generates that QR code.

## Steps

1. Determine the server URL. The plugin's HTTP server listens on `$CLAWVIBE_PORT` (default 8791) at `$CLAWVIBE_HOSTNAME` (default 127.0.0.1). The iOS app needs to reach this over the network — typically via Tailscale Serve or a reverse proxy.

2. Check if Tailscale Serve is already exposing the port:
```bash
tailscale serve status 2>/dev/null
```
Look for a line like `https://hostname:8791 (tailnet only)` — that's the URL the iOS app should use.

If not exposed, the user needs to set it up:
```bash
tailscale serve --bg --set-path / --https 8791 http://localhost:8791
```

3. Generate the QR code payload (JSON):
```json
{"kind": "clawvibe", "url": "https://<tailscale-hostname>:8791"}
```

4. Generate the QR code using Python (available on the host):
```bash
python3 -c "
import json
try:
    import qrcode
    payload = json.dumps({'kind': 'clawvibe', 'url': 'SERVER_URL_HERE'})
    img = qrcode.make(payload)
    path = '/tmp/clawvibe-pair.png'
    img.save(path)
    print(f'QR code saved to {path}')
except ImportError:
    print('Installing qrcode library...')
    import subprocess
    subprocess.run(['pip3', 'install', 'qrcode[pil]'], capture_output=True)
    import qrcode
    payload = json.dumps({'kind': 'clawvibe', 'url': 'SERVER_URL_HERE'})
    img = qrcode.make(payload)
    path = '/tmp/clawvibe-pair.png'
    img.save(path)
    print(f'QR code saved to {path}')
"
```

5. Show the QR code to the user by reading the generated PNG file. Use the Read tool on `/tmp/clawvibe-pair.png` to display it inline.

6. Tell the user to:
   - Open the ClawVibe iOS app
   - Go to Settings (or the setup screen)
   - Tap "Scan QR Code"
   - Scan the displayed QR code
   - Wait for the pairing code to appear in the server logs
   - You will then approve it via `/clawvibe:access pair <CODE>`

## Important

- Always check `tailscale serve status` first to find the correct public URL
- The QR payload must have `"kind": "clawvibe"` — this tells the iOS app to use the ClawVibe pairing flow instead of the OpenClaw flow
- After scanning, the iOS app POSTs to `/pair/request`, then polls `/pair/status`. The server logs the 5-letter pairing code to stderr.
