/**
 * Single source of truth for the plugin version.
 *
 * Exists because the gateway used to advertise a hardcoded version literal, which
 * silently drifted from the released plugin the first time someone bumped
 * .claude-plugin/plugin.json without touching gateway-daemon.ts. Doctor compares
 * the gateway's /health version against the installed plugin version, so that drift
 * surfaced as a permanent, unfixable "a stale daemon owns :8791" failure on healthy
 * installs — and told the operator to restart, which could never help.
 *
 * The manifest is imported (not read at runtime) so bun inlines it at bundle time:
 * dist/ therefore carries the version of the tree it was built from, and a bundle
 * that is genuinely stale still reports honestly as stale.
 */
import manifest from '../.claude-plugin/plugin.json' with { type: 'json' }

export const VERSION: string = (manifest as { version?: string }).version ?? '0.0.0'
