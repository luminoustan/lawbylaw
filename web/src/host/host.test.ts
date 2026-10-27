import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import { buildHistory, DEFAULT_LIMITS, formatQuestionAnswers } from "./web-host"
import { readSse, StreamIdleError } from "./sse"
import { openStorage, type StoredChat } from "./storage"

const msg = (id: string, role: string, text: string, finish?: string): any => ({
  id,
  role,
  finish,
  parts: [{ type: "text", text }],
})

describe("buildHistory", () => {
  it("drops failed turns and keeps alternating order", () => {
    const h = buildHistory(
      [msg("1", "user", "a"), msg("2", "user", "b"), msg("3", "assistant", "ans"), msg("4", "user", "c")],
      DEFAULT_LIMITS,
    )
    expect(h.map((m) => m.content)).toEqual(["b", "ans", "c"])
  })
  it("caps message count and starts on a user turn", () => {
    const many = Array.from({ length: 200 }, (_, i) => msg(String(i), i % 2 ? "assistant" : "user", "x" + i))
    const h = buildHistory(many, DEFAULT_LIMITS)
    expect(h.length).toBeLessThan(DEFAULT_LIMITS.max_messages)
    expect(h[0]!.role).toBe("user")
  })
  it("truncates oversized user text to the server limit", () => {
    const h = buildHistory([msg("1", "user", "z".repeat(DEFAULT_LIMITS.message_chars + 500))], DEFAULT_LIMITS)
    expect(h[0]!.content.length).toBe(DEFAULT_LIMITS.message_chars)
  })
  it("skips errored assistant replies", () => {
    const h = buildHistory([msg("1", "user", "q"), msg("2", "assistant", "oops", "error"), msg("3", "user", "q2")], DEFAULT_LIMITS)
    expect(h.map((m) => m.role)).toEqual(["user"])
  })
})

const streamOf = (chunks: string[], hang = false) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder()
      chunks.forEach((x) => c.enqueue(enc.encode(x)))
      if (!hang) c.close()
    },
  })

describe("readSse", () => {
  it("parses split frames and ignores garbage", async () => {
    const got: unknown[] = []
    await readSse(
      streamOf(['data: {"type":"tok', 'en"}\n\n', ": keepalive\n\n", "data: not json\n\n", 'data: {"type":"done"}\n\n']),
      (d) => got.push(d),
      1000,
      new AbortController().signal,
    )
    expect(got).toEqual([{ type: "token" }, { type: "done" }])
  })
  it("raises StreamIdleError when the server goes silent", async () => {
    await expect(readSse(streamOf(["data: {}\n\n"], true), () => {}, 50, new AbortController().signal)).rejects.toBeInstanceOf(
      StreamIdleError,
    )
  })
  it("rejects oversized events", async () => {
    await expect(
      readSse(streamOf(["data: " + "a".repeat(1_200_000)]), () => {}, 1000, new AbortController().signal),
    ).rejects.toThrow()
  })
})

describe("storage", () => {
  const chat = (i: number): StoredChat => ({
    id: "c" + i,
    createdAt: new Date(i).toISOString(),
    updatedAt: new Date(i).toISOString(),
    messages: [msg("m" + i, "user", "hello")],
  })
  it("round-trips, removes and clears", async () => {
    const s = await openStorage()
    for (let i = 0; i < 5; i++) await s.save(chat(i))
    expect((await s.loadAll()).length).toBe(5)
    await s.remove("c0")
    expect((await s.loadAll()).length).toBe(4)
    await s.clear()
    expect(await s.loadAll()).toEqual([])
  })
})

import { enrichWithCitations, sanitizeCitations } from "../lib/citations"
import { buildHistoryItems } from "./web-host"

describe("citations", () => {
  const url = "https://sso.agc.gov.sg/Act/EA1893?ProvIds=pr13-"
  const cits = sanitizeCitations([
    { act_name: "Evidence Act 1893", section: "13", label: "Evidence Act 1893 s 13", url },
    { act_name: "Evil", section: "5", label: "x", url: "javascript:alert(1)" },
    { act_name: "Evil2", section: "6", label: "x", url: "https://evil.example/ (x)" },
  ])
  it("keeps only https SSO links", () => {
    expect(cits.length).toBe(1)
  })
  it("links section mentions inline once", () => {
    const out = enrichWithCitations("Under Section 13(1) of the Evidence Act 1893, facts are relevant.", cits)
    expect(out).toContain(`Section 13(1) [SSO](${url})`)
    expect(enrichWithCitations(out, cits)).toBe(out)
  })
  it("skips ambiguous sections with no nearby Act name", () => {
    const two = [...cits, { act_name: "Other Act", section: "13", label: "o", url: "https://sso.agc.gov.sg/Act/OA" }]
    expect(enrichWithCitations("See section 13 for details.", two)).toBe("See section 13 for details.")
  })
})

describe("history items for compaction", () => {
  it("returns ids so a boundary can be placed", () => {
    const items = buildHistoryItems([msg("u1", "user", "a"), msg("a1", "assistant", "b"), msg("u2", "user", "c")], DEFAULT_LIMITS)
    expect(items.map((i) => i.id)).toEqual(["u1", "a1", "u2"])
  })
})

describe("askquestion answers", () => {
  const questions = [
    { id: "amount", prompt: "How much is owed?", options: [] },
    { id: "party", prompt: "Who is the other party?", options: [] },
  ]
  it("labels each answer with its question", () => {
    expect(formatQuestionAnswers(questions, [["$5,000"], ["My landlord"]])).toBe(
      "[Answers to your questions]\n- How much is owed?: $5,000\n- Who is the other party?: My landlord",
    )
  })
  it("skips unanswered questions and returns empty when none answered", () => {
    expect(formatQuestionAnswers(questions, [[], []])).toBe("")
    expect(formatQuestionAnswers(questions, [["only this"]])).toContain("How much is owed?")
  })
  it("joins multi-select answers", () => {
    expect(formatQuestionAnswers([questions[0]!], [["a", "b"]])).toContain(": a, b")
  })
})
