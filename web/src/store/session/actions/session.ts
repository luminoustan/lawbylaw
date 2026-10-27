/**
 * session/actions/session.ts — session lifecycle, selection and UI toggles.
 *
 * Owns session list actions (select/close/new/delete/rename), rail/settings
 * toggles, the error banner and transcript export.
 */

import type { WireSession } from "../../../lib/types"
import { persistClosedSessions, persistRailOpen } from "../../types"
import type { SessionCore } from "../core"

export interface SessionActions {
  openSessions: () => WireSession[]
  selectSession: (id: string) => void
  closeSession: (id: string) => void
  openSubagentSession: (taskId: string) => void
  isSubagentSession: (id: string | null) => boolean
  newChat: () => void
  deleteSession: (id: string) => void
  renameSession: (id: string, title: string) => void
  setDraftTokens: (sid: string, tokens: number) => void
  setRailOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  dismissBanner: () => void
  exportTranscript: (sessionID?: string) => void
}

export function createSessionActions(core: SessionCore): SessionActions {
  const { state, setState, bus, currentID, loadMessagesFor } = core

  function openSessions(): WireSession[] {
    const host = state.sessions.filter((s) => !state.closedSessionIDs[s.id])
    // Opened subagent transcripts sit directly beside the tab that launched
    // them, not at the end of the strip.
    const subs = Object.values(state.subagents).filter((s) => state.openSubagentIDs[s.id])
    const subsByParent = new Map<string, WireSession[]>()
    for (const sub of subs) {
      const parent = sub.parentSessionID ?? ""
      const list = subsByParent.get(parent)
      if (list) list.push(sub)
      else subsByParent.set(parent, [sub])
    }
    const ordered: WireSession[] = []
    const placed = new Set<string>()
    for (const s of host) {
      ordered.push(s)
      for (const child of subsByParent.get(s.id) ?? []) {
        ordered.push(child)
        placed.add(child.id)
      }
    }
    // Subagents whose parent isn't open (e.g. it was closed) trail the strip.
    for (const sub of subs) {
      if (!placed.has(sub.id)) ordered.push(sub)
    }
    return ordered
  }

  function isSubagentSession(id: string | null): boolean {
    return !!id && !!state.subagents[id]
  }

  function openSubagentSession(taskId: string): void {
    if (!state.subagents[taskId]) return
    setState("openSubagentIDs", taskId, true)
    core.setCurrent(taskId)
  }

  function selectSession(id: string): void {
    // Synthetic subagent sessions are opened, not loaded from the host.
    if (state.subagents[id]) {
      openSubagentSession(id)
      return
    }
    if (state.closedSessionIDs[id]) {
      const nextClosed = { ...state.closedSessionIDs, [id]: false }
      setState("closedSessionIDs", id, false)
      persistClosedSessions(nextClosed)
    }
    if (id === state.currentSessionID) return
    core.setCurrent(id)
    loadMessagesFor(id)
  }

  function setDraftTokens(sid: string, tokens: number): void {
    if (!sid) return
    setState("draftTokens", sid, tokens)
  }

  function closeSession(id: string): void {
    // A subagent chip is only hidden — its transcript is never deleted.
    if (state.subagents[id]) {
      setState("openSubagentIDs", id, false)
      if (state.currentSessionID === id) {
        const parent = state.subagents[id]?.parentSessionID
        const parentOpen = parent && state.sessions.some((s) => s.id === parent && !state.closedSessionIDs[parent])
        const fallback = parentOpen ? parent : openSessions()[0]?.id ?? null
        if (fallback) selectSession(fallback)
        else core.setCurrent(null)
      }
      return
    }
    const nextClosed = { ...state.closedSessionIDs, [id]: true }
    setState("closedSessionIDs", id, true)
    persistClosedSessions(nextClosed)

    // If we closed the active session, switch to another open session or clear
    if (state.currentSessionID === id) {
      const remaining = state.sessions.filter((s) => s.id !== id && !nextClosed[s.id])
      if (remaining.length > 0) {
        selectSession(remaining[0]!.id)
      } else {
        core.setCurrent(null)
      }
    }
  }

  function newChat(): void {
    bus.post({ type: "createSession" })
  }

  function deleteSession(id: string): void {
    if (state.closedSessionIDs[id]) {
      const nextClosed = { ...state.closedSessionIDs }
      delete nextClosed[id]
      setState("closedSessionIDs", id, false)
      persistClosedSessions(nextClosed)
    }
    bus.post({ type: "deleteSession", sessionID: id })
  }

  function renameSession(id: string, title: string): void {
    const clean = title.trim()
    if (!clean) return
    // Optimistic rename; the host confirms via sessionUpdated.
    setState("sessions", (list) => list.map((s) => (s.id === id ? { ...s, title: clean } : s)))
    bus.post({ type: "renameSession", sessionID: id, title: clean })
  }

  function exportTranscript(sessionID?: string): void {
    const sid = sessionID || currentID()
    if (!sid) return
    bus.post({ type: "exportSessionTranscript", sessionID: sid })
  }

  const setRailOpen = (open: boolean) => {
    setState("railOpen", open)
    persistRailOpen(open)
  }

  const setSettingsOpen = (open: boolean) => setState("settingsOpen", open)

  const dismissBanner = () => setState("errorBanner", null)

  return {
    openSessions,
    selectSession,
    closeSession,
    openSubagentSession,
    isSubagentSession,
    newChat,
    deleteSession,
    renameSession,
    setDraftTokens,
    setRailOpen,
    setSettingsOpen,
    dismissBanner,
    exportTranscript,
  }
}
