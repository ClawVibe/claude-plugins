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
│   ├── skills/{connect,access,setup}/  # pair a device; manage access; install/troubleshoot
│   ├── gateway-daemon.ts           # shared HTTP/WS gateway daemon (Bun): owns :8791, pairing, agent registry, IPC server
│   ├── channel-client.ts           # per-session MCP server (`start`): connects to daemon over IPC, registers its agent
│   ├── cli.ts                      # automation CLI: setup / agent add|rm|list / agents up|down / install-service
│   ├── shared/{protocol,access}.ts  # wire+IPC types & sessionKey parser; config+pairing
│   ├── hooks/{hooks.json,reply-guard.ts}  # Stop hook: block a channel turn that never called `reply`
│   ├── test/{storm-regression,run-keying,outbox}.ts  # regression checks: `bun run test:storm` / `test:runs` / `test:outbox`
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

**Confirmation + identity (probe model).** Registration alone does not list an agent. On register the daemon sends a **probe** over the channel path (`[CLAWVIBE_PING <nonce>]` to a `clawvibe:probe:<nonce>` conversation); only a real `--channels` agent turns it into a turn and replies. The reply (like every reply) carries the agent's **name + emoji** as `reply` tool params, so the daemon **confirms liveness and learns identity from the reply** — it never reads `~/.claude/agents/<id>.md`. Since issue #25, confirmation is **not** what makes an agent reachable — a **live client connection** is. `confirmed` only breaks ties between connections sharing an agentId and supplies a real display name; identity still refreshes on every reply (mid-flight changes propagate). The probe raced session boot: `agents up` starts every agent at once, each is probed while still booting, misses it, and the retry ladder then gave up permanently — leaving connected agents listed as "(no channel)" pin rows for the life of the session. (Since v0.1.7 `agents.list` also shows pinned live sessions, marked unreachable — see "Pinned sessions in the agent list" below.) This was the ghost guard: an agent with the plugin merely enabled but no `--channels` registers, never answers the probe, and used to be hidden from the list. **Tradeoff, deliberately accepted in #25:** such a ghost is now listed as reachable and will swallow messages until the 5-minute `activeRuns` TTL aborts the run, instead of being hidden. A timeout on an agent you asked for beats silently refusing to try — which is what stranded four real, `--channels`-launched agents for a day. Removal is purely on client disconnect. (Why behavioral probing instead of detection: `--channels` is **invisible to the plugin** — spike-verified identical env vars, process args, and MCP `initialize` clientInfo/capabilities with and without it, because the supervisor strips the flag and the host keeps the channel/no-channel distinction entirely on its side. Don't re-attempt flag detection.)

**Routing:** the iOS app encodes the target agent in `sessionKey = "agent:<agentId>:clawvibe:app:<deviceId>"`. The daemon parses `<agentId>` from `chat.send`, forwards the message over IPC to that agent's client (which injects it as a turn), and routes the client's `reply` back to **only** the originating device socket, echoing the same `runId`/`sessionKey` with an incrementing `seq`. `agents.list`/`agent.identity.get` are served from the live registry. Multiple agents share the one gateway/port — this is why several agent sessions can run at once (the old monolithic `server.ts` bound `:8791` per-session, which raced and orphaned).

**The registry is keyed by `connId`, NOT `agentId`** (issue #11). `agentId` comes from `CLAUDE_CODE_AGENT`, which names the agent *type*, so every concurrent session on the default catch-all agent collides on `"claude"`. The daemon used to treat a duplicate `agentId` as a stale client and `end()` the incumbent; that client reconnected instantly, evicting the newcomer, forever — an unbounded zero-delay mutual-eviction loop (measured: 82k registers in seconds, ~5 CPU cores, GBs of heap, and — because `confirmed` reset on every re-register — a permanently empty agent list in the app). Each client now sends a `connId` that is unique per process and stable across its reconnects; several clients may share one `agentId`, and `connForAgent()`/`reachableAgents()` resolve and dedupe. **Never reintroduce eviction on duplicate `agentId`.**

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

### The per-device outbox (#23)

A chat event that reached no live socket used to be counted and destroyed — the entire
failure handling was `broadcast event=chat sent=0`. `handleConnect` sent a snapshot with no
pending messages, so reconnecting recovered nothing. That is the wifi-to-cellular handoff on
a moving vehicle, and it made the loss **permanent rather than delayed**. Confirmed in the
wild: the daemon log, the agent's transcript showing it had answered, and `sent=0` for the
frame nobody received.

`broadcastEvent` now retains instead of dropping: when `sent === 0` on a **targeted chat**
event, the payload goes into a per-device queue and is replayed in `handleConnect` **after
`hello_ok`** (the app needs its session before a replayed event means anything).

- **Targeted chat events only.** An untargeted broadcast has no device to replay to, and
  ticks/presence are worthless late.
- **Replays are byte-identical**, so they keep their original `(runId, seq)` and the client
  can dedupe. That is only safe because seq no longer restarts at 0 within a run — **#24 is a
  hard prerequisite, not a nicety.**
- **Bounded twice over**: `OUTBOX_MAX` (200) drops the *oldest* first, and `OUTBOX_TTL_MS`
  (5 min) expires the rest on the tick. A phone that never comes back must not be able to
  leak the daemon's heap.
- **The queue is drained on flush**, not re-sent on every reconnect.

**Server-side ping/pong is part of the same fix, not a bonus.** `reapDeadSockets` only
inspects `readyState`, and a half-open socket reports `1` — so the daemon logged `sent=1` for
a frame that reached nobody and the outbox would never engage for the very case it exists
for. The tick now pings every device socket and closes any that has not ponged in 2.5 ticks
(`lastPong`, a WeakMap so closed sockets need no cleanup). Note the failure direction: a
false positive here disconnects a *working* phone every 30s, so the regression asserts that a
healthy socket survives many ticks untouched.

*Not done, deliberately:* the outbox is in memory only, so a daemon restart still loses it,
and there is no client ack — the queue is trimmed by TTL and cap rather than by delivery
confirmation. Both are follow-ups (see the ack issue); neither is needed for the reconnect
case this fixes. `chat.history` is still unimplemented, so the app's calls to it still return
`unknown method` — that is the other half of recovery and remains open.

Tests: `bun run test:outbox` — replay on reconnect, original runId preserved, cap keeps the
newest, TTL expiry, drain-once, and no false pong eviction. Verified to **fail on the #24
branch** (6 of 11) and pass here.

### Run bookkeeping: `activeRuns` is keyed by runId, `runSeq` outlives its run

Both halves of this are load-bearing and were both wrong before #24.

**`activeRuns` is keyed by `runId`, never by `sessionKey`.** Keyed by sessionKey, a second
`chat.send` on the same conversation overwrote the first entry, and the orphaned run then
received **no chat event ever** — not `final`, not `error`, and not even the `aborted` safety
net, because `pruneActiveRuns` can only abort entries still in the map. A client holding
per-run pending state spins on it forever. A `sessionKey -> Set<runId>` index (`runsBySession`)
supplies "the newest open run on this conversation" for replies that carry no `runId` and for
every `edit`, so lookups still work without making the run map itself lossy.

**Superseded runs are deliberately NOT aborted eagerly.** The issue proposed emitting a
terminal event for a run superseded on the same sessionKey. Once runs are keyed by `runId`
that is unnecessary and actively harmful: Claude Code folds a second message into the same
turn, so the earlier run may still legitimately reply. Both runs stay open, and the existing
TTL prune is the safety net for whichever never finishes.

**`runSeq` is NOT deleted on a terminal state.** It used to be, which reset the counter, so a
second reply in the same run went out as `seq: 0` again — protocol-invalid duplicate sequence
numbers, and any client deduping on `(runId, seq)` silently discarded the second and later
bubbles. Entries now carry a timestamp and expire on the same TTL as runs, which also stops
the map growing without bound. **This is a prerequisite for the per-device outbox (#23)**,
which is only safe if the client can dedupe replays on `(runId, seq)`.

`ACTIVE_RUN_TTL_MS` and `TICK_INTERVAL_MS` are env-overridable (`CLAWVIBE_ACTIVE_RUN_TTL_MS`,
`CLAWVIBE_TICK_INTERVAL_MS`) purely so the regression can watch the abort net fire in seconds
instead of five minutes. Production never sets them.

Tests: `bun run test:runs` — drives a real daemon + client over the real wire. Verified to
**fail on main** (duplicate `seq: [0,0]`, and the superseded run missing from the aborted set)
and pass on the fix.

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

### Pinned sessions in the agent list (v0.1.7)

`agents.list` / `GET /agents` returns **connected clients ∪ (pins.json ∩ live sessions)**. The intersection is load-bearing, not hygiene — **neither input is an agent list on its own**:

- **Pins outlive their sessions.** When the reaper takes a session hard, the job dir *and* the session record go with it, but the pin stays. Observed on `bikini-bottom`: 2 of 4 pins (`1718f4de`, `a123a3f8`) were the corpses of spongebob and patrick. Nothing ever removes them, so `pins.json` only grows. Dead pins are **dropped from the list, never deleted from the file** — it is the runtime's file and other actors keep their own entries in that array.
- **`~/.claude/jobs/` is not sessions either.** Subagent scratch dirs live there too (a bare `tmp/`, no `state.json`) and are not background agents. Only `claude agents --json --all` distinguishes a real live session.

Key mechanics:
- **`jobId` is the join key.** Background sessions run with `$CLAUDE_JOB_DIR=~/.claude/jobs/<8-hex>`, and that `<8-hex>` is exactly the pins.json key. The client reports it on `register`; without it the daemon cannot tell "this connected client IS that pinned session" from "that pinned session has no client". Verified present in the MCP subprocess env via `/proc/<pid>/environ`.
- **Pin-only rows are listed but NOT reachable**, with `reachable: false` and a ` (no channel)` name suffix. A pinned session without `--channels` has no way to turn an inbound into a turn — that is structural (see the probe model above), not a bug to code around. The suffix exists because the app has no concept of an offline agent and would otherwise show a row that silently swallows every message. **A row is pin-only when no client is CONNECTED for that job id — not when the client hasn't answered a probe (issue #25).** Note the app never reads `reachable`: `AgentSummary` in the iOS app doesn't decode the field, so the suffix is the only visible signal, and nothing app-side blocks a send to such a row.
- **Connected rows keep `agentId` as their id**, so session keys already stored on paired devices (`agent:spongebob:…`) keep routing. Pin-only rows are keyed by job id because every generic bg job reports `agentId` `"claude"` and they would otherwise collapse into one row; clients reporting that generic id are excluded from the connected list for the same reason. Routing resolves agentId first, then job id, and **neither path requires `confirmed` any more (issue #25)** — it used to, which refused delivery to agents that were launched with `--channels` and had merely missed their boot-time probe.
- **Never resolve the roster in an RPC handler** — it costs a subprocess spawn. The daemon keeps a snapshot refreshed on the 30s tick (plus a 5s-throttled kick from `agents.list`); handlers stay synchronous. If `claude` isn't on the daemon's PATH (likely in the container), the roster is empty and the list degrades to connected-clients-only — the pre-0.1.7 behaviour.
- Tests: `bun run test:update` (installer safety), `bun run test:listing`, and `bun run test:reachability` (end-to-end: a client that registers and never answers its probe must still be listed reachable by agentId — issue #25). Note `test:storm` asserts only on `reachable` rows, because `pins.json` is the real machine's file and is deliberately **not** redirected by `CLAWVIBE_STATE_DIR`.

*Known gap:* nothing sweeps a pin when its session dies, so corpses accumulate. Harmless now that the list intersects with the live roster, but `pins.json` grows unbounded.

### Keeping agents alive #3: THE REPLY GUARD (Stop hook)

An agent can generate a perfectly good reply **into its transcript** and never call
`mcp__plugin_clawvibe_clawvibe__reply` / `mcp__plugin_telegram_telegram__reply`. The device
gets nothing and the agent believes it answered — observed repeatedly on SpongeBob. Both the
MCP `instructions` and the agent prompt already say "calling reply is mandatory"; prompt
discipline does not hold on its own, so `hooks/reply-guard.ts` is the mechanical backstop.

It ships as a **plugin hook** (`hooks/hooks.json`, `Stop` event, invoked as
`bun "${CLAUDE_PLUGIN_ROOT}/hooks/reply-guard.ts"`), so it deploys with `clawvibe update`
to every box and needs no `settings.json` entry.

How it decides:
- **The most recent PROMPT, not the most recent user record.** Tool results are also
  `type: "user"`; a prompt's `message.content` is a plain **string**, a tool result's is a
  block array. Getting this wrong makes the hook blind on any turn that used a tool.
- **Channel turns only**, keyed on `origin.kind === "channel"` (`origin.server` names the
  plugin). Intercom-woken and interactive CLI turns have no device waiting and are exempt.
  Liveness probes (`clawvibe:probe:*`) are deliberately **in** scope — they must reply.
- **Matching is per-CHANNEL, never per-conversation_id** (`/^mcp__(plugin_.+?)__(reply|edit_message)$/`;
  group 1 is the MCP server, and `origin.server`'s colons map to underscores). One inbound may
  legitimately be answered across several conversations on the same channel, and `edit_message`
  is a legitimate way to answer, so id equality produces false positives. Sidechain (subagent)
  records never count.
- **Answering on the WRONG channel is also blocked (#47).** An agent paired to both ClawVibe
  and Telegram can answer a Telegram message into the app; the guard used to see *a* reply
  tool and allow it, and the sender still got silence. It now blocks when the **originating**
  channel got nothing. Fan-out stays legal — replying there *and* elsewhere passes — and an
  unrecognised `origin.server` stays lenient. This hook catches silence; it does not police
  fan-out.
- On a miss it prints `{"decision":"block","reason":...}`, which the host feeds back to the
  model so the turn continues and the agent actually sends.

**Loop safety is load-bearing.** `stop_hook_active` is true when we are already inside a
blocked stop; the hook then records the miss to `$CLAWVIBE_STATE_DIR/reply-guard.log` and
exits 0. An unconditional block is an infinite loop that burns tokens forever. (The host
also caps consecutive Stop blocks at 8, overridable via `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` —
do not rely on that as the primary guard.)

**Every failure path exits 0.** An unparseable payload, a missing transcript, a half-written
trailing JSONL line — none of them may break a turn. A hook that can wedge the fleet is
worse than the bug it fixes.

**A block is not a delivery guarantee.** `reply` is fire-and-forget and returns "sent" after
the IPC write, so this catches "never called the tool", not "the call was dropped" (see the
outbox and ack issues). There is also no way for an agent to declare "this inbound needed no
reply"; if we ever want that it needs an explicit escape hatch, not a guess by the hook.

Tests: `bun run test:guard` — runs the real hook as a subprocess against synthetic
transcripts (miss, replied, edit_message, wrong-channel, both-channels, telegram origin,
other-conversation, unknown server, human, intercom, loop, tool_result, probe, sidechain,
unreadable transcript).

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
clawvibe agents up | down | restart  # start (idempotent) / stop all clawvibe-* sessions / full recycle
clawvibe doctor                      # one-shot diagnostic: PATH, bun, gateway version, ingress, agents
clawvibe tailscale-check             # ingress form only
clawvibe agent list                  # configured + running/registered status
clawvibe install-service             # systemd --user unit running `agents up` at login/boot
clawvibe update [--ref R] [--build] [--no-restart] [--force]   # install from GitHub, no in-app plugin flow
```

- **`update` is a from-scratch reimplementation of Claude's in-app plugin update**, for
  headless boxes and for iterating without the UI. It refreshes the marketplace clone,
  exports `external_plugins/clawvibe` at the chosen ref with `git archive`, drops it in
  `~/.claude/plugins/cache/clawvibe-plugins/clawvibe/<version>/`, records it in
  `installed_plugins.json`, relinks `~/.local/bin/clawvibe`, then restarts the agents.
  Three things worth knowing:
  - It installs **committed files only** (`git archive`, not a copy of the working tree),
    so a stray local edit can never end up in an install.
  - It reinstalls when the version number matches but the **commit** doesn't — the exact
    case a version bump would otherwise paper over. `--force` also overrides an identical
    commit, and is the only way past a dirty marketplace clone (which is refused, since a
    hard reset would eat uncommitted work).
  - The final `agents restart` is run by the **newly installed** bin, not the one you
    invoked. `agents restart` verifies the running gateway against the plugin *its own*
    CLI came from, so the old binary would check the version it just replaced and report a
    mismatch that isn't real.
  - **It never deletes the live install before the replacement is known-good.** The
    destination is usually the directory the running daemon and every agent client are
    executing from, so the export goes to a `.incoming-<pid>` sibling, gets verified
    (`dist/channel-client.js`, `dist/gateway-daemon.js`, `bin/clawvibe`), and is then
    swapped in with two `rename`s. A failed download or build leaves the previous install
    untouched. Regression test: `bun run test:update`.
  - The manifest version becomes a directory name that later gets `rmSync`'d, so it is
    validated against `/^[A-Za-z0-9][A-Za-z0-9._+-]*$/` first — a version containing `..`
    or `/` would otherwise escape the cache.
  - `installed_plugins.json` is read-modify-written under `shared/filelock.ts` — the same
    directory-lock discipline `pins.ts` uses for `pins.json` — because Claude Code's
    in-app flow writes that file too and a lost write uninstalls an unrelated plugin.
    `pins.ts` uses the same module (consolidated in 0.1.9). The whole command also holds a lock, so two concurrent updates can't
    interleave `fetch`/`checkout` in one working tree.
  - A failed `git fetch` is a warning, not an error: reinstalling an already-fetched ref
    while offline is legitimate, and an genuinely missing ref fails more clearly below.
  `dist/` is committed, so no build happens by default; `--build` rebuilds it in place and
  then deletes the resulting `node_modules` (the bundle inlines the SDK, so nothing at
  runtime reads it).
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

- Managed-agent config: `$CLAWVIBE_STATE_DIR/managed-agents.json` (`[{id, model?, channels?}]`). `channels` lists EXTRA channel servers the agent listens on (e.g. `"plugin:telegram@claude-plugins-official"`); they are appended to the variadic `--channels` flag after the mandatory ClawVibe server. The CLI only registers `notifications/claude/channel` pushes for servers named in `--channels`, so an agent paired on another channel that is not listed here drops every inbound message (outbound reply tools keep working, which hides the fault). The `.md` `name:` MUST equal the id/slug (routing/`--agent`); `--name`/`--emoji` are **baked into the prompt body** so the agent reports them on every reply (the gateway gets identity from replies, not the file).
- `clawvibe qr` runs the Tailscale ingress check first (warns on a non-TLS-TCP forward before you try to pair).
- The app's agent list = **connected clients** (probe-answered or not, since issue #25), plus pinned live sessions marked unreachable (v0.1.7) — not the agents folder or managed-agents.json. `install-service`/`agents up` start only the agents in managed-agents.json — not every file in `~/.claude/agents/`.
- `agents up` launches each as `claude --bg --channels … --agent <id> --permission-mode auto --allowed-tools <reply tools> --name clawvibe-<id>`, **from `$HOME`** (a trusted dir — otherwise the bg session blocks on a directory-trust prompt). The first launch auto-spawns the daemon (detached via `setsid`, so it survives agent restarts).
- **Upgrading the plugin needs `agents restart`, not `down` + `up`.** The daemon deliberately **lingers** across agent restarts, and it is a singleton guarded by the port — so a *newer* daemon `exit(0)`s on `EADDRINUSE` rather than taking over. After `claude plugin update`, `agents down && agents up` therefore reattaches the new clients to the **old daemon bundle**, and `/health` keeps reporting the previous version. `agents restart` does down → SIGTERM the daemon from `server.pid` → **confirm `:8791` is actually free** (SIGKILL fallback) → up, then verifies the version now serving matches the plugin the CLI came from and exits non-zero on a mismatch. Beware two decoys when diagnosing this by hand: a `--permission-mode [a-z]+` regex silently truncates `acceptEdits` to `accept`, and process cmdlines don't show an agent's launch flags (the launcher exits after handoff) — read `respawnFlags` in `~/.claude/jobs/<id>/state.json` instead, which is also what `claude respawn` replays.
- **`--permission-mode auto`, not `acceptEdits`** — a channel agent is unattended, so there is nobody to answer a permission prompt. Valid modes on 2.1.220: `acceptEdits | auto | bypassPermissions | manual | dontAsk | plan`. **Validate any launch-flag change against the CLI before shipping** — an invalid flag makes every spawn fail silently, and with a keep-alive loop that becomes a fork bomb.
