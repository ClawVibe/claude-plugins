# ClawVibe channel for Claude Code

Pair a [ClawVibe](https://www.clawvibe.app) iOS device with Claude Code. The device talks to a shared **gateway daemon** over a WebSocket (OpenClaw gateway wire protocol); the daemon routes each message to the selected agent's session as a channel notification, and the agent replies through the `reply` tool.

Works on any Claude Code instance — ClawCode users and generic users alike — and supports **multiple agents over one connection**.

## Architecture

- **Gateway daemon** (`gateway-daemon.ts`): one long-lived, detached singleton per machine. Owns the HTTP/WS port (`:8791`), device pairing/`access.json`, and a dynamic registry of connected agents. Auto-spawned by the first agent's channel client (via `setsid`) and lingers so pairing keeps working.
- **Channel client** (`channel-client.ts`): the per-session MCP server loaded via `--channels`. Connects to the daemon over a Unix socket, registers its agent id (`CLAUDE_CODE_AGENT`), relays inbound messages, and sends replies. The daemon **probes** it to confirm it's a live `--channels` agent and learns its display name/emoji from the reply (every reply carries them) — so only confirmed agents are listed, and identity stays current without reading any file.

The iOS app picks an agent and encodes it in the routing key `sessionKey = "agent:<agentId>:clawvibe:app:<deviceId>"`; the daemon routes to that agent and returns its reply to only the originating device.

## Install (new machine)

```
/plugin install clawvibe@clawvibe-plugins      # in Claude Code
clawvibe setup                                  # bundle check, CLI link, Tailscale check, start agents
clawvibe agent add <id> --emoji 🤖              # define + configure an agent (repeat per agent)
clawvibe agents up                              # start them (idempotent)
clawvibe qr                                      # pair your iOS device
clawvibe install-service                         # (optional) persist across reboot
```

Requires [Bun](https://bun.sh) as the runtime. **Dependencies are bundled** — the committed `dist/` is self-contained (the MCP SDK is inlined), so no `bun install` is needed at runtime. `clawvibe setup` symlinks the CLI to `~/.local/bin/clawvibe` (ensure that's on your `PATH`) and reports whether the Tailscale ingress is correctly configured (see Deployment).

## Managing agents

Agents are declarative: `clawvibe agent add <id>` writes `~/.claude/agents/<id>.md` (its name/emoji/persona) and records the id in `$CLAWVIBE_STATE_DIR/managed-agents.json`. `clawvibe agents up` starts a background channel session per configured agent (idempotent — skips ones already running); each registers with the shared daemon and appears in the app's picker.

The `<id>` is the routing slug (it becomes `name:` in the def and the `--agent` value). `--name`/`--emoji` are baked into the agent's prompt so it reports them on every reply (the gateway learns identity from replies, never from the file):

```
clawvibe agent add patrick --name "Patrick" --emoji ⭐ [--model <m>] [--prompt "<persona>"]
clawvibe agent list                  # configured agents + running/registered status
clawvibe agents up | down            # start all / stop all
clawvibe agent rm <id> [--purge]     # unconfigure (--purge also deletes the def)
```

`clawvibe install-service` writes a `systemd --user` unit (`clawvibe-agents.service`) that runs `clawvibe agents up` at login/boot. For start-at-boot without an active login, run `sudo loginctl enable-linger $USER`. (Linux/systemd; macOS launchd is a follow-up.) Claude Code must be authenticated for the user the unit runs as.

### Manual launch (equivalent of one `agents up` entry)

```
claude --bg --channels plugin:clawvibe@clawvibe-plugins --agent <id> \
  --permission-mode acceptEdits \
  --allowed-tools mcp__plugin_clawvibe_clawvibe__reply mcp__plugin_clawvibe_clawvibe__edit_message \
  --name clawvibe-<id> "<seed prompt>"
```

## Configuration

- `CLAWVIBE_PORT` — HTTP/WS port (default `8791`).
- `CLAWVIBE_HOSTNAME` — bind host (default `127.0.0.1`). Do **not** bind `0.0.0.0`; expose over the tailnet via Tailscale Serve (below).
- `CLAWVIBE_STATE_DIR` — state path (default `~/.claude/channels/clawvibe/`).
- `CLAWVIBE_AGENT_ID` / `CLAWVIBE_AGENT_NAME` / `CLAWVIBE_AGENT_EMOJI` — override the agent id/identity when `CLAUDE_CODE_AGENT` isn't set.

### Deployment: expose over Tailscale (important)

The gateway speaks plain HTTP/1.1; the device connects with `wss://`. Terminate TLS in front of it. **It must be a TLS-terminated TCP forward, not an HTTPS web proxy** — a `tailscale serve --https` proxy serves over HTTP/2, which breaks WebSocket upgrades (symptom: the WS connects, runs a few RPCs, then drops with **code 1006** in a loop; local `127.0.0.1` connections are unaffected).

```bash
sudo tailscale serve --https=8791 off                              # if a web proxy was set
sudo tailscale serve --bg --tls-terminated-tcp=8791 tcp://localhost:8791
```

`tailscale serve status` should show `:8791` as a TCP forward (TLS terminated), not a `/ proxy` web handler. Inside the OpenClaw/ClawCode container this is avoided by running Tailscale in-container; on a host gateway use the form above. Any TLS-terminating TCP proxy that preserves HTTP/1.1 (nginx/Caddy stream, Cloudflare Tunnel, etc.) works equally.

## Pairing

**QR / bootstrap (primary)** — use the `connect` skill, or run `clawvibe qr`:

1. `clawvibe qr` first runs a Tailscale ingress check (warns if the port isn't a TLS-terminated TCP forward — the usual "paired but won't connect" cause), then mints a one-time bootstrap token and renders a QR encoding `{url, bootstrapToken, kind: "clawvibe"}`. Show it to the user (the `connect` skill renders the ASCII QR directly in chat). `clawvibe qr --text` prints the setup code for manual entry.
2. The user scans it in the ClawVibe iOS app. The server validates the bootstrap token, **auto-approves**, and issues a long-lived device token in the `HelloOk` response — no separate approval step.
3. On reconnect the app presents the device token. If it falls back to the (already-used) setup code — e.g. after switching servers — the daemon **re-authenticates** the device that code originally paired and re-hands the device token.

**Legacy pairing code (secondary)** — `POST /pair/request` → 5-letter code → approve with `/clawvibe:access pair <code>` → `GET /pair/status` returns the device token.

Manage devices with the **`access`** skill (list / revoke / set policy).

## Wire protocol (device ↔ gateway)

Speaks the **OpenClaw gateway protocol** over a WebSocket at `/`:

1. On connect the server sends a `connect.challenge` event.
2. The client sends a `connect` RPC with `auth.token` (device token) or `auth.bootstrapToken`; the server replies `HelloOk` (protocol 3) including the issued `deviceToken`.
3. `chat.send` (with `sessionKey`, `message`, …) → server returns `{runId}`; inbound device messages are delivered to the selected agent.
4. The agent's reply comes back as `chat` events (`state: delta|final|error|aborted`) echoing the same `runId`/`sessionKey`, delivered only to the originating device.
5. `agents.list` / `agent.identity.get` for the agent picker; `health`; `tick` keepalive every 30s.

A legacy frame format (`{type:"chat.send"|"chat.abort"|"ping"}` over `/ws?device_token=…`) is still accepted for backward compatibility.

Message text may contain format directives the ClawVibe client understands:

- `[SPEAK]` — force TTS
- `[TEXT]` — text-only, no TTS
- `---` — segment separator (new chat bubble)

## Security

- The device token is a bearer credential; leaking it gives channel access until revoked (`/clawvibe:access revoke <device_id>`). A paired setup/bootstrap token is likewise retained and re-authenticates its device.
- No TLS in the gateway itself — deploy behind a TLS-terminating TCP proxy (see Deployment).
- Bootstrap tokens expire 10 minutes after issuance (for fresh pairing); once a token has paired a device it is retained to support reconnect re-auth.
- A session that merely has the plugin enabled (no `--agent` / `CLAWVIBE_AGENT_ID`) stays inert and does not register as an agent.
