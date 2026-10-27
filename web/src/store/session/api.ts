/**
 * session/api.ts — the public SessionAPI surface consumed by components.
 */

import type { SessionUsageData, WireSession } from "../../lib/types"
import type { AppState, ChatNotice, UiMessage } from "../types"

// Re-export the consumer-facing types so existing `import ... from "../store/session"`
// statements keep resolving (UiMessage & ChatNotice are used by components).
export type { AppState, ChatNotice, ChatNoticeKind, ErrorBanner, UiMessage } from "../types"

export interface SessionAPI {
  state: AppState
  isCurrentBusy(): boolean
  currentMessages(): UiMessage[]
  currentUsage(): SessionUsageData | null
  currentNotices(): ChatNotice[]
  isCurrentCompacted(): boolean
  /** Monotonic counter bumped on every streamed part update — a cheap scroll
   *  trigger that avoids rescanning the whole transcript on each token. */
  streamRevision(): number
  sessionById(id: string | null): WireSession | undefined
  openSessions(): WireSession[]
  selectSession(id: string): void
  closeSession(id: string): void
  /** Open a synthetic subagent transcript session as a chip. */
  openSubagentSession(taskId: string): void
  /** True when the id refers to a synthetic subagent session. */
  isSubagentSession(id: string | null): boolean
  newChat(): void
  deleteSession(id: string): void
  renameSession(id: string, title: string): void
  /** Send a message, or run the `/` skill the text names (e.g. `/compact`). */
  sendPrompt(text: string, displayText?: string): void
  /** Edit an existing user message and resend it, forking the turn. */
  editMessage(messageID: string, text: string, displayText?: string): void
  /** The user message currently loaded into the composer for editing, if any. */
  editingMessageID(): string | null
  /** Load a user message into the composer to edit and resend it. */
  beginEditMessage(messageID: string): void
  /** Leave edit mode without resending. */
  cancelEditMessage(): void
  stopTurn(): void
  exportTranscript(sessionID?: string): void
  setRailOpen(open: boolean): void
  setSettingsOpen(open: boolean): void
  dismissBanner(): void
  answerQuestion(answers: string[][]): void
  dismissQuestion(): void
  /** Set the estimated draft tokens for the current session composer. */
  setDraftTokens(sid: string, tokens: number): void
}
