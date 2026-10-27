/**
 * session.tsx — chat session store: SolidJS provider, domain actions and the
 * public SessionAPI surface consumed by the components.
 *
 * This file is the composition root for the store. It owns the SolidJS store
 * and the message bus, defines the domain actions (sendPrompt, session
 * management, UI toggles, questions), wires the host-message router
 * (store/bus.tsx) to that state, and exposes the SessionContext and the
 * useSession() hook.
 *
 * The state shape and pure helpers live in store/types.ts. The store spine is
 * in `store/session/core`, the streaming core in `store/session/streaming`, the
 * action groups in `store/session/actions/*`, and the public API type in
 * `store/session/api`.
 */

import { createContext, onMount, useContext, type ParentComponent } from "solid-js"
import { createHostMessageRouter } from "./bus"
import { createSessionCore } from "./session/core"
import { createStreamingActions } from "./session/streaming"
import { createSessionActions } from "./session/actions/session"
import { createMessageActions } from "./session/actions/message"
import { createPendingActions } from "./session/actions/pending"
import type { SessionAPI } from "./session/api"

// Re-export the consumer-facing types so existing `import ... from "../store/session"`
// statements keep resolving (UiMessage & ChatNotice are used by components).
export type { AppState, ChatNotice, ChatNoticeKind, ErrorBanner, UiMessage } from "./session/api"
export type { SessionAPI } from "./session/api"

const SessionContext = createContext<SessionAPI>()

// ── Provider ────────────────────────────────────────────────────────────────

export const SessionProvider: ParentComponent = (props) => {
  const core = createSessionCore()
  const { state, bus, pending, setPending, streamRevision } = core

  const streaming = createStreamingActions(core)
  const session = createSessionActions(core)
  const message = createMessageActions(core)
  const pendingActions = createPendingActions(core)

  // ---- host message router ------------------------------------------------------
  const handleHostMessage = createHostMessageRouter({
    state,
    setState: core.setState,
    bus,
    setCurrent: core.setCurrent,
    ensureMessages: core.ensureMessages,
    mutateMessages: core.mutateMessages,
    setBusy: core.setBusy,
    pushNotice: core.pushNotice,
    appendUserMessage: core.appendUserMessage,
    applyPartUpdated: streaming.applyPartUpdated,
    removePart: streaming.removePart,
    dropEmptyAssistantMessages: streaming.dropEmptyAssistantMessages,
    loadMessagesFor: core.loadMessagesFor,
    requestUsage: core.requestUsage,
    getPending: pending,
    setPending,
    newChat: session.newChat,
    setRailOpen: session.setRailOpen,
    setSettingsOpen: session.setSettingsOpen,
    boot: core.boot,
  })

  onMount(() => {
    const unsub = bus.onMessage(handleHostMessage)
    bus.post({ type: "uiReady" })

    // Safety net: if the host never answers with `ready`, load the data anyway.
    const fallback = window.setTimeout(core.boot, 2000)

    onUnmountWindow(unsub, fallback)
  })

  const api: SessionAPI = {
    state,
    isCurrentBusy: core.isCurrentBusy,
    currentMessages: core.currentMessages,
    currentUsage: core.currentUsage,
    currentNotices: core.currentNotices,
    isCurrentCompacted: core.isCurrentCompacted,
    streamRevision,
    sessionById: core.sessionById,
    openSessions: session.openSessions,
    selectSession: session.selectSession,
    closeSession: session.closeSession,
    openSubagentSession: session.openSubagentSession,
    isSubagentSession: session.isSubagentSession,
    newChat: session.newChat,
    deleteSession: session.deleteSession,
    renameSession: session.renameSession,
    sendPrompt: message.sendPrompt,
    editMessage: message.editMessage,
    editingMessageID: core.editingMessageID,
    beginEditMessage: message.beginEditMessage,
    cancelEditMessage: message.cancelEditMessage,
    stopTurn: message.stopTurn,
    exportTranscript: session.exportTranscript,
    setRailOpen: session.setRailOpen,
    setSettingsOpen: session.setSettingsOpen,
    dismissBanner: session.dismissBanner,
    answerQuestion: pendingActions.answerQuestion,
    dismissQuestion: pendingActions.dismissQuestion,
    setDraftTokens: session.setDraftTokens,
  }

  return <SessionContext.Provider value={api}>{props.children}</SessionContext.Provider>
}

function onUnmountWindow(unsub: () => void, timer: number): void {
  const dispose = () => {
    window.clearTimeout(timer)
    unsub()
    window.removeEventListener("beforeunload", dispose)
  }
  window.addEventListener("beforeunload", dispose)
}

export function useSession(): SessionAPI {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>")
  return ctx
}
