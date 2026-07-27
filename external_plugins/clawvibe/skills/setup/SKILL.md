---
name: setup
description: Install, upgrade, or troubleshoot the ClawVibe channel on this machine — the `clawvibe` command not being found, the iOS app pairing but not connecting (code 1006), agents missing from the app's picker, agents dying after about an hour, or a plugin upgrade that didn't take effect. Use for anything about getting ClawVibe working. Do NOT use to generate a pairing QR (use the connect skill) or to approve/revoke a paired device (use the access skill).
---

# ClawVibe setup & troubleshooting

**Always start by running `clawvibe doctor`.** It checks every failure this plugin
produces in the field, each of which is silent on its own, and prints a `fix:` line under
anything wrong. Read its output before doing anything else.

If `clawvibe` itself is not found, see "Fresh install" below — that is the bootstrap
problem, not a broken install.

```bash
clawvibe doctor          # full diagnostic; exit 1 if something is broken
clawvibe agent list      # per-agent running / registered / pinned
clawvibe tailscale-check # ingress only
```

## Fresh install: `zsh: command not found: clawvibe`

Installing the plugin unpacks it into a **version-keyed cache**; nothing puts `clawvibe`
on `PATH`. The symlink is created by `clawvibe setup` — which you cannot run yet. Break
the cycle by invoking the cache path directly, once:

```bash
"$(ls -d ~/.claude/plugins/cache/clawvibe-plugins/clawvibe/*/ | sort -V | tail -1)bin/clawvibe" setup
```

Inside a Claude Code session, `$CLAUDE_PLUGIN_ROOT/bin/clawvibe setup` is equivalent.

If `ls` reports no matches, the plugin is not installed for this user — run
`/plugin install clawvibe@clawvibe-plugins` first. Installs are per home directory, so a
new machine, container, or workspace needs its own.

If `clawvibe` is still not found after `setup` succeeds, `~/.local/bin` is not on `PATH`
(common in zsh, which does not read `~/.profile` in interactive shells):

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && exec zsh
```

Then: `clawvibe agent add <id> --name "Name" --emoji 🤖`, `clawvibe agents up`,
`clawvibe qr`.

## App pairs, then disconnects (WebSocket code 1006)

The Tailscale ingress is an `--https` **web proxy**, which serves HTTP/2 and breaks
WebSocket upgrades. It must be a TLS-terminated **TCP** forward so HTTP/1.1 survives
end to end (the app still uses `wss://`):

```bash
clawvibe setup --apply-tailscale     # does both commands below
# or manually:
sudo tailscale serve --https=8791 off
sudo tailscale serve --bg --tls-terminated-tcp=8791 tcp://localhost:8791
```

Verify: `tailscale serve status --json` → `TCP."8791".TCPForward` **and** `TerminateTLS`
set, with **no** `Web` handlers. Beware: the serve config persists in tailscaled state, so
a hand-fixed config can be clobbered on the next boot by a broken line in a startup
script or container entrypoint. Fix it at the source too.

## Agent missing from the app's picker

The app lists only **confirmed** agents — ones that answered a liveness probe by calling
`reply`. `clawvibe agent list` distinguishes the cases:

- **not running** → `clawvibe agents up`
- **running, NOT registered** → it is not a `--channels` session, or it has not answered
  its probe yet (allow ~20s). Check the org allowlist permits `clawvibe@clawvibe-plugins`.
- **running, UNPINNED** → it works now but will be reaped; `clawvibe agents restart`

## Agents die after about an hour

Two independent causes:

1. **The agent settled.** Claude Code's background daemon reaps sessions it considers
   *settled* after a ~60-minute idle TTL; a session **waiting for input is never a
   candidate**. An agent that ends a turn reporting its work complete becomes reapable.
   Check `state` in `~/.claude/jobs/<id>/state.json`: `working` + "standing by" is safe,
   `done` is not. v0.1.2+ instructs agents to always end standing by.
2. **Not pinned.** Pinning (`~/.claude/jobs/pins.json`) is a hard exemption checked
   *before* the TTL, and covers the settled case. `agents up` pins automatically;
   `agent list` shows pin state.

## An upgrade didn't take effect

`agents down && agents up` does **not** pick up a new version. The gateway daemon lingers
by design and is a singleton guarded by the port, so a newer daemon exits rather than
taking over — the new clients reattach to the old bundle and `/health` keeps reporting the
old version. Use:

```bash
claude plugin update clawvibe@clawvibe-plugins
clawvibe agents restart      # down → stop daemon → confirm port free → up → verify version
```

`doctor` flags this as `gateway serving X but Y is installed`. If the CLI itself is stale
(e.g. `agents restart` is missing), repoint the symlink first — see "Fresh install".

## Notes for diagnosing by hand

- `respawnFlags` in `~/.claude/jobs/<id>/state.json` is the authoritative record of an
  agent's launch flags, and is what `claude respawn` replays. **Process cmdlines are not**
  — the launcher exits after handoff, so anything you match is stale.
- `--permission-mode [a-z]+` truncates `acceptEdits` to `accept`. Channel agents should
  run `auto` (unattended: nobody is there to answer a prompt).
- Gateway state lives in `$CLAWVIBE_STATE_DIR` (default `~/.claude/channels/clawvibe/`).
  Daemon stderr is currently discarded, so there is no gateway log to read.
