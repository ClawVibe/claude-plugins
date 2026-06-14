/**
 * Config paths + device access/pairing state for the ClawVibe gateway.
 *
 * Owned and called only by the gateway daemon (single writer of access.json).
 * Side-effect-free at import time — call ensureStateDirs() from the daemon.
 */

import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ── Paths + config ───────────────────────────────────────────────────────────

export const STATE_DIR = process.env.CLAWVIBE_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'clawvibe')
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const PID_FILE = join(STATE_DIR, 'server.pid')
export const SOCK_FILE = join(STATE_DIR, 'gateway.sock')
export const PORT = Number(process.env.CLAWVIBE_PORT ?? 8791)
export const HOSTNAME = process.env.CLAWVIBE_HOSTNAME ?? '127.0.0.1'
export const TICK_INTERVAL_MS = 30_000
export const HANDSHAKE_TIMEOUT_MS = 10_000
export const ACTIVE_RUN_TTL_MS = 5 * 60 * 1000

export function ensureStateDirs(): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(APPROVED_DIR, { recursive: true, mode: 0o700 })
}

// ── Access state ─────────────────────────────────────────────────────────────

export type PendingPair = {
  device_id: string
  device_name: string
  created_at: number
  expires_at: number
}

export type ApprovedDevice = {
  device_id: string
  device_name: string
  token: string
  approved_at: number
  last_seen_at?: number
}

export type BootstrapToken = {
  created_at: number
  expires_at: number
  used: boolean
  paired_device_id?: string
  paired_device_name?: string
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  approved: Record<string, ApprovedDevice> // keyed by device_id
  pending: Record<string, PendingPair> // keyed by pairing code (5 letters)
  bootstrapTokens?: Record<string, BootstrapToken>
}

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', approved: {}, pending: {} }
}

export function readAccess(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const a = JSON.parse(raw) as Partial<Access>
    return {
      dmPolicy: a.dmPolicy ?? 'pairing',
      approved: a.approved ?? {},
      pending: a.pending ?? {},
      bootstrapTokens: a.bootstrapTokens,
    }
  } catch {
    return defaultAccess()
  }
}

export function writeAccess(a: Access): void {
  writeFileSync(ACCESS_FILE, JSON.stringify(a, null, 2))
  try { chmodSync(ACCESS_FILE, 0o600) } catch {}
}

export function newPairCode(): string {
  const alpha = 'ABCDEFGHIJKMNOPQRSTUVWXYZ'
  let s = ''
  for (const b of randomBytes(5)) s += alpha[b % alpha.length]
  return s
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function tokenToDevice(token: string): ApprovedDevice | undefined {
  if (!token) return undefined
  const a = readAccess()
  for (const d of Object.values(a.approved)) if (d.token === token) return d
  return undefined
}

export function newBootstrapToken(): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + 10 * 60 * 1000
  const a = readAccess()
  if (!a.bootstrapTokens) a.bootstrapTokens = {}
  // Prune expired tokens
  for (const [k, v] of Object.entries(a.bootstrapTokens)) {
    if (v.expires_at < Date.now()) delete a.bootstrapTokens[k]
  }
  a.bootstrapTokens[token] = { created_at: Date.now(), expires_at: expiresAt, used: false }
  writeAccess(a)
  return { token, expiresAt }
}

export function validateBootstrapToken(token: string): boolean {
  const a = readAccess()
  const bt = a.bootstrapTokens?.[token]
  if (!bt || bt.used || bt.expires_at < Date.now()) return false
  return true
}

export function consumeBootstrapToken(token: string): boolean {
  const a = readAccess()
  const bt = a.bootstrapTokens?.[token]
  if (!bt || bt.used || bt.expires_at < Date.now()) return false
  bt.used = true
  writeAccess(a)
  return true
}

/** Promote any approval sentinel files (written by the access skill) into approved devices. */
export function drainApprovalSentinels(): void {
  let names: string[] = []
  try { names = readdirSync(APPROVED_DIR) } catch { return }
  if (names.length === 0) return
  const a = readAccess()
  let changed = false
  for (const deviceId of names) {
    const code = Object.keys(a.pending).find(c => a.pending[c].device_id === deviceId)
    if (code) {
      const p = a.pending[code]
      a.approved[deviceId] = {
        device_id: deviceId,
        device_name: p.device_name,
        token: newToken(),
        approved_at: Date.now(),
      }
      delete a.pending[code]
      changed = true
    }
    try { rmSync(join(APPROVED_DIR, deviceId)) } catch {}
  }
  if (changed) writeAccess(a)
}
