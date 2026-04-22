# ClawVibe channel for Claude Code

Pair a [ClawVibe](https://www.clawvibe.app) iOS device with any Claude Code session. The device talks to this plugin over a WebSocket; the plugin forwards each message into the Claude session as a channel notification, and the agent replies through the `reply` tool.

Works on any Claude Code instance — ClawCode users and generic users alike.

## Install

```
/plugin install clawvibe@claude-plugins-official
claude --channels plugin:clawvibe@claude-plugins-official
```

## Configuration

- `CLAWVIBE_PORT` — HTTP/WS port (default `8791`).
- `CLAWVIBE_HOSTNAME` — bind host (default `127.0.0.1`). Expose to the public internet via a reverse proxy or Tailscale serve; do not bind `0.0.0.0` unless you know what you're doing.
- `CLAWVIBE_STATE_DIR` — state path (default `~/.claude/channels/clawvibe/`).

## Pairing flow

1. User opens ClawVibe iOS app, taps "Pair ClawVibe channel", scans the QR code you show them.
2. iOS hits `POST /pair/request` with `{device_id, device_name}`; server generates a 5-letter code and prints it to stderr.
3. You run `/clawvibe:access pair <code>` in the Claude session to approve.
4. iOS polls `GET /pair/status?device_id=…` and receives a long-lived `device_token`.
5. iOS opens `GET /ws?device_token=…` and the chat is live.

## Wire protocol (device ↔ server)

Client → server frames:

```json
{"type":"chat.send", "run_id":"…", "conversation_id":"…", "text":"…",
 "tags":{"context":"…", "location":"…", "voice_data":[…]}}
{"type":"chat.abort", "run_id":"…"}
{"type":"ping"}
```

Server → client frames:

```json
{"type":"message.final", "message_id":"…", "conversation_id":"…", "text":"…", "ts":…}
{"type":"message.edit",  "message_id":"…", "text":"…", "ts":…}
{"type":"pong"}
{"type":"tick", "ts":…}
```

Message text may contain format directives the ClawVibe client understands:

- `[SPEAK]` — force TTS
- `[TEXT]` — text-only, no TTS
- `---` — segment separator (new chat bubble)

## Security

- Device token is the only credential on `/ws`; leaking it gives full channel access until revoked (`/clawvibe:access revoke <device_id>`).
- No TLS here — deploy behind a proxy that terminates TLS (nginx, Caddy, Tailscale serve, Cloudflare Tunnel, etc.).
- Pairing codes expire 10 minutes after issuance.
