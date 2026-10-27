/**
 * context-breakdown.ts — pure math behind the "Context Usage" popover.
 *
 * Extracted from the `context_usage` handler in host/web-host.ts so the
 * cache-sensitive part can be unit-tested without a live host.
 *
 * The server streams an estimated total (`used`, the whole prompt — system +
 * tools + summary + conversation) plus fixed estimates for the system prompt,
 * tool definitions and any summary. The conversation row is whatever the total
 * leaves after those fixed rows, clamped at zero: a cache-heavy turn reports a
 * small `used` while the transcript we actually sent can be larger, and the
 * clamp is what keeps the segment from going negative. The total must be the
 * full prompt, never the cache-miss portion, or the breakdown would collapse
 * whenever most of the prompt is a cache hit.
 */

import type { WireTokenUsage } from "./types"

export type ContextBreakdown = NonNullable<WireTokenUsage["breakdown"]>

export interface ContextBreakdownEstimate {
  system: number
  tools: number
  summary: number
  /** Sub-agent guidance block, reported separately from the system prompt. */
  subagent?: number
}

export function computeContextBreakdown(opts: {
  est: ContextBreakdownEstimate
  used: number
  max: number | undefined
  /** Characters of the transcript we sent plus the reply streamed so far. */
  transcriptChars: number
  /** Budget fallback when the server did not report one. */
  fallbackBudget: number
}): ContextBreakdown {
  const subagentDefinitions = opts.est.subagent ?? 0
  const fixed = opts.est.system + opts.est.tools + opts.est.summary + subagentDefinitions
  const fromTranscript = Math.round(opts.transcriptChars / 3)
  const conversation = Math.max(fromTranscript, Math.max(0, opts.used - fixed))
  return {
    systemPrompt: opts.est.system,
    toolDefinitions: opts.est.tools,
    subagentDefinitions,
    summarisedConversation: opts.est.summary,
    conversation,
    budget: opts.max ?? opts.fallbackBudget,
  }
}
