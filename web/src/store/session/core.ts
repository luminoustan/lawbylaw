/**
 * session/core.ts — the shared store spine for the session provider.
 *
 * Owns the SolidJS store, the message bus, the pending-draft / stream-revision
 * signals, and the low-level helpers (message mutation, optimistic append,
 * usage refresh, session loading) plus the derived current-session accessors.
 * Every action group in `session/actions/` and the streaming core build on this
 * one object so they share a single source of truth for state and the bus.

 */

import { createSignal, type Accessor } from "solid-js"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import { createMessageBus, type MessageBus } from "../../lib/host-link"
import type { SessionUsageData, WirePart, WireSession } from "../../lib/types"
import {
  type AppState,
  type ChatNotice,
  type ChatNoticeKind,
  type PendingDraft,
  type UiMessage,
  cid,
  initialState,
  persistClosedSessions,
} from "../types"

export interface SessionCore {
  state: AppState
  setState: SetStoreFunction<AppState>
  bus: MessageBus
  pending: Accessor<PendingDraft | null>
  setPending: (draft: PendingDraft | null) => void
  streamRevision: Accessor<number>
  setStreamRevision: (fn: (n: number) => number) => void

  // ---- store helpers ----
  setCurrent: (id: string | null) => void
  ensureMessages: (sid: string) => void
  mutateMessages: (sid: string, fn: (list: UiMessage[]) => void) => void
  setBusy: (sid: string, busy: boolean) => void
  pushNotice: (sid: string, kind: ChatNoticeKind, text: string) => void
  appendUserMessage: (sid: string, text: string, messageID: string) => void

  // ---- derived current-session helpers ----
  currentID: () => string | null
  isCurrentBusy: () => boolean
  currentMessages: () => UiMessage[]
  currentUsage: () => SessionUsageData | null
  currentNotices: () => ChatNotice[]
  isCurrentCompacted: () => boolean
  editingMessageID: () => string | null
  sessionById: (id: string | null) => WireSession | undefined

  // ---- boot / usage / loading ----
  boot: () => void
  requestUsage: (sid: string) => void
  loadMessagesFor: (sid: string) => void
}

export function createSessionCore(): SessionCore {
  const [state, setState] = createStore<AppState>(initialState())
  const bus = createMessageBus()
  const [pending, setPending] = createSignal<PendingDraft | null>(null)
  const [streamRevision, setStreamRevision] = createSignal(0)

  // ---- store helpers ---------------------------------------------------------
  const setCurrent = (id: string | null) => {
    setState("currentSessionID", id)
    // The banner is transient UI for the turn that raised it: a stale failure
    // must not reappear when the user navigates away and back.
    setState("errorBanner", null)
  }

  const ensureMessages = (sid: string): void => {
    if (!state.messages[sid]) setState("messages", sid, [])
  }

  const mutateMessages = (sid: string, fn: (list: UiMessage[]) => void): void => {
    ensureMessages(sid)
    setState("messages", sid, produce(fn))
  }

  const setBusy = (sid: string, busy: boolean): void => setState("busy", sid, busy)

  const pushNotice = (sid: string, kind: ChatNoticeKind, text: string): void => {
    const item: ChatNotice = { id: cid("notice"), kind, text, at: Date.now() }
    // Saying the same thing again (a second /compact with nothing new to summarise, the same trim notice on
    // every turn) replaces the earlier notice instead of stacking a copy under it.
    const earlier = (state.notices[sid] ?? []).filter((n) => n.text !== text)
    setState("notices", sid, [...earlier, item])
  }

  // ---- optimistic local helpers ---------------------------------------------
  const appendUserMessage = (sid: string, text: string, messageID: string): void => {
    mutateMessages(sid, (list) => {
      const parts: WirePart[] = [{ id: cid("part"), type: "text", messageID, text }]
      list.push({
        id: messageID,
        sessionID: sid,
        role: "user",
        createdAt: new Date().toISOString(),
        parts,
      })
    })
  }

  // ---- derived current-session helpers --------------------------------------
  const currentID = () => state.currentSessionID

  function isCurrentBusy(): boolean {
    if (pending()) return true // a no-session send is in flight awaiting sessionCreated
    const id = currentID()
    return id ? !!state.busy[id] : false
  }

  function currentMessages(): UiMessage[] {
    const id = currentID()
    return id ? state.messages[id] ?? [] : []
  }

  function currentUsage(): SessionUsageData | null {
    const id = currentID()
    return id ? state.usage[id] ?? null : null
  }

  function currentNotices(): ChatNotice[] {
    const id = currentID()
    return id ? state.notices[id] ?? [] : []
  }

  function isCurrentCompacted(): boolean {
    const id = currentID()
    return id ? state.compacted[id] ?? false : false
  }

  function editingMessageID(): string | null {
    const id = currentID()
    return id ? state.editingMessage[id] ?? null : null
  }

  const sessionById = (id: string | null): WireSession | undefined => {
    if (!id) return undefined
    return state.sessions.find((s) => s.id === id)
  }

  // ---- boot -------------------------------------------------------------------
  const boot = (): void => {
    if (state.booted) return
    setState("booted", true)
    bus.post({ type: "requestConfig" })
    bus.post({ type: "loadSessions" })
  }

  // ---- usage refresh ----------------------------------------------------------
  const requestUsage = (sid: string): void => {
    const requestID = cid("usage")
    setState("usageRequest", sid, requestID)
    bus.post({ type: "requestSessionModelUsage", sessionID: sid, requestID })
  }

  // ---- session loading --------------------------------------------------------
  const loadMessagesFor = (sid: string): void => {
    if (state.loaded[sid] || state.busy[sid] || state.loadingMessages[sid]) return
    setState("loadingMessages", sid, true)
    bus.post({ type: "loadMessages", sessionID: sid, mode: "replace" })
  }

  return {
    state,
    setState,
    bus,
    pending,
    setPending,
    streamRevision,
    setStreamRevision,
    setCurrent,
    ensureMessages,
    mutateMessages,
    setBusy,
    pushNotice,
    appendUserMessage,
    currentID,
    isCurrentBusy,
    currentMessages,
    currentUsage,
    currentNotices,
    isCurrentCompacted,
    editingMessageID,
    sessionById,
    boot,
    requestUsage,
    loadMessagesFor,
  }
}

/** Re-exported so the provider can persist the closed-session set. */
export { persistClosedSessions }
