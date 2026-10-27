/**
 * bus/shared.ts — types and helpers shared by the host-message event handlers.
 *
 * The router in `store/bus.tsx` is a pure function factory: it receives the
 * store internals it needs and returns the message handler. This module holds
 * the dependency contract and the per-session cache registry that every event
 * group builds on.
 */

import type { SetStoreFunction } from "solid-js/store"
import type { MessageBus } from "../../lib/host-link"
import type { ChatNoticeKind, PendingDraft, UiMessage, AppState } from "../types"
import type { WirePart } from "../../lib/types"

/** The subset of the store that the host-message router operates on. */
export interface RouterDeps {
  state: AppState
  setState: SetStoreFunction<AppState>
  bus: MessageBus
  setCurrent: (id: string | null) => void
  ensureMessages: (sid: string) => void
  mutateMessages: (sid: string, fn: (list: UiMessage[]) => void) => void
  setBusy: (sid: string, busy: boolean) => void
  pushNotice: (sid: string, kind: ChatNoticeKind, text: string) => void
  appendUserMessage: (sid: string, text: string, messageID: string) => void
  applyPartUpdated: (
    sid: string,
    messageID: string | undefined,
    part: WirePart | undefined,
    delta: { type?: string; textDelta?: string } | undefined,
  ) => void
  removePart: (sid: string, messageID: string | undefined, partId: string | undefined) => void
  dropEmptyAssistantMessages: (sid: string) => void
  loadMessagesFor: (sid: string) => void
  requestUsage: (sid: string) => void
  getPending: () => PendingDraft | null
  setPending: (draft: PendingDraft | null) => void
  /** Load the initial data once the host is up (idempotent). */
  boot: () => void
  newChat: () => void
  setRailOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
}

/** Copy `rec` without `key` — used to drop a per-session cache entry. */
export function omitKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const next = { ...rec }
  delete next[key]
  return next
}

/**
 * Per-session caches cleared when a session is created or deleted. Kept as a
 * registry so a new cache is dropped in exactly one place.
 */
export const SESSION_CACHES = [
  "messages",
  "notices",
  "compacted",
  "liveBreakdown",
  "planning",
  "draftTokens",
] as const satisfies ReadonlyArray<keyof AppState>

/** Drop every per-session cache entry for `sid` in one place. */
export function dropSessionCaches(deps: RouterDeps, sid: string): void {
  for (const key of SESSION_CACHES) {
    // The registry is homogeneous in shape (Record<string, T>) but not in T,
    // so the per-key overload cannot be resolved generically.
    deps.setState(key as "messages", (rec) => omitKey(rec, sid))
  }
}
