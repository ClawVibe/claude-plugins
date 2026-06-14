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
│   ├── shared/protocol.ts          # wire + IPC types, sessionKey parser, NDJSON framing
│   ├── shared/access.ts            # config paths + access.json/pairing/bootstrap (daemon-only)
│   ├── shared/identity.ts          # loadAgentIdentity() from ~/.claude/agents/<id>.md frontmatter
│   ├── qr.py                       # QR code generator + interactive pairing tool (hits daemon HTTP)
│   ├── bin/clawvibe                # CLI wrapper (installed to /usr/local/bin in container)
│   ├── package.json                # clawvibe-channel; start→channel-client.ts, daemon→gateway-daemon.ts
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
- **Tailscale inside container**: WebSocket upgrades require HTTP/1.1. Host-side Tailscale Serve uses HTTP/2 which breaks WS upgrades. Tailscale must run inside the container (same as OpenClaw's setup).
- **`CLAWVIBE_HOSTNAME` must be `127.0.0.1`**, not `0.0.0.0`. Tailscale serve binds the Tailscale IP on the plugin port; `0.0.0.0` conflicts. The supervisor sets this in the subprocess env.

## Reconnection

The server handles iOS reconnection after network disruptions:
- **Stdin close → exit**: prevents orphan bun processes holding the port when the parent (Claude Code) dies.
- **10s handshake timeout**: unauthenticated gateway sockets that don't complete `connect` within 10s get closed.
- **Dead socket reaper**: runs every 30s in the tick interval, removes sockets with `readyState !== 1`.
- **Stale socket eviction**: when the same `device_id` reconnects, old sockets are closed with code 4000.
- **activeRuns TTL**: entries older than 5 minutes are pruned to prevent stale run tracking.

## Development

```bash
# Install deps (inside the plugin dir)
cd external_plugins/clawvibe && bun install

# The plugin is bind-mounted into ubuntu-clawcode at /opt/clawvibe-plugin
# Changes are picked up on restart:
clawcode restart spongebob
```
