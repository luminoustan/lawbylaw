/**
 * bus/interaction-events.ts — host messages that need the user's attention.
 *
 * Handles `questionRequest` (the question dock) and `transcriptExported`
 * (the Markdown download).
 */

import { downloadTextFile } from "../../lib/download"
import type { QuestionRequestMsg } from "../../lib/types"
import type { RouterDeps } from "./shared"

/**
 * Handle an interaction host message. Returns true when the message was
 * consumed by this group.
 */
export function handleInteractionEvent(deps: RouterDeps, m: Record<string, unknown>): boolean {
  const { setState, setRailOpen } = deps
  const type = m.type as string

  switch (type) {
    case "questionRequest":
      setState("activeQuestion", m as unknown as QuestionRequestMsg)
      // A question needs an answer, so dismiss the history-rail drawer. While
      // it is open its full-body backdrop sits above the chat and swallows
      // clicks on the dock's options / Continue button.
      setRailOpen(false)
      return true

    case "transcriptExported": {
      const filename = (m.filename as string) || "chat-transcript.md"
      const markdown = (m.markdown as string) || ""
      downloadTextFile(filename, markdown)
      return true
    }

    default:
      return false
  }
}
