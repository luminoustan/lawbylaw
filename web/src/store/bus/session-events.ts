/**
 * bus/session-events.ts — host messages about boot, config and the session
 * list.
 *
 * Handles `ready`, `configLoaded`, and
 * `sessionsLoaded`/`sessionCreated`/`sessionUpdated`/`sessionDeleted`.
 */

import type { WireSession } from "../../lib/types"
import { persistClosedSessions, sortSessions } from "../types"
import { dropSessionCaches, type RouterDeps } from "./shared"

/**
 * Handle a session/config/provider host message. Returns true when the message
 * was consumed by this group.
 */
export function handleSessionEvent(deps: RouterDeps, m: Record<string, unknown>): boolean {
  const { state, setState, bus, setCurrent, loadMessagesFor, getPending, setPending, appendUserMessage, setBusy } = deps
  const type = m.type as string

  switch (type) {
    case "ready":
      setState("ready", true)
      deps.boot()
      return true

    case "configLoaded":
      setState("config", (m.config as Record<string, unknown>) ?? {})
      return true

    case "sessionsLoaded": {
      // Storage hands chats back in no particular order; the list is always newest activity first,
      // the same order every later update keeps it in.
      const sessions = sortSessions(((m.sessions as WireSession[]) ?? []).map((s) => ({ ...s })))
      setState("sessions", sessions)
      const wanted = state.currentSessionID
      const open = sessions.filter((s) => !state.closedSessionIDs[s.id])
      const target = wanted && sessions.some((s) => s.id === wanted)
        ? wanted
        : open[0]?.id ?? sessions[0]?.id ?? null
      setCurrent(target)
      if (target) {
        if (state.closedSessionIDs[target]) {
          const nextClosed = { ...state.closedSessionIDs, [target]: false }
          setState("closedSessionIDs", target, false)
          persistClosedSessions(nextClosed)
        }
        loadMessagesFor(target)
      } else {
        // Nothing persisted: create one right away so the chat is usable.
        bus.post({ type: "createSession" })
      }
      return true
    }

    case "sessionCreated": {
      const session = m.session as WireSession
      if (!session?.id) return true
      setState("sessions", (list) =>
        sortSessions([...list.filter((s) => s.id !== session.id), { ...session }]),
      )
      if (state.closedSessionIDs[session.id]) {
        const nextClosed = { ...state.closedSessionIDs, [session.id]: false }
        setState("closedSessionIDs", session.id, false)
        persistClosedSessions(nextClosed)
      }
      dropSessionCaches(deps, session.id)
      setState("messages", session.id, [])
      setState("loaded", session.id, true)
      setCurrent(session.id)
      // If the user hit send from the empty state, the host created the session
      // for us — replay the optimistic user message now that we know the id.
      // The host already executed the prompt, so do NOT re-post sendMessage.
      const draft = getPending()
      if (draft) {
        setPending(null)
        appendUserMessage(session.id, draft.text, draft.messageID)
        setBusy(session.id, true)
      }
      return true
    }

    case "sessionUpdated": {
      const patch = m.session as { id: string; title?: string; updatedAt?: string }
      if (!patch?.id) return true
      setState("sessions", (list) => {
        const next = list.map((s) =>
          s.id === patch.id
            ? {
                ...s,
                title: patch.title ?? s.title,
                updatedAt: patch.updatedAt ?? s.updatedAt,
              }
            : s,
        )
        return sortSessions(next)
      })
      return true
    }

    case "sessionDeleted": {
      const sid = m.sessionID as string
      setState("sessions", (list) => list.filter((s) => s.id !== sid))
      if (state.closedSessionIDs[sid]) {
        const nextClosed = { ...state.closedSessionIDs }
        delete nextClosed[sid]
        setState("closedSessionIDs", sid, false)
        persistClosedSessions(nextClosed)
      }
      dropSessionCaches(deps, sid)

      // Subagent sessions are synthetic and keyed by task id, so the generic
      // per-session cache drop above misses them. Remove the ones this parent
      // launched, or their chips linger in the top bar.
      const orphanTaskIds = new Set(
        Object.values(state.subagents)
          .filter((s) => s.parentSessionID === sid)
          .map((s) => s.id),
      )
      if (orphanTaskIds.size > 0) {
        setState("subagents", (rec) => {
          const next = { ...rec }
          for (const t of orphanTaskIds) delete next[t]
          return next
        })
        setState("openSubagentIDs", (rec) => {
          const next = { ...rec }
          for (const t of orphanTaskIds) delete next[t]
          return next
        })
        setState("subagentByCallID", (rec) => {
          const next = { ...rec }
          for (const [callId, taskId] of Object.entries(next)) {
            if (orphanTaskIds.has(taskId)) delete next[callId]
          }
          return next
        })
      }

      const current = state.currentSessionID
      if (current === sid || (current != null && orphanTaskIds.has(current))) {
        const next = sortSessions(state.sessions.filter((s) => s.id !== sid))[0]?.id ?? null
        setCurrent(next)
        if (next) loadMessagesFor(next)
        else bus.post({ type: "createSession" })
      }
      return true
    }

    default:
      return false
  }
}
