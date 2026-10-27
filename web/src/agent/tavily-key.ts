/**
 * tavily-key.ts: the visitor's own Tavily search key, on their machine and nowhere else.
 *
 * Same rules as the model key in `key-store.ts`: its own storage entry (never the chat database),
 * "device" = localStorage, "session" = sessionStorage, in memory if the browser blocks both. Nothing
 * here makes a network request. The settings screen only ever gets `tavilySummary()` (last four
 * characters at most), so the full key is not shown again after saving.
 */

import { cleanApiKey } from "./providers"
import type { Remember } from "./key-store"

export interface TavilySummary {
  hint: string
  remember: Remember | "memory"
}

export const TAVILY_ENTRY = "lawbylaw.tavily.v1"

let inMemory: string | null = null
const listeners = new Set<() => void>()

/** Call `fn` whenever the key is added, replaced or removed. Returns the way to stop. */
export function onTavilyChange(fn: () => void): () => void {
  listeners.add(fn)
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
    return null
  }
}

function read(kind: Remember): string | null {
  try {
    const raw = area(kind)?.getItem(TAVILY_ENTRY)
    if (!raw) return null
    const cleaned = cleanApiKey(raw)
    return cleaned.ok ? cleaned.key : null
  } catch {
    return null
  }
}

/** The saved key, if any. Read once per turn, so removing it takes effect on the next message. */
export function loadTavily(): string | null {
  return read("session") ?? read("device") ?? inMemory
}

export function tavilySummary(): TavilySummary | null {
  const where: Remember | "memory" | null = read("session") ? "session" : read("device") ? "device" : inMemory ? "memory" : null
  const key = loadTavily()
  if (!key || !where) return null
  return { hint: key.length >= 16 ? key.slice(-4) : "", remember: where }
}

export type SaveResult = { ok: true; keptIn: Remember | "memory" } | { ok: false; reason: string }

/** Validate and store a pasted key, replacing any earlier one. */
export function saveTavily(raw: string, remember: Remember): SaveResult {
  const cleaned = cleanApiKey(raw)
  if (!cleaned.ok) return { ok: false, reason: cleaned.reason }
  wipe()
  let kept: Remember | "memory" = remember
  try {
    const a = area(remember)
    if (!a) throw new Error("blocked")
    a.setItem(TAVILY_ENTRY, cleaned.key)
  } catch {
    inMemory = cleaned.key
    kept = "memory"
  }
  notify()
  return { ok: true, keptIn: kept }
}

/** Remove the key from every place it could be. */
export function clearTavily(): void {
  wipe()
  notify()
}

function wipe(): void {
  inMemory = null
  for (const kind of ["device", "session"] as const) {
    try {
      area(kind)?.removeItem(TAVILY_ENTRY)
    } catch {
      /* nothing to remove */
    }
  }
}
