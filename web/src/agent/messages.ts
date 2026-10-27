/**
 * messages.ts: the deterministic parts of context handling, ported from the server
 * (`deepseek.rs` and `routers/chat.rs`) so the browser loop budgets context the same way.
 *
 * Sizes are estimates, deliberately conservative: legal text tokenises densely, and
 * underestimating causes HTTP 400s. The estimate counts UTF-8 bytes like the server does.
 */

export interface ApiMessage {
  role: "system" | "user" | "assistant" | "tool"
  content?: string | null
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

export interface HistoryItem {
  role: "user" | "assistant"
  content: string
}

/** UTF-8 length of a string, without allocating. */
export function utf8Len(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4 // a surrogate pair is one 4-byte code point
      i++
    } else n += 3
  }
  return n
}

/** About 2 bytes per token: see the server's `estimate_tokens`. */
export function estimateTokens(messages: readonly ApiMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (typeof m.content === "string") chars += utf8Len(m.content)
    for (const tc of m.tool_calls ?? []) chars += utf8Len(tc.function.arguments) + utf8Len(tc.function.name)
  }
  return Math.floor(chars / 2)
}

/** Characters per token for the display rows of the context breakdown (prose, not statute text). */
export const DISPLAY_CHARS_PER_TOKEN = 4

export const displayTokens = (s: string): number => Math.floor(utf8Len(s) / DISPLAY_CHARS_PER_TOKEN)

export function estimateToolsTokens(tools: readonly unknown[]): number {
  return tools.length === 0 ? 0 : Math.floor(utf8Len(JSON.stringify(tools)) / DISPLAY_CHARS_PER_TOKEN)
}

/** (system prompt row, sub-agent block row). The two always sum to the whole prompt estimate. */
export function splitSystemPromptTokens(systemPrompt: string, subagentBlock: string): [number, number] {
  const without = subagentBlock ? systemPrompt.split(subagentBlock).join("") : systemPrompt
  const systemOnly = displayTokens(without)
  return [systemOnly, displayTokens(systemPrompt) - systemOnly]
}

/** Drop the oldest middle messages until the rest fits; keeps the head and the tail. */
export function truncateMessagesToFit(messages: readonly ApiMessage[], maxTokens: number): ApiMessage[] {
  if (messages.length <= 5 || estimateTokens(messages) <= maxTokens) return [...messages]

  const headCount = Math.min(2, messages.length)
  const head = messages.slice(0, headCount)
  const tailCount = Math.max(1, Math.min(4, messages.length - headCount))
  const tailStart = messages.length - tailCount
  const tail = messages.slice(tailStart)
  const middle = messages.slice(headCount, tailStart)

  while (middle.length > 0) {
    if (estimateTokens(head) + estimateTokens(middle) + estimateTokens(tail) <= maxTokens) break
    const dropped = middle.shift()!
    // A dropped tool call takes its results with it, or the conversation is invalid.
    if (dropped.role === "assistant" && dropped.tool_calls) {
      while (middle.length > 0 && middle[0]!.role === "tool") middle.shift()
    }
  }

  let result = [...head, ...middle, ...tail]
  if (estimateTokens(result) > maxTokens && result.length > 2) result = [result[0]!, result[result.length - 1]!]
  return result
}

/**
 * Index splitting `history` into (to summarise, to keep verbatim): the last few messages stay and
 * the kept part always starts on a user message. `null` if there is too little to summarise.
 */
export function compactionSplit(history: readonly HistoryItem[]): number | null {
  const KEEP = 4
  if (history.length < KEEP + 2) return null
  let idx = history.length - KEEP
  while (idx > 0 && history[idx]!.role !== "user") idx--
  return idx === 0 ? null : idx
}

/** Drop the oldest turns until under `cap`; returns a notice for the user if anything was dropped. */
export function trimToCap(messages: ApiMessage[], cap: number): { messages: ApiMessage[]; notice: string | null } {
  if (estimateTokens(messages) <= cap) return { messages, notice: null }
  const trimmed = truncateMessagesToFit(messages, cap)
  return {
    messages: trimmed,
    notice:
      trimmed.length < messages.length
        ? "Older messages were trimmed to fit the context window. Start a new chat for best results."
        : null,
  }
}

/** System prompt, the Act list, an optional summary of earlier turns, then the conversation. */
export function buildApiMessages(opts: {
  systemPrompt: string
  actsContext: string | null
  summary: string | null
  history: readonly HistoryItem[]
}): ApiMessage[] {
  const out: ApiMessage[] = [{ role: "system", content: opts.systemPrompt }]
  if (opts.actsContext) out.push({ role: "system", content: opts.actsContext })
  if (opts.summary && opts.summary.trim()) {
    // User-role on purpose: the summary is held by the client, so it must never gain system authority.
    out.push({
      role: "user",
      content: `[Summary of the earlier part of this conversation]\n${opts.summary}\n[End of summary. The conversation continues below.]`,
    })
  }
  for (const m of opts.history) {
    const msg: ApiMessage = { role: m.role }
    if (m.content) msg.content = m.content
    out.push(msg)
  }
  return out
}

/** True when the reply is just the OK sentinel (tolerating case, quotes, backticks, asterisks, a period). */
export function isOkReply(text: string, sentinel = "OK"): boolean {
  const t = text.trim().replace(/^[`"'*.\s]+|[`"'*.\s]+$/g, "")
  return t.toLowerCase() === sentinel.toLowerCase()
}

/** Whether the first final answer is held for one verification pass (see the server's `should_check`). */
export function shouldCheck(opts: {
  enabled: boolean
  nudgesUsed: number
  toolSteps: number
  wasPending: boolean
  maxNudges: number
  skipAfterToolSteps: number
}): boolean {
  return (
    opts.wasPending ||
    (opts.enabled && opts.nudgesUsed < opts.maxNudges && opts.toolSteps >= 1 && opts.toolSteps < opts.skipAfterToolSteps)
  )
}

/** Append the tool nudge to the last tool-role message. No-op if there is none. */
export function attachToolNudge(messages: ApiMessage[], note: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== "tool") continue
    const wrapped = `<system-reminder>\n${note}\n</system-reminder>`
    m.content = m.content ? `${m.content}\n\n${wrapped}` : wrapped
    return
  }
}
