## MUST Follow
- Don't assume. Don't hide confusion. Surface tradeoffs.
- Minimum code that solves the problem. Nothing speculative.
- Touch only what you must. Clean up only your own mess.
- Define success criteria. Loop until verified.

# ClawVibe Channel Plugin for Claude Code

Claude Code channel plugin that connects the ClawVibe iOS app to Claude Code agents (specifically SpongeBob on ClawCode). Speaks the **OpenClaw gateway wire protocol** so the iOS app's `GatewayChannelActor` handles both OpenClaw and ClawCode connections identically — full reconnection, keepalive, error classification.

## Structure

This repo is a **Claude Code plugin marketplace** (not just a plugin). Structure:

```
clawvibe-plugin/                    # marketplace repo root
├── external_plugins/clawvibe/      # the actual plugin
│   ├── gateway-daemon.ts           # shared HTTP/WS gateway daemon (Bun): owns :8791, pairing, agent registry, IPC server
│   ├── channel-client.ts           # per-session MCP server (`start`): connects to daemon over IPC, registers its agent
│   ├── cli.ts                      # automation CLI: setup / agent add|rm|list / agents up|down / install-service
│   ├── shared/{protocol,access,identity}.ts  # wire+IPC types & sessionKey parser; config+pairing; agent identity
│   ├── dist/                       # COMMITTED self-contained bundle (sdk inlined) — what `start`/daemon run
│   ├── qr.py                       # QR code generator + interactive pairing tool (hits daemon HTTP)
│   ├── bin/clawvibe                # CLI dispatcher (qr→qr.py; setup/agent/agents/install-service→cli.ts)
│   ├── package.json                # build→dist; start→dist/channel-client.js; daemon→dist/gateway-daemon.js
│   └── README.md
├── package.json                    # marketplace-level
└── README.md
```

- **Marketplace name**: `clawvibe-plugins`
- **GitHub**: `ClawVibe/claude-plugins` (private)
- **Plugin name**: `clawvibe`
- **Runtime**: Bun + `@modelcontextprotocol/sdk`

## How It Integrates with ClawCode

ClawCode's daemon spawns SpongeBob with:
```
--channels plugin:telegram@claude-plugins-official plugin:clawvibe@clawvibe-plugins
```

The plugin runs as an MCP subprocess inside the `ubuntu-clawcode` container. iOS app messages arrive via the gateway WebSocket, get delivered as `notifications/claude/channel` to Claude Code, and become conversation turns for SpongeBob.

## Architecture: shared gateway + thin clients (multi-agent)

The gateway is **decoupled from the agent sessions**. One long-lived **gateway daemon** owns `:8791` + pairing + device WebSockets + a dynamic agent registry. Each Claude session launches a thin **channel client** (`bun channel-client.ts`, via `--channels`) that connects to the daemon over a Unix socket (`$CLAWVIBE_STATE_DIR/gateway.sock`), auto-spawning the daemon if absent (singleton-guarded), and registers its agent (`CLAUDE_CODE_AGENT`, identity from `~/.claude/agents/<id>.md`).

**Routing:** the iOS app encodes the target agent in `sessionKey = "agent:<agentId>:clawvibe:app:<deviceId>"`. The daemon parses `<agentId>` from `chat.send`, forwards the message over IPC to that agent's client (which injects it as a turn), and routes the client's `reply` back to **only** the originating device socket, echoing the same `runId`/`sessionKey` with an incrementing `seq`. `agents.list`/`agent.identity.get` are served from the live registry. Multiple agents share the one gateway/port — this is why several agent sessions can run at once (the old monolithic `server.ts` bound `:8791` per-session, which raced and orphaned).

This fixes the historical fixed-port races/zombies: a redundant daemon `exit(0)`s on `EADDRINUSE` (no zombie), the daemon **lingers** when agents disconnect (pairing keeps working), and only the daemon writes `access.json` (single writer).

## Gateway Wire Protocol

The server implements the OpenClaw gateway protocol:

1. **WebSocket upgrade** at `/` (root path)
2. **connect.challenge** event sent on open
3. **connect** RPC with `auth.token` (device token) or `auth.bootstrapToken` (QR pairing)
4. **HelloOk** response with snapshot, auth (including issued `deviceToken`), and policy
5. **tick** events every 30s (keepalive)
6. **chat.send** RPC for inbound messages → `notifications/claude/channel`
7. **chat** events for outbound replies (via `reply` MCP tool)
8. **agents.list** RPC for agent discovery
9. **health** RPC

## Pairing

Two pairing flows:

- **Bootstrap (QR)**: `clawvibe qr` generates a one-time bootstrap token, encodes `{url, bootstrapToken, kind: "clawvibe"}` as URL-safe base64, displays QR. iOS scans, connects with `auth.bootstrapToken`, server auto-approves and issues a device token in HelloOk.
- **Legacy (pairing code)**: `POST /pair/request` → 5-letter code → operator approves → `GET /pair/status` returns device token.

## CLI

Inside the container:
```bash
clawvibe qr              # generate QR, wait for device to pair
clawvibe qr --no-wait    # generate QR and exit
clawvibe qr --text       # output setup code as text
```

From the host:
```bash
clawcode qr              # runs clawvibe qr inside the container
```

## Key Gotchas

- **`allowedChannelPlugins` replaces defaults.** On team plans, setting this field in managed settings overwrites the Anthropic default list entirely — telegram must be re-listed or it stops working. Format: `[{"marketplace": "claude-plugins-official", "plugin": "telegram"}, {"marketplace": "clawvibe-plugins", "plugin": "clawvibe"}]`
- **Blocked plugins fail silently.** They spawn, complete MCP handshake, then get terminated — no error in logs. Diagnostic: `server.pid` keeps rewriting with new PIDs but no `bun` process in `ps`.
- **Dev testing bypass**: `--dangerously-load-development-channels plugin:clawvibe@clawvibe-plugins` skips the allowlist (still requires `channelsEnabled: true`).
- **MCP tool names**: colons become underscores in permission rules. `plugin:clawvibe:clawvibe` → `mcp__plugin_clawvibe_clawvibe__<tool>`.
- **Tailscale Serve must be TLS-terminated TCP, NOT an HTTPS web proxy.** A `tailscale serve --https=8791` web proxy serves over **HTTP/2**, which breaks/destabilizes WebSocket upgrades — symptom: the WS connects, runs a few RPCs, then drops with **code 1006** in a reconnect loop (local `127.0.0.1` connections are fine; only the tailnet path drops). Fix — forward raw TCP so HTTP/1.1 is preserved end-to-end (TLS still terminated by Tailscale, so the app still uses `wss://`):
  ```bash
  sudo tailscale serve --https=8791 off
  sudo tailscale serve --bg --tls-terminated-tcp=8791 tcp://localhost:8791
  ```
  Inside the container this is avoided by running Tailscale in-container; on a host gateway use the TCP-forward form above.
- **`CLAWVIBE_HOSTNAME` must be `127.0.0.1`**, not `0.0.0.0`. Tailscale serve binds the Tailscale IP on the plugin port; `0.0.0.0` conflicts. The supervisor sets this in the subprocess env.
- **Deps are bundled — run `bun run build` after changing source.** `start`/`daemon` run the committed `dist/*.js`, which inline `@modelcontextprotocol/sdk` (self-contained, so a fresh marketplace install needs no `node_modules`). The `dist/` artifacts are committed and **must be rebuilt** (`bun run build`) and re-committed whenever `channel-client.ts`/`gateway-daemon.ts`/`shared/*` change, or the deployed plugin runs stale code. (Historically, a fresh install with no `node_modules` made the MCP server report `status: "failed"` — bundling fixes that.)
- **Multi-server token collision (re-auth).** The iOS app stores its device token per *(device, role)*, not per server — so two `operator` servers (e.g. this host gateway + the container SpongeBob) clobber each other's token, and on switch-back the app falls through to its one-time setup/bootstrap token. The daemon therefore **re-authenticates a device from an already-used setup code** (paired bootstrap tokens are kept, not pruned) and re-hands the device token in HelloOk. Without this, reconnect after a server switch gets stuck on "authenticating".

## Reconnection

The daemon handles iOS reconnection after network disruptions:
- **Re-auth on reused setup code**: an already-used bootstrap token re-authenticates the device it originally paired (see the multi-server gotcha above).
- **10s handshake timeout**: unauthenticated gateway sockets that don't complete `connect` within 10s get closed.
- **Dead socket reaper**: runs every 30s in the tick interval, removes sockets with `readyState !== 1`.
- **Stale socket eviction**: when the same `device_id` reconnects, old sockets are closed with code 4000.
- **activeRuns TTL**: entries older than 5 minutes are pruned; a pruned run emits a targeted `aborted` so the app isn't left spinning.

Process lifecycle (split model):
- **Daemon is a singleton and lingers**: a redundant daemon `exit(0)`s on `EADDRINUSE` (no zombie); the daemon stays up across agent connects/disconnects so pairing keeps working.
- **Daemon detaches via `setsid`**: the auto-spawned daemon runs in its own session, independent of the spawning agent (so restarting an agent never destabilises the shared gateway).
- **Client stdin close → exit**: the per-session `channel-client` (not the daemon) exits when its Claude session ends; it deregisters from the daemon.
- **Inert without an agent**: a session with the plugin enabled but no `--agent`/`CLAWVIBE_AGENT_ID` does not register (avoids a bogus `default` agent in the picker).

## Development

```bash
cd external_plugins/clawvibe
bun install            # dev only (for typecheck/source runs); runtime uses the bundle
bun run build          # rebuild dist/ — REQUIRED after editing client/daemon/shared, then commit dist/

# The plugin is bind-mounted into ubuntu-clawcode at /opt/clawvibe-plugin
# Changes are picked up on restart:
clawcode restart spongebob
```

### Turnkey install / agent management (CLI)

```bash
clawvibe setup [--apply-tailscale]   # bundle check, link ~/.local/bin/clawvibe, Tailscale check, agents up
clawvibe agent add <id> --name "Friendly" --emoji 🤖   # writes ~/.claude/agents/<id>.md (+ managed-agents.json)
clawvibe agents up | down            # start (idempotent) / stop all clawvibe-* sessions
clawvibe agent list                  # configured + running/registered status
clawvibe install-service             # systemd --user unit running `agents up` at login/boot
```

- Managed-agent config: `$CLAWVIBE_STATE_DIR/managed-agents.json` (`[{id, model?}]`). Identity/persona come from `~/.claude/agents/<id>.md`: `name:` MUST equal the id/slug (routing/`--agent`); `--name` writes a separate `displayName:` that `shared/identity.ts` prefers for the app label.
- `clawvibe qr` runs the Tailscale ingress check first (warns on a non-TLS-TCP forward before you try to pair).
- The app's agent list = the **live daemon registry** (connected channel clients), not the agents folder or managed-agents.json. `install-service`/`agents up` start only the agents in managed-agents.json — not every file in `~/.claude/agents/`.
- `agents up` launches each as `claude --bg --channels … --agent <id> --permission-mode acceptEdits --allowed-tools <reply tools> --name clawvibe-<id>`, **from `$HOME`** (a trusted dir — otherwise the bg session blocks on a directory-trust prompt). The first launch auto-spawns the daemon (detached via `setsid`, so it survives agent restarts).
