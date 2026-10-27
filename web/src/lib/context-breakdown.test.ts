import { describe, expect, it } from "vitest"
import { computeContextBreakdown } from "./context-breakdown"

/**
 * Context breakdown correctness under cache hits.
 *
 * The bug the group guards against: using the cache-MISS token count as the
 * input total made the conversation row negative whenever cache hits dominated.
 * The breakdown must be computed from the whole prompt, and every row must be
 * clamped at zero.
 */
describe("context breakdown under cache hits", () => {
  const est = { system: 993, tools: 1_240, summary: 0 }
  const opts = (used: number, extra: Partial<Parameters<typeof computeContextBreakdown>[0]> = {}) => ({
    est,
    used,
    max: 200_000,
    transcriptChars: 0,
    fallbackBudget: 200_000,
    ...extra,
  })

  it("no cache: components sum to the total prompt", () => {
    const bd = computeContextBreakdown(opts(10_000))
    expect(bd.systemPrompt + bd.toolDefinitions + bd.summarisedConversation + bd.conversation).toBe(10_000)
  })

  it("with cache hits: uses the total prompt, not the miss-only portion", () => {
    // 45k of 50k served from cache. If the breakdown used the 5k miss the
    // conversation row would collapse; it must use the full 50k.
    const bd = computeContextBreakdown(opts(50_000))
    expect(bd.conversation).toBe(50_000 - est.system - est.tools)
    expect(bd.conversation).toBeGreaterThan(0)
  })

  it("100% cache hit: conversation is large and positive, never negative", () => {
    const bd = computeContextBreakdown(opts(15_000))
    expect(bd.conversation).toBe(15_000 - est.system - est.tools)
    expect(bd.conversation).toBeGreaterThan(0)
  })

  it("tiny context: conversation clamps to 0 rather than going negative", () => {
    const bd = computeContextBreakdown(opts(500))
    expect(bd.conversation).toBe(0)
  })

  it("conversation never reports less than the transcript we actually sent", () => {
    // 3000 transcript chars ≈ 1000 tokens, more than the 267 the total leaves.
    const bd = computeContextBreakdown(opts(2_500, { transcriptChars: 3_000 }))
    expect(bd.conversation).toBe(1_000)
  })

  it("budget falls back when the server did not report a max", () => {
    expect(computeContextBreakdown(opts(1_000, { max: undefined })).budget).toBe(200_000)
    expect(computeContextBreakdown(opts(1_000, { max: 100_000 })).budget).toBe(100_000)
  })

  it("reports the subagent block as its own row, not inside the system prompt", () => {
    // The server splits the prompt: `system` excludes the sub-agent guidance
    // block, which arrives as `subagent`. Both rows must survive to the UI.
    const bd = computeContextBreakdown(opts(10_000, { est: { system: 900, tools: 1_240, summary: 0, subagent: 93 } }))
    expect(bd.systemPrompt).toBe(900)
    expect(bd.subagentDefinitions).toBe(93)
    // The subagent row is part of the fixed cost, so it is not double-counted
    // into the conversation row.
    expect(bd.conversation).toBe(10_000 - 900 - 1_240 - 93)
  })

  it("defaults the subagent row to 0 when the server omits it", () => {
    expect(computeContextBreakdown(opts(10_000)).subagentDefinitions).toBe(0)
  })
})
