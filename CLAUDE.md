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
│   ├── shared/{protocol,access}.ts  # wire+IPC types & sessionKey parser; config+pairing
│   ├── test/storm-regression.ts    # manual regression check: `bun run test:storm`
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

The gateway is **decoupled from the agent sessions**. One long-lived **gateway daemon** owns `:8791` + pairing + device WebSockets + a dynamic agent registry. Each Claude session launches a thin **channel client** (`bun channel-client.ts`, via `--channels`) that connects to the daemon over a Unix socket (`$CLAWVIBE_STATE_DIR/gateway.sock`), auto-spawning the daemon if absent (singleton-guarded), and registers its agent id (`CLAUDE_CODE_AGENT`).

**Confirmation + identity (probe model).** Registration alone does not list an agent. On register the daemon sends a **probe** over the channel path (`[CLAWVIBE_PING <nonce>]` to a `clawvibe:probe:<nonce>` conversation); only a real `--channels` agent turns it into a turn and replies. The reply (like every reply) carries the agent's **name + emoji** as `reply` tool params, so the daemon **confirms liveness and learns identity from the reply** — it never reads `~/.claude/agents/<id>.md`. The app's `agents.list` shows only **confirmed** agents; identity refreshes on every reply (mid-flight changes propagate). This is the ghost guard: an agent with the plugin merely enabled but no `--channels` registers, never answers the probe, and is never listed. Removal is purely on client disconnect. (Why behavioral probing instead of detection: `--channels` is **invisible to the plugin** — spike-verified identical env vars, process args, and MCP `initialize` clientInfo/capabilities with and without it, because the supervisor strips the flag and the host keeps the channel/no-channel distinction entirely on its side. Don't re-attempt flag detection.)

**Routing:** the iOS app encodes the target agent in `sessionKey = "agent:<agentId>:clawvibe:app:<deviceId>"`. The daemon parses `<agentId>` from `chat.send`, forwards the message over IPC to that agent's client (which injects it as a turn), and routes the client's `reply` back to **only** the originating device socket, echoing the same `runId`/`sessionKey` with an incrementing `seq`. `agents.list`/`agent.identity.get` are served from the live registry. Multiple agents share the one gateway/port — this is why several agent sessions can run at once (the old monolithic `server.ts` bound `:8791` per-session, which raced and orphaned).

**The registry is keyed by `connId`, NOT `agentId`** (issue #11). `agentId` comes from `CLAUDE_CODE_AGENT`, which names the agent *type*, so every concurrent session on the default catch-all agent collides on `"claude"`. The daemon used to treat a duplicate `agentId` as a stale client and `end()` the incumbent; that client reconnected instantly, evicting the newcomer, forever — an unbounded zero-delay mutual-eviction loop (measured: 82k registers in seconds, ~5 CPU cores, GBs of heap, and — because `confirmed` reset on every re-register — a permanently empty agent list in the app). Each client now sends a `connId` that is unique per process and stable across its reconnects; several clients may share one `agentId`, and `connForAgent()`/`confirmedAgents()` resolve and dedupe. **Never reintroduce eviction on duplicate `agentId`.**

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
  Running Tailscale in-container does **not** by itself avoid this — what matters is the *form* of the serve command, wherever it runs. The `clawcrew` Coder template ran Tailscale in-container and still had the broken `--https` form (fixed 2026-07-26). Verify with `tailscale serve status --json`: you want `TCP."8791".TCPForward` + `TerminateTLS`, and **no** `Web` handlers. Watch for a config that persists in tailscaled state and looks correct, but gets clobbered on the next start by a broken line in a `startup_script`/entrypoint.
  `clawvibe setup --apply-tailscale` and `clawvibe qr` both run this check for you.
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

### Keeping agents alive #1: NEVER LET THE AGENT SETTLE

The bg daemon's reaper is `retireIfSettled` — it only ever considers **settled** sessions. A session that is **waiting for input is not a candidate at all**, pinned or not. Measured: an unpinned, never-prompted session survived 147 min (2.5× the TTL) untouched.

So the dominant factor is the agent's own end-of-turn state. Two agents on the identical seed prompt diverged:

```
state=done     detail="both replies sent to device messages"     → settled → reaped ~60 min later
state=working  detail="standing by for ClawVibe device message"  → not settled → survived
```

That coin flip is why agents seemed to die unpredictably. The prompts therefore tell the agent, in three places, that it is a **standing assignment and never a finished task** — always end a turn standing by:

- `channel-client.ts` MCP `instructions` (reaches every channel session immediately — the widest coverage, and the only one that helps agents whose `.md` predates the change);
- `cli.ts` `SEED` (applied on every `agents up` launch);
- `cli.ts` `writeAgentDef` channel block (new agent definitions only — **existing `.md` files are never overwritten**).

Treat that wording as load-bearing, not stylistic. If you reword it, keep "never finished / end standing by".

### Keeping agents alive #2: PINNING (insurance for when they do settle)

Claude Code's bg daemon sweeps every 60s and retires background sessions whose last input is older than a **60-minute TTL**. The check short-circuits in order: `attached` → `host-managed` → **`pinned`** → idle-TTL. So a **pinned session is exempt from the reaper outright**, and the same sweep additionally respawns pinned sessions that have gone stale — the runtime does keep-alive *for us*, but only for pinned ids.

`agents up` therefore pins every agent it starts (and re-pins ones already running); `agents down` **unpins** and records the agent in `$CLAWVIBE_STATE_DIR/paused.json`. Unpinning is not optional on the way down: a pinned session gets respawned by that same 60s sweep, so "stay down" is a **two-place write** (stop + unpin). `clawvibe agent list` shows pin state — `UNPINNED — will idle-stop` on a running agent is the silent failure to watch for.

- **The pin registry is the RUNTIME's file**: `~/.claude/jobs/pins.json`, a flat array of 8-hex short ids, surfaced in the UI as FleetView's `ctrl+t` "pin to top". It is **undocumented and unversioned** — the always-on behaviour is arguably a side effect of a display feature, so treat it as liable to change and never hard-fail on it. All access goes through `shared/pins.ts` (best-effort: every failure logged and swallowed; a pin failure must never abort a spawn).
- **Take the lock.** The runtime writes it under a `proper-lockfile` advisory lock (dir `pins.json.lock`, `stale: 5000`). `shared/pins.ts` mirrors that; a bare write would clobber concurrent runtime writes. Other actors keep their own pins in the same array — **always read-modify-write, never blind-overwrite**.
- **Pinning is not absolute**: under sustained memory pressure the daemon sheds pinned sessions as a last resort and the TTL collapses to 60s. A supervisor backstop is still wanted for that case — but as a *backstop*, not the primary mechanism.
- Session ids are resolved from `claude agents --json` by the stable `--name` (`clawvibe-<id>`), **never** parsed from `claude --bg` stdout — that line is undocumented and mis-parsing it makes every keep-alive tick destructively replace a live agent. A duplicate name is treated as an error, not a coin flip.
- Tests: `bun run test:pins` (foreign-entry preservation, corrupt/missing file, 12-way concurrency, live vs stale lock).

### Agent idle-stop & waking
- **Idle-stop**: Claude Code's agent-view supervisor stops an idle, unattended background session after ~1h. When that happens the channel client dies → the agent **deregisters and drops out of the app**. `install-service` (or a Coder `startup_script`) runs `agents up` only at login/boot/workspace-start, so it does **not** counter idle-stop. *(Known gap: a periodic respawn-based heal is not built yet — without it, agents go offline ~1h after their last activity until something re-launches/wakes them.)*
- **Waking (preferred over relaunch)**: `claude respawn <id>` is the **non-interactive** wake (`claude attach <id>` is the interactive one). Verified: it **keeps the same session id**, restores the session's saved `--channels` config so the client **re-registers and re-answers the probe**, and **preserves the conversation** — strictly better than a fresh `claude --bg` (blank session, new id). `claude agents --json --all` lists `stopped`/`done` sessions so a healer can find and `respawn` them.

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

- **`install-service` requires a real user systemd session — it does NOT work in most
  containers.** It writes a `systemd --user` unit, so it needs a user D-Bus session. In a
  **Coder workspace** (and `ubuntu-clawcode`) PID 1 is the supervising agent, not systemd:
  `/sbin/init` and `systemctl` exist in the image, so it *looks* supported, but
  `systemctl --user` fails and the install silently gets nowhere — the giveaway is that
  `~/.config/systemd/user/` is never created. Use the platform's own start hook instead:
  - **Coder workspace** → the template's `coder_agent.startup_script` (re-runs on every
    workspace start; with `restart = "unless-stopped"` it survives host reboots). Bound it,
    because `startup_script_behavior = "blocking"` gates workspace readiness:
    ```bash
    export PATH="$HOME/.local/bin:$PATH"   # startup_script is a non-login shell
    timeout 120 clawvibe agents up || echo "[startup] failed (is claude authenticated?)"
    ```
  - **ClawCode container** → `bin/entrypoint.sh`.
  - **A normal Linux login session** → `install-service` is correct and works.

- Managed-agent config: `$CLAWVIBE_STATE_DIR/managed-agents.json` (`[{id, model?}]`). The `.md` `name:` MUST equal the id/slug (routing/`--agent`); `--name`/`--emoji` are **baked into the prompt body** so the agent reports them on every reply (the gateway gets identity from replies, not the file).
- `clawvibe qr` runs the Tailscale ingress check first (warns on a non-TLS-TCP forward before you try to pair).
- The app's agent list = **confirmed (probe-answered) connected clients** — not the agents folder or managed-agents.json. `install-service`/`agents up` start only the agents in managed-agents.json — not every file in `~/.claude/agents/`.
- `agents up` launches each as `claude --bg --channels … --agent <id> --permission-mode acceptEdits --allowed-tools <reply tools> --name clawvibe-<id>`, **from `$HOME`** (a trusted dir — otherwise the bg session blocks on a directory-trust prompt). The first launch auto-spawns the daemon (detached via `setsid`, so it survives agent restarts).
