# ClawVibe Channel Plugin for Claude Code

Claude Code channel plugin that connects the ClawVibe iOS app to Claude Code agents (specifically SpongeBob on ClawCode). This is the NEW plugin replacing the OpenClaw channel plugin (`clawvibe-openclaw-plugin`). Part of the ClawCode Phase 5b migration.

## Structure

This repo is a **Claude Code plugin marketplace** (not just a plugin). Structure:

```
clawvibe-plugin/                    # marketplace repo root
├── external_plugins/clawvibe/      # the actual plugin
│   ├── server.ts                   # MCP server entry point (Bun)
│   ├── package.json                # clawvibe-channel, deps: @modelcontextprotocol/sdk
│   ├── skills/                     # slash commands
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

The plugin runs as an MCP subprocess inside the `ubuntu-clawcode` container. iOS app messages arrive via the plugin and become conversation turns for SpongeBob.

## Key Gotchas

- **`allowedChannelPlugins` replaces defaults.** On team plans, setting this field in managed settings overwrites the Anthropic default list entirely — telegram must be re-listed or it stops working. Format: `[{"marketplace": "claude-plugins-official", "plugin": "telegram"}, {"marketplace": "clawvibe-plugins", "plugin": "clawvibe"}]`
- **Blocked plugins fail silently.** They spawn, complete MCP handshake, then get terminated — no error in logs. Diagnostic: `server.pid` keeps rewriting with new PIDs but no `bun` process in `ps`.
- **Dev testing bypass**: `--dangerously-load-development-channels plugin:clawvibe@clawvibe-plugins` skips the allowlist (still requires `channelsEnabled: true`).
- **MCP tool names**: colons become underscores in permission rules. `plugin:clawvibe:clawvibe` → `mcp__plugin_clawvibe_clawvibe__<tool>`.

## Development

```bash
# Install deps (inside the plugin dir)
cd external_plugins/clawvibe && bun install

# The plugin is bind-mounted into ubuntu-clawcode at /opt/clawvibe-plugin
# Changes are picked up on restart:
clawcode restart spongebob
```

No standalone entry point — the plugin is loaded by Claude Code's channel runtime.
