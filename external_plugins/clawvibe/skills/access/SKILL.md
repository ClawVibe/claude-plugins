---
name: access
description: Approve a pending ClawVibe device pairing, change channel policy, or list approved devices. Use this when a user reports their ClawVibe iOS app is waiting for approval, when you need to revoke a device, or when checking current channel access state.
---

# ClawVibe access management

State lives in `$CLAWVIBE_STATE_DIR/access.json` (default `~/.claude/channels/clawvibe/access.json`). The server re-reads it on each check, so edits take effect without a restart.

## `pair <code>`

User scanned a QR / entered a pairing code on their ClawVibe iOS app. The server emitted a 5-letter code to stderr (you should see it in this session's logs, e.g. `clawvibe: pair request from "Brent's iPhone" — code ABCDE`).

To approve: write an empty sentinel file at `$CLAWVIBE_STATE_DIR/approved/<device_id>`. The server will pick it up on the next `/pair/status` poll from iOS, mint a device token, and move the entry from `pending` into `approved`.

```bash
STATE_DIR="${CLAWVIBE_STATE_DIR:-$HOME/.claude/channels/clawvibe}"
CODE="ABCDE"
DEVICE_ID=$(jq -r --arg c "$CODE" '.pending[$c].device_id // empty' "$STATE_DIR/access.json")
[ -n "$DEVICE_ID" ] || { echo "no pending pair for code $CODE"; exit 1; }
mkdir -p "$STATE_DIR/approved" && touch "$STATE_DIR/approved/$DEVICE_ID"
echo "approved $DEVICE_ID (code $CODE)"
```

Confirm with `jq '.approved' "$STATE_DIR/access.json"` after a few seconds.

## `policy <pairing|allowlist|disabled>`

- `pairing` (default) — new devices can request a code; still need approval.
- `allowlist` — only already-approved devices can use the channel.
- `disabled` — no new pairings; existing devices keep working.

```bash
STATE_DIR="${CLAWVIBE_STATE_DIR:-$HOME/.claude/channels/clawvibe}"
POLICY="$1"   # pairing | allowlist | disabled
jq --arg p "$POLICY" '.dmPolicy = $p' "$STATE_DIR/access.json" > "$STATE_DIR/access.json.tmp"
mv "$STATE_DIR/access.json.tmp" "$STATE_DIR/access.json"
```

## `list`

```bash
STATE_DIR="${CLAWVIBE_STATE_DIR:-$HOME/.claude/channels/clawvibe}"
jq '{policy: .dmPolicy, approved: [.approved[] | {id: .device_id, name: .device_name, last_seen: .last_seen_at}], pending: (.pending | to_entries | map({code: .key, device: .value.device_name, expires: .value.expires_at}))}' "$STATE_DIR/access.json"
```

## `revoke <device_id>`

```bash
STATE_DIR="${CLAWVIBE_STATE_DIR:-$HOME/.claude/channels/clawvibe}"
DEVICE_ID="$1"
jq --arg d "$DEVICE_ID" 'del(.approved[$d])' "$STATE_DIR/access.json" > "$STATE_DIR/access.json.tmp"
mv "$STATE_DIR/access.json.tmp" "$STATE_DIR/access.json"
echo "revoked $DEVICE_ID; next WS reconnect will be rejected"
```

## Notes

- `CLAWVIBE_STATE_DIR` must be honoured — do not hardcode `~/.claude/channels/clawvibe`. Multiple Claude Code instances on one machine use different state dirs.
- The server watches `approved/<device_id>` sentinel files on each `/pair/status` request from iOS. There is no need to signal the server otherwise.
- Device tokens are 32-byte base64url; once issued they are long-lived until revoked.
