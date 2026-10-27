/**
 * bus/context-events.ts — host messages about compaction and usage.
 *
 * Handles `contextCompressed`, `contextRingUpdate`,
 * `sessionModelUsageChanged`, and `sessionModelUsageLoaded`.
 */

import type { SessionUsageData } from "../../lib/types"
import type { RouterDeps } from "./shared"

/**
 * Handle a context/usage host message. Returns true when the message was
 * consumed by this group.
 */
export function handleContextEvent(deps: RouterDeps, m: Record<string, unknown>): boolean {
  const { state, setState, requestUsage } = deps
  const type = m.type as string

  switch (type) {
    case "contextCompressed": {
      const sid = m.sessionID as string
      if (!sid) return true
      const method = (m.method as string) ?? "none"
      const isLlmSummary = method.includes("llm-summary")

      // Mark the session as compacted so the UI shows the divider. Anything that carries a message
      // (a trim, or a `/compact` result) also says so in the chat.
      if (isLlmSummary) setState("compacted", sid, true)
      if (typeof m.message === "string" && m.message) deps.pushNotice(sid, "compressed", m.message)
      return true
    }

    case "contextRingUpdate": {
      const sid = m.sessionID as string
      if (!sid) return true
      const breakdown = m.breakdown as {
        systemPrompt: number
        toolDefinitions: number
        subagentDefinitions: number
        summarisedConversation: number
        conversation: number
        budget: number
      } | undefined
      if (!breakdown) return true
      // Store the live breakdown so ContextRing/ContextUsage can read it
      // without waiting for the turn to finish.
      setState("liveBreakdown", sid, breakdown)
      return true
    }

    case "sessionModelUsageChanged": {
      const sid = m.sessionID as string
      if (!sid) return true
      requestUsage(sid)
      return true
    }

    case "sessionModelUsageLoaded": {
      const sid = m.sessionID as string
      const requestID = m.requestID as string
      if (!sid || !requestID) return true
      if (state.usageRequest[sid] === requestID) {
        setState("usage", sid, (m.data as SessionUsageData) ?? null)
      }
      return true
    }

    default:
      return false
  }
}
