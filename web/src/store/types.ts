/**
 * types.ts — chat session state model & pure helpers for the UI store.
 *
 * This module holds ONLY the state shape, the initial state factory, and pure
 * (side-effect-free) transform helpers. There is no Solid reactivity here and
 * no host-message routing — those live in store/session.tsx (the provider +
 * domain actions) and store/bus.tsx (the host-message router).
 *
 * The in-page host (`host/web-host.ts`) is the source of truth; the store
 * mirrors the subset of session/message state the chat view needs and applies
 * every host event to per-session caches so switching sessions mid-stream
 * never loses content. The UiMessage shape is the host message normalised for
 * rendering.
 */

import type {
  QuestionRequestMsg,
  SessionUsageData,
  ToolPart,
  WireMessage,
  WirePart,
  WireSession,
  WireTokenUsage,
} from "../lib/types"

// ── In-house UI message (host message normalised for rendering) ─────────────

export interface UiMessage {
  id: string
  sessionID: string
  role: "user" | "assistant"
  createdAt: string
  time?: { created: number; completed?: number }
  parts: WirePart[]
  finish?: string
  tokens?: WireTokenUsage
  /**
   * UI-only: the turn was stopped by the user before the host persisted a
   * completion time. Such a turn has no meaningful duration, so the footer
   * shows "Stopped by user" instead of a bogus near-zero value.
   */
  interrupted?: boolean
}

export type ChatNoticeKind = "compressed"

export interface ChatNotice {
  id: string
  kind: ChatNoticeKind
  text: string
  at: number
}

export interface ErrorBanner {
  id: string
  sessionID?: string
  message: string
}

// ── State ───────────────────────────────────────────────────────────────────

export interface AppState {
  ready: boolean
  booted: boolean
  /** Host config: `limits` (server limits) and `storageWarning`. */
  config: Record<string, unknown>

  sessions: WireSession[]
  currentSessionID: string | null
  /** IDs of sessions that have been closed from the topbar chip strip (hidden, not deleted). */
  closedSessionIDs: Record<string, boolean>

  /** Synthetic sessions for subagent transcripts, keyed by task id (UI-only). */
  subagents: Record<string, WireSession>
  /** Which synthetic subagent sessions have been opened as a chip. */
  openSubagentIDs: Record<string, boolean>
  /** Maps an outer task tool-call id to its subagent session id. */
  subagentByCallID: Record<string, string>

  /** Per-session message caches (full streams, kept in background while busy). */
  messages: Record<string, UiMessage[]>
  /** Sessions whose messages were resolved by a messagesLoaded reply (or brand new). */
  loaded: Record<string, boolean>
  busy: Record<string, boolean>
  /** Per-session: the model is working on a step whose output is held back (finalization check), so the transcript shows a "Planning next moves" indicator. */
  planning: Record<string, boolean>
  usage: Record<string, SessionUsageData | null>
  usageRequest: Record<string, string>
  notices: Record<string, ChatNotice[]>
  /** Per-session flag: true when the conversation has been compacted (LLM summarised). */
  compacted: Record<string, boolean>
  /** Live context breakdown pushed during streaming (contextRingUpdate). */
  liveBreakdown: Record<string, {
    systemPrompt: number
    toolDefinitions: number
    subagentDefinitions: number
    summarisedConversation: number
    conversation: number
    budget: number
  }>
  /** Live draft token estimate from the composer input box. */
  draftTokens: Record<string, number>
  /** Per-session: user message id currently loaded into the composer for editing. */
  editingMessage: Record<string, string | null>
  loadingMessages: Record<string, boolean>

  activeQuestion: QuestionRequestMsg | null
  errorBanner: ErrorBanner | null
  railOpen: boolean
  /** The Settings overlay. */
  settingsOpen: boolean
}

/** A sendPrompt draft held while no session exists yet (awaiting sessionCreated). */
export interface PendingDraft {
  text: string
  messageID: string
}

export function loadClosedSessions(): Record<string, boolean> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("dsm_closed_sessions") : null
    if (raw) return JSON.parse(raw) as Record<string, boolean>
  } catch {}
  return {}
}

export function persistClosedSessions(closed: Record<string, boolean>): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("dsm_closed_sessions", JSON.stringify(closed))
    }
  } catch {}
}

/**
 * Persisted UI preference: whether the Chats rail is open. Defaults to closed
 * so the rail's full-body backdrop never covers the chat on first paint; the
 * user's toggle is remembered across reloads.
 */
export function loadRailOpen(): boolean {
  try {
    if (typeof localStorage !== "undefined") return localStorage.getItem("dsm_rail_open") === "1"
  } catch {}
  return false
}

export function persistRailOpen(open: boolean): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("dsm_rail_open", open ? "1" : "0")
    }
  } catch {}
}

export function initialState(): AppState {
  return {
    ready: false,
    booted: false,
    config: {},
    sessions: [],
    currentSessionID: null,
    closedSessionIDs: loadClosedSessions(),
    subagents: {},
    openSubagentIDs: {},
    subagentByCallID: {},
    messages: {},
    loaded: {},
    busy: {},
    planning: {},
    usage: {},
    usageRequest: {},
    notices: {},
    compacted: {},
    liveBreakdown: {},
    draftTokens: {},
    editingMessage: {},
    loadingMessages: {},
    activeQuestion: null,
    errorBanner: null,
    railOpen: loadRailOpen(),
    settingsOpen: false,
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

// Re-exported so store modules keep importing `cid` from here; the
// implementation lives in lib/ so host-bridge helpers can use it too.
export { cid } from "../lib/ids"

export function sortSessions(list: WireSession[]): WireSession[] {
  return [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function clonePart(p: WirePart): WirePart {
  if (p.type === "tool") {
    const tool = p as ToolPart
    return { ...tool, state: { ...tool.state } }
  }
  return { ...p }
}

export function toUiMessage(m: WireMessage): UiMessage {
  return {
    id: m.id,
    sessionID: m.sessionID,
    role: m.role,
    createdAt: m.createdAt,
    ...(m.time ? { time: { ...m.time } } : {}),
    parts: (m.parts ?? []).map(clonePart),
    ...(m.finish ? { finish: m.finish } : {}),
    ...(m.tokens ? { tokens: m.tokens } : {}),
  }
}
