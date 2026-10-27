/**
 * session/streaming.ts — the streaming core for the session store.
 *
 * Applies streamed part updates (text deltas, tool snapshots) into the message
 * cache and drops empty assistant shells left behind by an aborted turn.
 */

import type { WirePart } from "../../lib/types"
import { clonePart } from "../types"
import type { SessionCore } from "./core"

export interface StreamingActions {
  applyPartUpdated: (
    sid: string,
    messageID: string | undefined,
    part: WirePart | undefined,
    delta: { type?: string; textDelta?: string } | undefined,
  ) => void
  /** Remove one part (a retracted answer draft or narration) from a message. */
  removePart: (sid: string, messageID: string | undefined, partId: string | undefined) => void
  dropEmptyAssistantMessages: (sid: string) => void
}

export function createStreamingActions(core: SessionCore): StreamingActions {
  const { state, mutateMessages, setStreamRevision } = core

  const applyPartUpdated = (
    sid: string,
    messageID: string | undefined,
    part: WirePart | undefined,
    delta: { type?: string; textDelta?: string } | undefined,
  ): void => {
    if (!messageID || !part) return
    mutateMessages(sid, (list) => {
      let msg = list.find((m) => m.id === messageID)
      if (!msg) {
        msg = {
          id: messageID,
          sessionID: sid,
          role: "assistant",
          createdAt: new Date().toISOString(),
          parts: [],
        }
        list.push(msg)
      }
      const idx = msg.parts.findIndex((p) => p.id === part.id)
      if (part.type === "tool") {
        // Tools arrive as full snapshots (pending → running → completed/error).
        if (idx >= 0) msg.parts[idx] = clonePart(part)
        else msg.parts.push(clonePart(part))
        return
      }
      if (delta?.type === "text-delta") {
        // The host sends INCREMENTAL text. The `part.text`
        // and `delta.textDelta` both carry only the newest chunk, so we must
        // append to any existing part with the same id .
        const chunk = delta.textDelta ?? ((part.type === "text" || part.type === "reasoning") && "text" in part ? part.text : "")
        if (idx >= 0) {
          const existing = msg.parts[idx]!
          const next = { ...existing } as { id: string; type: string; text?: string }
          msg.parts[idx] = { ...next, text: (next.text ?? "") + chunk }
        } else {
          const base = { ...part }
          msg.parts.push({ ...base, text: chunk } as WirePart)
        }
      } else {
        // Snapshot update without a delta — full replacement of that part.
        if (idx >= 0) msg.parts[idx] = clonePart(part)
        else msg.parts.push(clonePart(part))
      }
    })
    setStreamRevision((n) => n + 1)
  }

  const removePart = (sid: string, messageID: string | undefined, partId: string | undefined): void => {
    if (!messageID || !partId) return
    mutateMessages(sid, (list) => {
      const msg = list.find((m) => m.id === messageID)
      if (!msg) return
      const idx = msg.parts.findIndex((p) => p.id === partId)
      if (idx >= 0) msg.parts.splice(idx, 1)
    })
    setStreamRevision((n) => n + 1)
  }

  const dropEmptyAssistantMessages = (sid: string): void => {
    if (!state.messages[sid]) return
    mutateMessages(sid, (list) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i]!
        if (m.role === "assistant" && m.parts.length === 0 && !m.finish && !m.tokens) {
          list.splice(i, 1)
        }
      }
    })
  }

  return { applyPartUpdated, removePart, dropEmptyAssistantMessages }
}
