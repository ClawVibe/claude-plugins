# ClawVibe Channel Plugin for Claude Code

Claude Code channel plugin that connects the ClawVibe iOS app to Claude Code agents (specifically SpongeBob on ClawCode). Speaks the **OpenClaw gateway wire protocol** so the iOS app's `GatewayChannelActor` handles both OpenClaw and ClawCode connections identically — full reconnection, keepalive, error classification.

## Structure

This repo is a **Claude Code plugin marketplace** (not just a plugin). Structure:

```
clawvibe-plugin/                    # marketplace repo root
├── external_plugins/clawvibe/      # the actual plugin
│   ├── server.ts                   # MCP server + HTTP/WS gateway server (Bun)
│   ├── qr.py                       # QR code generator + interactive pairing tool
│   ├── bin/clawvibe                # CLI wrapper (installed to /usr/local/bin in container)
│   ├── package.json                # clawvibe-channel, deps: @modelcontextprotocol/sdk
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

## Development

```bash
# Install deps (inside the plugin dir)
cd external_plugins/clawvibe && bun install

# The plugin is bind-mounted into ubuntu-clawcode at /opt/clawvibe-plugin
# Changes are picked up on restart:
clawcode restart spongebob
```
