/**
 * key-store.ts: where the user's own provider key lives, on their machine and nowhere else.
 *
 * - Its own storage entry, apart from the chat database, so no chat, export or backup can carry it.
 * - "device": `localStorage` (survives closing the browser). "session": `sessionStorage` (gone when
 *   the tab closes). If the browser blocks both, the key is held in memory for this page only.
 * - Never sent to this app's server: nothing here makes a network request, and the only reader
 *   outside the settings screen is `loadByok`, which the host hands to the provider call.
 * - The interface gets `byokSummary()` (settings screen) and `keyStatus()` (the badge in the chat box),
 *   which carry the last four characters at most, so the full key is never put on screen again after
 *   it is saved.
 *
 * Honest limit: anything running on this page (a malicious browser extension, or an XSS bug here)
 * can read browser storage. The CSP in `server/src/security_headers.rs` is the defence against the
 * latter; the former is why "session only" exists.
 */

import { cleanApiKey, isProviderId, PROVIDERS, type ProviderId } from "./providers"

export type Remember = "device" | "session"

export interface StoredKey {
  provider: ProviderId
  key: string
}

export interface KeySummary {
  provider: ProviderId
  /** Last four characters when the key is long enough that this reveals nothing useful, else "". */
  hint: string
  remember: Remember | "memory"
}

/** Storage entry name. Versioned so a future format can coexist. */
export const KEY_ENTRY = "lawbylaw.byok.v1"

let inMemory: StoredKey | null = null

// Whoever shows which key is in use (the badge in the chat box) hears about every change, including
// one made in another tab, so what is on screen is always what the next message will use.
const listeners = new Set<() => void>()
let watching = false

/** Call `fn` whenever the saved key is added, replaced or removed. Returns the way to stop. */
export function onKeyChange(fn: () => void): () => void {
  listeners.add(fn)
  if (!watching && typeof window !== "undefined") {
    watching = true
    // Fires in other tabs when localStorage changes (or is cleared: key is null).
    window.addEventListener("storage", (e) => {
      if (e.key === null || e.key === KEY_ENTRY) notify()
    })
  }
  return () => void listeners.delete(fn)
}

function notify(): void {
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      /* one listener must not stop the others */
    }
  }
}

function area(kind: Remember): Storage | null {
  try {
    return kind === "device" ? window.localStorage : window.sessionStorage
  } catch {
    return null // blocked by the browser
  }
}

function parse(raw: string | null): StoredKey | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { provider?: unknown; key?: unknown }
    if (!isProviderId(v.provider) || typeof v.key !== "string") return null
    const cleaned = cleanApiKey(v.key)
    return cleaned.ok ? { provider: v.provider, key: cleaned.key } : null
  } catch {
    return null
  }
}

function read(kind: Remember): StoredKey | null {
  try {
    return parse(area(kind)?.getItem(KEY_ENTRY) ?? null)
  } catch {
    return null
  }
}

/** The saved key, if any. Called once per turn, so removing it takes effect on the next message. */
export function loadByok(): StoredKey | null {
  return read("session") ?? read("device") ?? inMemory
}

export function byokSummary(): KeySummary | null {
  const where: Remember | "memory" | null = read("session") ? "session" : read("device") ? "device" : inMemory ? "memory" : null
  const k = loadByok()
  if (!k || !where) return null
  return { provider: k.provider, hint: k.key.length >= 16 ? k.key.slice(-4) : "", remember: where }
}

export type SaveResult = { ok: true; keptIn: Remember | "memory" } | { ok: false; reason: string }

/** Validate and store a pasted key, replacing any earlier one. */
export function saveByok(provider: ProviderId, raw: string, remember: Remember): SaveResult {
  if (!isProviderId(provider)) return { ok: false, reason: "Choose a provider." }
  const cleaned = cleanApiKey(raw)
  if (!cleaned.ok) return { ok: false, reason: cleaned.reason }
  wipe()
  const entry = JSON.stringify({ provider, key: cleaned.key })
  let kept: Remember | "memory" = remember
  try {
    const a = area(remember)
    if (!a) throw new Error("blocked")
    a.setItem(KEY_ENTRY, entry)
  } catch {
    inMemory = { provider, key: cleaned.key }
    kept = "memory"
  }
  notify()
  return { ok: true, keptIn: kept }
}

/** Remove the key from every place it could be. */
export function clearByok(): void {
  wipe()
  notify()
}

function wipe(): void {
  inMemory = null
  for (const kind of ["device", "session"] as const) {
    try {
      area(kind)?.removeItem(KEY_ENTRY)
    } catch {
      /* nothing to remove */
    }
  }
}

export interface KeyStatus {
  /** True when replies are written with the visitor's own key, false for the site owner's shared key. */
  own: boolean
  /** Short text for the badge in the chat box. */
  label: string
  /** The fuller explanation, shown as the tooltip. */
  detail: string
}

/**
 * Which key the next message will be written with. This is the same test the host applies when a turn
 * starts (a saved key means the visitor's own), so the badge cannot say one thing and do another.
 */
export function keyStatus(saved: KeySummary | null): KeyStatus {
  if (!saved) {
    return {
      own: false,
      label: "Free shared key",
      detail:
        "Replies are written with the site owner's shared key, within the limits in Settings. " +
        "Open Settings to use your own key instead.",
    }
  }
  const name = PROVIDERS[saved.provider].label
  const tail = saved.hint ? ` (ends ${saved.hint})` : ""
  const where =
    saved.remember === "device" ? "kept on this device" : saved.remember === "session" ? "kept until you close this tab" : "kept in memory until you reload"
  return {
    own: true,
    label: `Your own key · ${name}`,
    detail: `Replies are written with your ${name} key${tail}, ${where}. Your browser talks to ${name} directly; this site never receives the key.`,
  }
}
