/**
 * bus/message-events.ts — host messages about message history and turn state.
 *
 * Handles `messagesLoaded`, `messageCreated`, `partUpdated`, `sessionStatus`,
 * `sessionTurnClosed`, and `sendMessageFailed`.
 */

import type { WireMessage, WirePart, WireSession } from "../../lib/types"
import { cid, clonePart, toUiMessage } from "../types"
import type { RouterDeps } from "./shared"

/**
 * Handle a message/turn host message. Returns true when the message was
 * consumed by this group.
 */
export function handleMessageEvent(deps: RouterDeps, m: Record<string, unknown>): boolean {
  const {
    state,
    setState,
    bus,
    ensureMessages,
    mutateMessages,
    setBusy,
    applyPartUpdated,
    removePart,
    dropEmptyAssistantMessages,
    loadMessagesFor,
    requestUsage,
    setPending,
  } = deps
  const type = m.type as string

  /**
   * Register a subagent as a synthetic session. Used both when the host
   * announces a live run (`subagentStarted`) and when a reloaded session's
   * persisted transcripts arrive with `messagesLoaded`.
   */
  function registerSubagent(input: {
    taskId: string
    callId?: string
    title?: string
    subagentType?: string
    parentSessionID?: string
  }): void {
    const { taskId } = input
    if (!taskId) return
    const at = new Date().toISOString()
    const session: WireSession = {
      id: taskId,
      title: input.title || "Subagent",
      createdAt: at,
      updatedAt: at,
      synthetic: true,
      ...(input.parentSessionID ? { parentSessionID: input.parentSessionID } : {}),
      ...(input.subagentType ? { subagentType: input.subagentType } : {}),
    }
    setState("subagents", taskId, session)
    if (input.callId) setState("subagentByCallID", input.callId, taskId)
  }

  switch (type) {
    case "messagesLoaded": {
      const sid = m.sessionID as string
      if (!sid) return true
      setState("loadingMessages", sid, false)
      if (state.busy[sid]) {
        // In-flight turn: the host snapshot cannot contain the live assistant
        // message, so keep our streamed cache untouched.
        return true
      }
      const messages = ((m.messages as WireMessage[]) ?? []).map(toUiMessage)
      setState("messages", sid, messages)
      setState("loaded", sid, true)
      // Persisted subagent transcripts for this session — restores the task
      // rows' openability after a reload (see subagent-stream.ts).
      const subagents = m.subagents as Array<Record<string, unknown>> | undefined
      if (subagents && subagents.length > 0) {
        for (const s of subagents) {
          const taskId = s.taskId as string
          if (!taskId) continue
          registerSubagent({
            taskId,
            callId: s.callId as string,
            title: s.title as string,
            subagentType: s.subagentType as string,
            parentSessionID: sid,
          })
          const subMessages = ((s.messages as WireMessage[]) ?? []).map(toUiMessage)
          setState("messages", taskId, subMessages)
          setState("loaded", taskId, true)
        }
      }
      if (messages.length > 0) requestUsage(sid)
      return true
    }

    case "messageCreated": {
      const message = m.message as WireMessage
      if (!message?.id || !message.sessionID) return true
      const sid = message.sessionID
      mutateMessages(sid, (list) => {
        const idx = list.findIndex((x) => x.id === message.id)
        if (idx >= 0) {
          const existing = list[idx]!
          const incomingParts = message.parts
          if (incomingParts && incomingParts.length > 0) {
            // Final end-of-turn snapshot replaces the accumulated stream.
            list[idx] = {
              ...existing,
              parts: incomingParts.map(clonePart),
              ...(message.time ? { time: { ...message.time } } : {}),
              ...(message.finish ? { finish: message.finish } : {}),
              ...(message.tokens ? { tokens: message.tokens } : {}),
            }
          } else {
            // Turn-start shell or final empty-parts update (chat-controller
            // sends a second messageCreated with finish/tokens but NO parts
            // when the turn persisted — the UI already holds the streamed
            // parts via partUpdated, so merge the tail fields only).
            const next = { ...existing }
            if (message.time) next.time = { ...message.time }
            if (message.finish && !next.finish) next.finish = message.finish
            if (message.tokens && !next.tokens) next.tokens = message.tokens
            list[idx] = next
          }
        } else {
          list.push(toUiMessage(message))
        }
      })
      return true
    }

    case "partUpdated": {
      const sid = m.sessionID as string
      if (!sid) return true
      applyPartUpdated(
        sid,
        m.messageID as string,
        m.part as WirePart,
        m.delta as { type?: string; textDelta?: string } | undefined,
      )
      return true
    }

    case "partRemoved": {
      const sid = m.sessionID as string
      if (!sid) return true
      removePart(sid, m.messageID as string, m.partID as string)
      return true
    }

    case "subagentStarted": {
      const taskId = m.taskId as string
      if (!taskId) return true
      registerSubagent({
        taskId,
        callId: m.callId as string,
        title: m.title as string,
        subagentType: m.subagentType as string,
        parentSessionID: m.outerSessionID as string,
      })
      return true
    }

    case "subagentEnded": {
      const taskId = m.sessionID as string
      // The session may be unknown here: a reload-mid-turn defers subagent
      // ingest, and a deleted parent drops its subagents entirely.
      if (taskId && state.subagents[taskId]) {
        setState("subagents", taskId, "updatedAt", new Date().toISOString())
      }
      return true
    }

    case "sessionStatus": {
      const sid = m.sessionID as string
      if (!sid) return true
      ensureMessages(sid)
      setBusy(sid, m.status === "busy")
      return true
    }

    case "sessionPlanning": {
      const sid = m.sessionID as string
      if (!sid) return true
      setState("planning", sid, m.active === true)
      return true
    }

    case "sessionTurnClosed": {
      const sid = m.sessionID as string
      if (!sid) return true
      setBusy(sid, false)
      setState("planning", sid, false)
      // A user-stopped turn never gets a persisted completion time from the
      // host, so flag the trailing assistant message: the footer then shows
      // "Stopped by user" instead of a bogus "<1s" duration.
      if (m.reason === "interrupted") {
        mutateMessages(sid, (list) => {
          for (let i = list.length - 1; i >= 0; i--) {
            const msg = list[i]!
            if (msg.role === "assistant") {
              list[i] = { ...msg, interrupted: true }
              break
            }
          }
        })
      }
      dropEmptyAssistantMessages(sid)
      if (m.reason === "completed") requestUsage(sid)
      // A session that went busy before its history was ever loaded needs a
      // backfill now that the turn is over (e.g. a page reload mid-turn).
      if (!state.loaded[sid] && sid === state.currentSessionID) loadMessagesFor(sid)
      return true
    }

    case "sendMessageFailed": {
      setPending(null)
      if (m.sessionID) setBusy(m.sessionID as string, false)
      const sessionID = (m.sessionID as string) || undefined
      // An edit failure rolled back host-side state — resync the snapshot so
      // the optimistic local fork/truncation doesn't stick.
      if (m.edit && sessionID) {
        bus.post({ type: "loadMessages", sessionID, mode: "replace" })
      }
      setState("errorBanner", {
        id: cid("err"),
        sessionID,
        message: (m.error as string) || "The message failed to send.",
      })
      return true
    }

    default:
      return false
  }
}
