/**
 * compact.ts: the `/compact` skill.
 *
 * Nothing summarises a chat on its own. `/compact` does it on demand, and the model that writes
 * the summary depends on whose key is paying:
 *
 *   - the shared key: the server's own model, through `POST /api/compact` (the browser has no key to use);
 *   - a DeepSeek key: DeepSeek's own model, the one that answers, with thinking off;
 *   - a Nebius key: a small, cheap NVIDIA model on Nebius, so a long chat can be shortened without
 *     spending the main model's tokens.
 *
 * Like the providers, the model is fixed in code: it is sent only to the base URL of the provider the
 * user already picked, with the key they already stored, so it adds no new origin.
 */

import { chat } from "./llm"
import { compactionSplit, type ApiMessage, type HistoryItem } from "./messages"
import type { Provider, ProviderId } from "./providers"
import type { ServerTools } from "./server-tools"

export interface CompactModel {
  id: string
  /** What the user is told wrote the summary. */
  label: string
  /**
   * How to turn thinking off for this model. Checked live: Nemotron on Nebius ignores the app's
   * usual `reasoning_effort: "none"` in the worst way (empty `content`, the reply in `reasoning`),
   * and honours the chat-template switch.
   */
  thinkingOff: Record<string, unknown>
}

/** A provider whose summaries come from a different model than its answers. Any other provider uses its own. */
export const COMPACT_MODELS: Readonly<Partial<Record<ProviderId, CompactModel>>> = Object.freeze({
  nebius: {
    id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B",
    label: "NVIDIA Nemotron 3 Nano",
    thinkingOff: { chat_template_kwargs: { enable_thinking: false } },
  },
})

export interface CompactTarget {
  provider: Provider
  /** The model's name when it is not the one that answers; null when it is. */
  label: string | null
  /** Overrides the provider's usual way of turning thinking off. */
  thinkingOff?: Record<string, unknown>
}

/** Where a user's own key writes the summary. */
export function compactTarget(p: Provider): CompactTarget {
  const m = COMPACT_MODELS[p.id]
  return m ? { provider: { ...p, model: m.id }, label: m.label, thinkingOff: m.thinkingOff } : { provider: p, label: null }
}

/** The prompt texts, from the server (`/api/agent`), so the shared key and a user's own key summarise alike. */
export interface SummaryTexts {
  summariser_system: string
  summary_instruction: string
  summary_rules: string
}

/** The conversation as one quoted block, so the model reports on it instead of continuing it. */
export function transcript(history: readonly HistoryItem[], prior: string | null): string {
  const lines = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
  const before = prior && prior.trim() ? `[Summary of the part of the conversation before this]\n${prior}\n[End of that summary]\n\n` : ""
  return `${before}[Conversation to summarise]\n${lines.join("\n\n")}\n[End of conversation]`
}

/** The longest summary kept (the server's `LIMIT_SUMMARY_CHARS`). */
export const SUMMARY_MAX_CHARS = 16_000

/**
 * Plain spaces and hyphens. Nemotron writes typographic ones (U+202F, U+2011) inside Act names and
 * citations; the main model would copy them into search queries and section lookups, which then
 * match nothing. Dashes and curly quotes are left alone: they never sit inside a reference.
 */
export function plainSpacing(s: string): string {
  return s.replace(/[\u00a0\u2007\u2009\u200a\u202f\u205f\u3000]/g, " ").replace(/[\u2010\u2011\u2043]/g, "-").replace(/[\u200b\u2060\ufeff]/g, "")
}

export interface Compacted {
  summary: string
  /** How many of the newest history items stay word for word. */
  kept: number
  /** How many of the oldest history items the summary replaces. */
  summarised: number
}

export interface CompactOptions {
  /** The provider of the user's own key, or null for the shared key (summarised by the server). */
  provider: Provider | null
  apiKey: string
  history: readonly HistoryItem[]
  /** The summary already in force, folded into the new one. */
  summary: string | null
  texts: SummaryTexts
  server: Pick<ServerTools, "compact">
  signal: AbortSignal
  fetchImpl?: typeof fetch
}

/**
 * Summarise everything but the last few messages. Resolves null when there is too little to
 * summarise (the caller says so); rejects with `LlmError` or `ServerToolError` when the provider
 * or server refuses, and with a plain Error when the model returns nothing.
 */
export async function compactHistory(o: CompactOptions): Promise<Compacted | null> {
  const split = compactionSplit(o.history)
  if (split === null) return null
  const old = o.history.slice(0, split)

  let reply: string
  if (o.provider === null) {
    reply = await o.server.compact(old, o.summary, o.signal)
  } else {
    const target = compactTarget(o.provider)
    const messages: ApiMessage[] = [
      { role: "system", content: o.texts.summariser_system },
      { role: "user", content: `${transcript(old, o.summary)}\n\n${o.texts.summary_instruction}\n\n${o.texts.summary_rules}` },
    ]
    const r = await chat({
      provider: target.provider,
      thinkingOff: target.thinkingOff,
      apiKey: o.apiKey,
      signal: o.signal,
      fetchImpl: o.fetchImpl,
      // No tools: the summariser writes text only.
      payload: { messages, temperature: 0.1, max_tokens: 3000 },
    })
    reply = r.content
  }
  const text = plainSpacing(reply).trim()
  if (!text) throw new Error("empty summary")
  return { summary: [...text].slice(0, SUMMARY_MAX_CHARS).join(""), kept: o.history.length - split, summarised: split }
}
