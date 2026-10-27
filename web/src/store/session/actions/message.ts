/**
 * session/actions/message.ts — sending, editing and stopping turns.
 *
 * Owns sendPrompt (which runs a `/` skill instead of sending when the text names
 * one), the edit-in-composer flow, and stopTurn.
 */

import type { WirePart } from "../../../lib/types"
import { skillFor } from "../../../lib/skills"
import { cid } from "../../types"
import type { SessionCore } from "../core"

export interface MessageActions {
  sendPrompt: (text: string, displayText?: string) => void
  editMessage: (messageID: string, text: string, displayText?: string) => void
  beginEditMessage: (messageID: string) => void
  cancelEditMessage: () => void
  stopTurn: () => void
}

export function createMessageActions(core: SessionCore): MessageActions {
  const { state, setState, bus, currentID, appendUserMessage, setBusy, mutateMessages, setPending } = core

  /**
   * `/compact` skill: ask the host to summarise the older part of this chat. It is not a message:
   * nothing is added to the transcript, and the host answers with a notice (or a banner if it fails).
   */
  function compactChat(): void {
    const sid = currentID()
    if (sid && state.busy[sid]) return
    if (!sid || !state.messages[sid]?.length) {
      setState("errorBanner", { id: cid("err"), message: "There is nothing to summarise yet. Start a conversation first." })
      return
    }
    setBusy(sid, true)
    bus.post({ type: "compactContext", sessionID: sid })
  }

  function sendPrompt(text: string, displayText?: string): void {
    // Preserve intentional trailing newlines (Shift+Enter at the end of the
    // prompt); only strip leading whitespace and trailing spaces/tabs.
    const raw = text.replace(/^\s+/, "").replace(/[ \t]+$/, "")
    // displayRaw is shown in the transcript bubble; raw (fullPrompt) goes to the API.
    const displayRaw = displayText ? displayText.replace(/^\s+/, "").replace(/[ \t]+$/, "") : raw
    if (!raw.trim()) return
    const sid = currentID()
    if (sid && state.busy[sid]) return
    // A fresh attempt clears the previous failure's banner.
    setState("errorBanner", null)

    // A `/` skill runs instead of being sent as a message.
    const skill = skillFor(raw)
    if (skill?.name === "compact") return compactChat()

    const messageID = cid("msg")

    if (sid) {
      appendUserMessage(sid, displayRaw, messageID)
      setBusy(sid, true)
    } else {
      // No session yet — the host will create one and answer with sessionCreated.
      setPending({ text: displayRaw, messageID })
    }

    bus.post({ type: "sendMessage", text: raw, messageID, sessionID: sid ?? undefined })
  }

  function beginEditMessage(messageID: string): void {
    const sid = currentID()
    // Loading the text is local and harmless while a turn runs: the composer
    // footer shows Stop until the turn closes, and sending stays gated on
    // `state.busy` in `editMessage` below.
    if (!sid) return
    setState("editingMessage", sid, messageID)
  }

  function cancelEditMessage(): void {
    const sid = currentID()
    if (sid) setState("editingMessage", sid, null)
  }

  function editMessage(messageID: string, text: string, displayText?: string): void {
    // Same edge-trim as sendPrompt: keep intentional trailing newlines.
    const raw = text.replace(/^\s+/, "").replace(/[ \t]+$/, "")
    const displayRaw = displayText ? displayText.replace(/^\s+/, "").replace(/[ \t]+$/, "") : raw
    if (!raw.trim()) return
    const sid = currentID()
    if (!sid || state.busy[sid]) return

    setState("editingMessage", sid, null)

    // Optimistic fork: replace the message text and drop every turn after it.
    // The host applies the same truncation, then streams the new reply.
    mutateMessages(sid, (list) => {
      const idx = list.findIndex((m) => m.id === messageID && m.role === "user")
      if (idx < 0) return
      const msg = list[idx]!
      const parts = msg.parts.slice()
      const textIdx = parts.findIndex((p) => p.type === "text")
      if (textIdx >= 0) {
        parts[textIdx] = { ...(parts[textIdx] as object), text: displayRaw } as WirePart
      } else {
        parts.unshift({ id: cid("part"), type: "text", messageID, text: displayRaw })
      }
      msg.parts = parts
      list.splice(idx + 1)
    })
    setBusy(sid, true)

    bus.post({
      type: "editMessage",
      sessionID: sid,
      messageID,
      text: raw,
    })
  }

  function stopTurn(): void {
    const sid = currentID()
    if (!sid || !state.busy[sid]) return
    bus.post({ type: "abort", sessionID: sid })
  }

  return {
    sendPrompt,
    editMessage,
    beginEditMessage,
    cancelEditMessage,
    stopTurn,
  }
}
