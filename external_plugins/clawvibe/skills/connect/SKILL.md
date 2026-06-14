---
name: connect
description: Pair a ClawVibe iOS device with this Claude Code session by generating a pairing QR code and waiting for the device to connect. Use when the user wants to connect or pair their ClawVibe app, set up a new device, or asks "how do I connect". Do NOT use to approve a pending legacy pairing code or manage existing devices — use the access skill for that.
---

# ClawVibe connect (device pairing)

Generates a one-time bootstrap QR code and waits for the iOS app to scan it.

The QR (bootstrap) flow **auto-approves** — when the device scans, the server validates the bootstrap token and mints a long-lived device token in the `HelloOk` response. There is **no separate approval step**. (The `access` skill is only for the legacy *pairing-code* flow, or for revoking/listing devices afterwards.)

The connect entrypoint is the `clawvibe qr` CLI (`bin/clawvibe` → `qr.py`). Prefer the `clawvibe` command on PATH; fall back to `"$CLAUDE_PLUGIN_ROOT/bin/clawvibe"` if it is not found.

## Pair a device

1. **Launch the QR generator in the background** so it can render the code and then poll for the scan without blocking:

   ```bash
   clawvibe qr
   ```

   Run it with `run_in_background: true`. On startup it:
   - mints a fresh bootstrap token (valid 10 minutes),
   - prints an **ASCII QR code** to stdout,
   - prints the server URL (e.g. `wss://<host>:8791`),
   - then waits, polling for the scan.

2. **Show the user the QR code — paste the ASCII QR into your chat reply inside a fenced ``` code block.** Read the background task's initial output and reproduce the ASCII QR *verbatim* in your message (plus the server URL). This matters: the raw tool output and rendered PNG images often do **not** display in the user's chat client, but an ASCII QR in a fenced code block does, and is scannable from screen. Tell them: open the **ClawVibe iOS app → scan this QR code**.

3. **Watch for the result** in the background output:
   - `Paired with <device name>!` → success. Report the device name; pairing is complete and the device token is already issued.
   - `Token expired.` / `Timed out.` → the 10-minute window lapsed. Re-run `clawvibe qr` for a fresh code.

   Stop the background task once you see a terminal result.

### Text fallback

If the ASCII QR won't render usefully (narrow terminal, copy/paste), use the encoded setup code instead — the iOS app accepts manual entry:

```bash
clawvibe qr --text --no-wait
```

This prints just the base64url setup code and exits (no polling). Note: each invocation mints a **new** token, so don't mix a `--text` run with a separate QR run — the tokens won't match.

## Troubleshooting

- **`ERROR: Could not reach ClawVibe server at <host>:<port>` / `Is the ClawVibe channel plugin running?`**
  The gateway daemon isn't up. The daemon is shared and auto-spawned by the first agent's channel client; it owns `:8791`. Confirm it's listening: `ss -ltnp | grep ${CLAWVIBE_PORT:-8791}`. If it's missing, an agent session with the clawvibe channel needs to be running (which spawns the daemon), or the plugin's `node_modules` may be missing so the MCP server failed to start (`bun install` in the plugin dir).

- **`ERROR: No public URL configured.`**
  `qr.py` resolves the public URL from `CLAWVIBE_PUBLIC_URL`, then `$CLAWVIBE_STATE_DIR/public_url`, then the Tailscale hostname. Set `CLAWVIBE_PUBLIC_URL` (e.g. `wss://host:8791`) or ensure Tailscale is running.

- **QR scans but the device can't stay connected (drops with code 1006 / "can't connect").**
  Transport issue, not pairing. The `wss://` ingress must be **TLS-terminated TCP**, not a Tailscale HTTPS web proxy (HTTP/2 breaks WebSockets). See the Tailscale Serve gotcha in the plugin CLAUDE.md (`tailscale serve --tls-terminated-tcp=8791 tcp://localhost:8791`).

- **Reconnect gets stuck on "authenticating" after switching servers.**
  Handled server-side: the daemon re-authenticates from a reused setup code. If it still sticks, confirm the device is still in `access.json` and the daemon has the re-auth build.

## Notes

- Honour `CLAWVIBE_STATE_DIR` — do not hardcode `~/.claude/channels/clawvibe`. Multiple Claude Code instances on one host use different state dirs (e.g. the SpongeBob channel uses `clawvibe-spongebob`).
- The bootstrap token is one-time for *fresh* pairing but, once it has paired a device, is retained and re-authenticates that device on reconnect; minting a new one (re-running the command) is harmless.
- After pairing, use the **access** skill to list, revoke, or change policy for the device.
