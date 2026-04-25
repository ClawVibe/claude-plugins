---
name: qr
description: Generate a ClawVibe pairing QR code for the iOS app to scan. Use when the user wants to pair their iPhone, set up ClawVibe, or connect the iOS app to this ClawCode session.
---

# Generate ClawVibe pairing QR code

The ClawVibe iOS app pairs by scanning a QR code. The QR code uses the same
format as OpenClaw: a JSON payload `{url, bootstrapToken, kind}` encoded as
URL-safe base64 (no padding).

## Steps

1. Determine the public URL. Check these sources in order:
   - `$CLAWVIBE_PUBLIC_URL` env var (set by the daemon for SpongeBob)
   - `$CLAWVIBE_STATE_DIR/public_url` file (manual config fallback)
   - If neither exists, ask the user for their Tailscale hostname

2. Generate a bootstrap token and QR code:

```bash
python3 -c "
import json, sys, os, base64, urllib.request

# Resolve public URL
url = os.environ.get('CLAWVIBE_PUBLIC_URL', '')
if not url:
    state = os.environ.get('CLAWVIBE_STATE_DIR', os.path.expanduser('~/.claude/channels/clawvibe'))
    uf = os.path.join(state, 'public_url')
    if os.path.exists(uf):
        url = open(uf).read().strip()
if not url:
    print('ERROR: No public URL configured.')
    print('Set CLAWVIBE_PUBLIC_URL or create \$CLAWVIBE_STATE_DIR/public_url')
    sys.exit(1)

# Convert to wss:// for the gateway URL
ws_url = url
if ws_url.startswith('https://'):
    ws_url = 'wss://' + ws_url[8:]
elif ws_url.startswith('http://'):
    ws_url = 'ws://' + ws_url[7:]

# Get bootstrap token from the server
port = os.environ.get('CLAWVIBE_PORT', '8791')
hostname = os.environ.get('CLAWVIBE_HOSTNAME', '127.0.0.1')
local_url = f'http://{hostname}:{port}/bootstrap-token'
try:
    req = urllib.request.Request(local_url, method='POST',
        headers={'Content-Type': 'application/json'}, data=b'{}')
    with urllib.request.urlopen(req, timeout=5) as resp:
        token_data = json.loads(resp.read())
    bootstrap_token = token_data['bootstrapToken']
except Exception as e:
    print(f'ERROR: Could not get bootstrap token from {local_url}: {e}')
    print('Is the ClawVibe server running?')
    sys.exit(1)

# Build payload in OpenClaw format with kind discriminator
payload = json.dumps({
    'url': ws_url,
    'bootstrapToken': bootstrap_token,
    'kind': 'clawvibe'
})

# Encode as URL-safe base64 (no padding) — same as OpenClaw's encodePairingSetupCode
encoded = base64.urlsafe_b64encode(payload.encode('utf-8')).decode('ascii').rstrip('=')

# Generate QR code
try:
    import qrcode
except ImportError:
    import subprocess
    subprocess.run([sys.executable, '-m', 'pip', 'install', 'qrcode'], capture_output=True)
    import qrcode

qr = qrcode.QRCode(box_size=1, border=1)
qr.add_data(encoded)
qr.make()
qr.print_ascii(invert=True)
print()
print(f'Server:  {ws_url}')
print(f'Token expires in 10 minutes')
"
```

3. Tell the user:
   - Open the ClawVibe iOS app
   - Go to the setup screen (Settings → Unpair, or first launch)
   - Tap **Scan QR Code**
   - Scan the QR code shown above
   - The device will be automatically paired — no approval code needed
