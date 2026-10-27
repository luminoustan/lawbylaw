import { describe, expect, it } from "vitest"
import { COMPACT_MODELS, SUMMARY_MAX_CHARS, compactHistory, compactTarget, plainSpacing, transcript, type SummaryTexts } from "./compact"
import { LlmError } from "./llm"
import { PROVIDERS } from "./providers"
import type { HistoryItem } from "./messages"

const KEY = "sk-canary-compact-0123456789"

/** What a non-streaming chat completion looks like. `extra` is merged into the message. */
const completion = (text: string | null, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content: text, ...extra }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    { headers: { "content-type": "application/json" } },
  )

/** A fetch that records every request and answers with `reply`. */
function recorder(reply: () => Response) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, any> }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
    return reply()
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const turns = (n: number): HistoryItem[] =>
  Array.from({ length: n }, (_, i) => [
    { role: "user" as const, content: `question ${i}` },
    { role: "assistant" as const, content: `answer ${i}` },
  ]).flat()

/** The three prompt texts the server serves; the real ones are checked live (evals/byok-browser.e2e.mjs). */
const TEXTS: SummaryTexts = {
  summariser_system: "You never answer the user's questions.",
  summary_instruction: "SUMMARISE",
  summary_rules:
    "**Situation and goal**: x\nNo specific situation described.\n**Questions and conclusions**\n**References**\n**Open questions**\n" +
    "Do not invent or guess facts, parties, amounts, dates, statutes, section numbers or cases",
}

/** A server whose `/api/compact` records what it was asked and answers `reply`. */
function fakeServer(reply = "SERVER SUMMARY") {
  const calls: { history: { role: string; content: string }[]; summary: string | null }[] = []
  return {
    calls,
    server: {
      compact: async (history: readonly { role: string; content: string }[], summary: string | null) => {
        calls.push({ history: [...history], summary })
        return reply
      },
    },
  }
}

const ask = (over: Partial<Parameters<typeof compactHistory>[0]> & { fetchImpl?: typeof fetch } = {}) =>
  compactHistory({
    provider: PROVIDERS.nebius,
    apiKey: KEY,
    history: turns(4),
    summary: null,
    texts: TEXTS,
    server: fakeServer().server,
    signal: new AbortController().signal,
    ...over,
  })

describe("which model writes the summary", () => {
  it("is Nemotron Nano for a Nebius key, on Nebius's own origin", () => {
    const n = compactTarget(PROVIDERS.nebius)
    expect(n.provider.model).toBe("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B")
    expect(n.provider.baseUrl).toBe(PROVIDERS.nebius.baseUrl) // no new origin for the key to go to
    expect(n.label).toBe("NVIDIA Nemotron 3 Nano")
    expect(Object.keys(COMPACT_MODELS)).toEqual(["nebius"])
  })

  it("is DeepSeek's own model for a DeepSeek key, with the usual way of turning thinking off", () => {
    const d = compactTarget(PROVIDERS.deepseek)
    expect(d.provider).toBe(PROVIDERS.deepseek)
    expect(d.provider.model).toBe("deepseek-flash")
    expect(d.label).toBeNull() // the model that answers; nothing to announce
    expect(d.thinkingOff).toBeUndefined()
  })

  it("does not change the main model of the preset", () => {
    compactTarget(PROVIDERS.nebius)
    expect(PROVIDERS.nebius.model).toBe("deepseek-ai/DeepSeek-V4.1-Flash")
  })
})

describe("/compact with a DeepSeek key", () => {
  it("uses DeepSeek's own model and key, at DeepSeek's origin, with thinking off", async () => {
    const r = recorder(() => completion("DS SUMMARY"))
    const out = await ask({ provider: PROVIDERS.deepseek, fetchImpl: r.fetchImpl })
    expect(out).toEqual({ summary: "DS SUMMARY", kept: 4, summarised: 4 })
    const c = r.calls[0]!
    expect(c.url).toBe("https://api.deepseek.com/chat/completions")
    expect(c.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(c.body.model).toBe("deepseek-flash")
    expect(c.body.thinking).toEqual({ type: "disabled" })
    expect(c.body).not.toHaveProperty("chat_template_kwargs")
    expect(c.body).not.toHaveProperty("reasoning_effort")
    expect(c.body).not.toHaveProperty("tools")
    expect(c.body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"])
  })
})

describe("/compact with the shared key", () => {
  it("asks the server, sending only the older messages and the summary in force, and never calls a provider", async () => {
    const f = recorder(() => completion("never"))
    const s = fakeServer("FREE SUMMARY")
    const out = await ask({ provider: null, apiKey: "", server: s.server, fetchImpl: f.fetchImpl, summary: "OLD" })
    expect(out).toEqual({ summary: "FREE SUMMARY", kept: 4, summarised: 4 })
    expect(f.calls).toHaveLength(0)
    expect(s.calls).toEqual([{ history: turns(4).slice(0, 4), summary: "OLD" }])
  })

  it("says there is too little to summarise without calling the server", async () => {
    const s = fakeServer()
    expect(await ask({ provider: null, server: s.server, history: turns(2) })).toBeNull()
    expect(s.calls).toHaveLength(0)
  })

  it("applies the same clean-up and length cap to what the server returns", async () => {
    const spaced = await ask({ provider: null, server: fakeServer("Sale\u202fof\u202fGoods\u202fAct").server })
    expect(spaced!.summary).toBe("Sale of Goods Act")
    const big = await ask({ provider: null, server: fakeServer("x".repeat(SUMMARY_MAX_CHARS + 9)).server })
    expect([...big!.summary]).toHaveLength(SUMMARY_MAX_CHARS)
    await expect(ask({ provider: null, server: fakeServer("  ").server })).rejects.toThrow("empty summary")
  })
})

describe("compactHistory", () => {
  it("summarises all but the last turn and a half, with the compact model and the user's key", async () => {
    const r = recorder(() => completion("THE SUMMARY"))
    const out = await ask({ fetchImpl: r.fetchImpl })

    // 8 messages: the last 4 stay word for word, the first 4 are summarised
    expect(out).toEqual({ summary: "THE SUMMARY", kept: 4, summarised: 4 })
    expect(r.calls).toHaveLength(1)
    const c = r.calls[0]!
    expect(c.url).toBe("https://api.tokenfactory.nebius.com/v1/chat/completions")
    expect(c.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(c.body.model).toBe("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B")

    // a system message and ONE user message holding the conversation as a quoted transcript
    const sent = c.body.messages as { role: string; content: string }[]
    expect(sent.map((m) => m.role)).toEqual(["system", "user"])
    const task = sent[1]!.content
    expect(task).toContain("[Conversation to summarise]\nUser: question 0\n\nAssistant: answer 0\n\nUser: question 1\n\nAssistant: answer 1\n[End of conversation]")
    expect(task).not.toContain("question 2") // the latest messages are kept, not summarised
    expect(task).toContain("SUMMARISE") // the server's summary instruction, from /api/agent
  })

  it("tells the model to report only what was said, in a fixed structure", async () => {
    // Checked live: left free-form, the small model invented a situation with amounts for a chat of general
    // questions, and dropped the user's own facts when told to be brief.
    const r = recorder(() => completion("S"))
    await ask({ fetchImpl: r.fetchImpl })
    const [system, user] = (r.calls[0]!.body.messages as { content: string }[]).map((m) => m.content)
    expect(system).toBe(TEXTS.summariser_system) // the server's text, not one kept here
    expect(user).toContain(TEXTS.summary_rules)
    for (const h of ["**Situation and goal**", "**Questions and conclusions**", "**References**", "**Open questions**"]) expect(user).toContain(h)
    expect(user).toContain("No specific situation described.")
    expect(user).toMatch(/Do not invent or guess facts, parties, amounts, dates, statutes, section numbers or cases/)
    expect(user.indexOf("SUMMARISE")).toBeLessThan(user.indexOf("**Situation and goal**")) // the server's instruction comes first
  })

  it("turns thinking off with the chat-template switch, never reasoning_effort", async () => {
    // Nemotron on Nebius answers `reasoning_effort: "none"` with empty content (checked live).
    const r = recorder(() => completion("S"))
    await ask({ fetchImpl: r.fetchImpl })
    const b = r.calls[0]!.body
    expect(b.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(b).not.toHaveProperty("reasoning_effort")
    expect(b).not.toHaveProperty("thinking")
    expect(b).not.toHaveProperty("tools") // the summariser writes text only
  })

  it("folds the summary already in force into the new one", async () => {
    const r = recorder(() => completion("NEW"))
    await ask({ fetchImpl: r.fetchImpl, summary: "OLD SUMMARY" })
    const sent = r.calls[0]!.body.messages as { role: string; content: string }[]
    const holder = sent.find((m) => m.content.includes("OLD SUMMARY"))!
    expect(holder.role).toBe("user") // never gains system authority
    expect(holder.content.indexOf("OLD SUMMARY")).toBeLessThan(holder.content.indexOf("[Conversation to summarise]"))
  })

  it("says there is too little to summarise instead of calling the provider", async () => {
    const r = recorder(() => completion("never"))
    expect(await ask({ fetchImpl: r.fetchImpl, history: turns(2) })).toBeNull()
    expect(r.calls).toHaveLength(0)
  })

  it("keeps the message boundary on a user message", async () => {
    // 9 items ending on a user message: the kept part must still start on a user message
    const history = [...turns(4), { role: "user" as const, content: "latest" }]
    const out = await ask({ fetchImpl: recorder(() => completion("S")).fetchImpl, history })
    expect(history[history.length - out!.kept]!.role).toBe("user")
  })

  it("rejects an empty reply rather than storing a blank summary", async () => {
    await expect(ask({ fetchImpl: recorder(() => completion("  \n ")).fetchImpl })).rejects.toThrow("empty summary")
  })

  it("surfaces the provider's refusal as an LlmError carrying its own words", async () => {
    const f = recorder(() => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }))
    const e = await ask({ fetchImpl: f.fetchImpl }).catch((x) => x)
    expect(e).toBeInstanceOf(LlmError)
    expect(e.kind).toBe("auth")
    expect(e.message).toContain("bad key")
    expect(e.message).not.toContain(KEY)
  })

  it("does not mistake the model's reasoning for a summary", async () => {
    // What Nebius returned for Nemotron with reasoning_effort "none": content null, the reply under `reasoning`.
    const f = recorder(() => completion(null, { reasoning: "The user asked about timber..." }))
    await expect(ask({ fetchImpl: f.fetchImpl })).rejects.toThrow("empty summary")
  })

  it("asks for one whole answer, not a stream", async () => {
    const r = recorder(() => completion("S"))
    await ask({ fetchImpl: r.fetchImpl })
    expect(r.calls[0]!.body.stream).toBe(false)
  })

  it("caps the summary length", async () => {
    const out = await ask({ fetchImpl: recorder(() => completion("x".repeat(SUMMARY_MAX_CHARS + 500))).fetchImpl })
    expect([...out!.summary]).toHaveLength(SUMMARY_MAX_CHARS)
  })

  it("stops when the signal is aborted", async () => {
    const ctrl = new AbortController()
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch
    const p = ask({ fetchImpl, signal: ctrl.signal })
    ctrl.abort()
    const e = await p.catch((x) => x)
    expect(e).toBeInstanceOf(LlmError)
    expect(e.kind).toBe("aborted")
  })
})

describe("transcript", () => {
  it("quotes the turns in order, labelled, as one block", () => {
    const t = transcript([{ role: "user", content: "a" }, { role: "assistant", content: "b" }], null)
    expect(t).toBe("[Conversation to summarise]\nUser: a\n\nAssistant: b\n[End of conversation]")
  })

  it("puts an earlier summary before the turns, and ignores a blank one", () => {
    const h = [{ role: "user" as const, content: "a" }]
    expect(transcript(h, "EARLIER")).toMatch(/^\[Summary of the part of the conversation before this\]\nEARLIER\n\[End of that summary\]\n\n\[Conversation to summarise\]/)
    expect(transcript(h, "  ")).toBe(transcript(h, null))
  })
})

describe("transcript, against the server's", () => {
  it("is byte for byte what `summary_transcript` builds in server/src/routers/compact.rs (same two fixtures)", () => {
    const h = [{ role: "user" as const, content: "Q1" }, { role: "assistant" as const, content: "A1" }]
    expect(transcript(h, null)).toBe("[Conversation to summarise]\nUser: Q1\n\nAssistant: A1\n[End of conversation]")
    expect(transcript(h, "S0")).toBe(
      "[Summary of the part of the conversation before this]\nS0\n[End of that summary]\n\n[Conversation to summarise]\nUser: Q1\n\nAssistant: A1\n[End of conversation]",
    )
  })
})

describe("plainSpacing", () => {
  it("turns the typographic spaces and hyphens Nemotron writes into plain ones", () => {
    // seen live: U+202F inside Act names and citations, U+2011 inside words
    const typed = "Sale\u202fof\u202fGoods\u202fAct\u202f1979, [2021]\u202fSGHC\u202f123, six\u2011week delay"
    expect(plainSpacing(typed)).toBe("Sale of Goods Act 1979, [2021] SGHC 123, six-week delay")
  })

  it("removes zero-width characters and leaves ordinary text alone", () => {
    expect(plainSpacing("a\u200bb\ufeffc")).toBe("abc")
    expect(plainSpacing("Acme’s ss 14–16")).toBe("Acme’s ss 14–16")
  })

  it("is applied to the stored summary", async () => {
    const out = await ask({ fetchImpl: recorder(() => completion("Sale\u202fof\u202fGoods\u202fAct\u202f1979")).fetchImpl })
    expect(out!.summary).toBe("Sale of Goods Act 1979")
  })
})
