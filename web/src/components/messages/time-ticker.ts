/**
 * messages/time-ticker.ts — the shared "now" ticker and time helpers.
 *
 * One shared "now" ticker keeps every "<time> ago" label fresh (started once
 * from MessageList) instead of one interval per turn.
 *
 * Split out of `components/messages.tsx`; behaviour is unchanged.
 */

import { createSignal } from "solid-js"
import type { UiMessage } from "../../store/session"

export const [now, setNow] = createSignal(Date.now())

export function absoluteTime(iso: string): string {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toLocaleString() : ""
}

/** Concatenated text of a message's text parts (what "copy output" copies). */
export function messageText(m: UiMessage): string {
  return m.parts
    .filter((p) => p.type === "text")
    .map((p) => ("text" in p && typeof p.text === "string" ? p.text : ""))
    .join("\n\n")
    .trim()
}
