import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_LIMITS, WebHost } from "./web-host"
import { openStorage } from "./storage"
import type { ProviderId } from "../agent/providers"

/**
 * `/compact` through the real host: the older part of a chat is summarised, stored with the chat, and
 * reported in the chat as a notice. Which model writes it depends on the key: Nemotron on Nebius with a
 * Nebius key, DeepSeek's own model with a DeepSeek key, the server's model (`/api/compact`) on the shared key.
 */

type Emitted = Record<string, any>
const KEY = "sk-canary-compact-host-0123456789"

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })

const bundle = {
  mode: "legislation",
  system_prompt: "SYSTEM",
  acts_context: null,
  tools: [],
  agent_tools: {},
  subagents: {},
  params: {
    temperature: 0.3, top_p: 0.9, max_output_tokens: 1000, subagent_max_output_tokens: 1000, output_reserve_tokens: 8192,
    context_window_size: 200000, rag_context_fill_ratio: 0.8, rag_context_budget: 8000, sub_agent_context_budget: 60000,
    rag_search_hard_cap: 6, finalization_check: true, tool_nudge: true, max_nudges: 1, skip_check_after_tool_steps: 5,
    revision_min_chars: 16, max_web_searches: 4, max_orchestrator_reads: 10, context_tokens: 180000,
    model_window: 200000, message_chars: 200000, max_messages: 200, request_timeout_s: 60,
  },
  texts: {
    tool_nudge: "", finalization_nudge: "Check the draft answer above.", finalization_ok: "OK", forced_final: "{n}",
    sub_forced_final: "{n}", sub_forced_final_suffix: "", summariser_system: "SUMMARISER", summary_instruction: "SUMMARISE", summary_rules: "RULES", subagent_definitions: "",
  },
}

const sse = (text: string) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } })}\n\n` +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )

/** The compact model is called without streaming, so it answers with one JSON completion. */
const completion = (text: string) =>
  json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })

/** A realistic answer: long enough that a short summary of it is a real saving. */
const LONG_ANSWER = "The court weighed the contract terms, the notice given and the conduct of both sides. ".repeat(12)

interface Call { url: string; init: RequestInit; body: Record<string, any> }

/** A call to a provider that is the summariser (it opens with the summariser's role), not the assistant answering. */
const isSummary = (body: Record<string, any>) => body.messages?.[0]?.content === bundle.texts.summariser_system

function harness(opts: { provider?: ProviderId | null; answer?: string; summarise?: (init: RequestInit, n: number) => Response | Promise<Response>; serverSummary?: string } = {}) {
  const events: Emitted[] = []
  const own: { url: string; body?: Record<string, any> }[] = []
  const calls: Call[] = []
  let summaries = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.startsWith("https://")) {
      const body = JSON.parse(String(init!.body))
      calls.push({ url: u, init: init!, body })
      // the summariser writes a summary; anything else is the ordinary assistant answering
      if (isSummary(body)) return (opts.summarise ?? (() => completion("THE SUMMARY")))(init!, ++summaries)
      return sse(opts.answer ?? LONG_ANSWER)
    }
    own.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (u.endsWith("/api/compact")) return json({ summary: opts.serverSummary ?? "SERVER SUMMARY" })
    if (u.endsWith("/api/limits")) return json(DEFAULT_LIMITS)
    if (u.startsWith("/api/agent")) return json(bundle)
    if (u.endsWith("/api/links")) return json({ citations: [] })
    return json({}, 404)
  }) as unknown as typeof fetch
  let provider: ProviderId | null = opts.provider === undefined ? "nebius" : opts.provider
  const host = new WebHost((m) => events.push(m as Emitted), {
    fetchImpl,
    getByok: () => (provider ? { provider, key: KEY } : null),
  })
  /** Switch whose key is in use, as a user does in Settings. (A shared-key chat is the server's, so these chats are built with a key first.) */
  const useKey = (p: ProviderId | null) => (provider = p)
  const of = (t: string) => events.filter((e) => e.type === t)
  const compactCalls = () => calls.filter((c) => isSummary(c.body))
  const sid = () => of("messageCreated")[0]!.message.sessionID as string
  /** n finished question/answer turns, all in one chat (these need a key, so Nebius is used). */
  const chat = async (n: number) => {
    for (let i = 0; i < n; i++) await host.handle({ type: "sendMessage", sessionID: i ? sid() : undefined, text: `question ${i}`, messageID: `m${i}` })
    return sid()
  }
  return { host, events, own, calls, of, compactCalls, sid, chat, useKey }
}

beforeEach(async () => {
  await (await openStorage()).clear()
})

const notices = (h: ReturnType<typeof harness>) => h.of("contextCompressed").filter((e) => e.message).map((e) => String(e.message))

describe("/compact", () => {
  it("summarises the older messages with the Nemotron model and the user's key", async () => {
    const h = harness()
    const sid = await h.chat(4)
    const before = h.of("messageCreated").length
    const ringsBefore = h.of("contextRingUpdate").length

    await h.host.handle({ type: "compactContext", sessionID: sid })

    // one call to the compact model, with the user's key, to Nebius only
    expect(h.compactCalls()).toHaveLength(1)
    const c = h.compactCalls()[0]!
    expect(c.url).toBe("https://api.tokenfactory.nebius.com/v1/chat/completions")
    expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    expect(c.body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(c.body).not.toHaveProperty("reasoning_effort")
    const sent = (c.body.messages as { content: string }[]).map((m) => m.content).join("\n")
    expect(sent).toContain("User: question 0")
    expect(sent).toContain("SUMMARISE") // the server's summary instruction, from /api/agent
    expect(sent).not.toContain("question 3") // the latest messages are kept, not summarised

    // the result: a stored summary, the divider, a smaller ring and a notice, and no new message
    const stored = (await (await openStorage()).loadAll()).find((x) => x.id === sid)!
    expect(stored.compaction!.summary).toBe("THE SUMMARY")
    const kept = stored.messages.slice(stored.messages.findIndex((m) => m.id === stored.compaction!.afterId))
    expect(kept).toHaveLength(4)
    expect(kept[0]!.role).toBe("user")
    expect(h.of("contextCompressed").some((e) => e.method === "llm-summary")).toBe(true)
    expect(h.of("contextRingUpdate")).toHaveLength(ringsBefore + 1)
    expect(h.of("messageCreated")).toHaveLength(before) // /compact is not a message
    expect(notices(h).at(-1)).toMatch(/Summarised the earlier 4 messages with NVIDIA Nemotron 3 Nano; the latest 4 are kept/)
    expect(notices(h).at(-1)).toMatch(/Context: about .* → .* tokens/)
    expect(h.of("sessionTurnClosed").at(-1)).toMatchObject({ sessionID: sid, reason: "completed" })

    // the key reached the provider and nothing else
    expect(JSON.stringify(h.own)).not.toContain(KEY)
    expect(JSON.stringify(h.events)).not.toContain(KEY)
    expect(JSON.stringify(await (await openStorage()).loadAll())).not.toContain(KEY)
  })

  it("is used by the next question: the summary replaces what it covers", async () => {
    const h = harness()
    const sid = await h.chat(4)
    await h.host.handle({ type: "compactContext", sessionID: sid })
    await h.host.handle({ type: "sendMessage", sessionID: sid, text: "follow-up", messageID: "m9" })

    const main = h.calls.filter((c) => !isSummary(c.body)).at(-1)!
    const sent = (main.body.messages as { role: string; content: string }[]).map((m) => m.content).join("\n")
    expect(sent).toContain("[Summary of the earlier part of this conversation]\nTHE SUMMARY")
    expect(sent).not.toContain("question 0") // covered by the summary
    expect(sent).toContain("question 3") // kept word for word
    expect(sent).toContain("follow-up")
  })

  it("folds an earlier summary into the next one", async () => {
    const h = harness({ summarise: (_i, n) => completion(`SUMMARY ${n}`) })
    const sid = await h.chat(4)
    await h.host.handle({ type: "compactContext", sessionID: sid })
    for (let i = 4; i < 7; i++) await h.host.handle({ type: "sendMessage", sessionID: sid, text: `question ${i}`, messageID: `m${i}` })
    await h.host.handle({ type: "compactContext", sessionID: sid })

    const second = h.compactCalls()[1]!
    expect((second.body.messages as { content: string }[]).map((m) => m.content).join("\n")).toContain("SUMMARY 1")
    const stored = (await (await openStorage()).loadAll()).find((x) => x.id === sid)!
    expect(stored.compaction!.summary).toBe("SUMMARY 2")
  })

  it("keeps the chat as it is when the summary would not make it any shorter", async () => {
    // short answers, long summary: storing it would grow the context
    const h = harness({ answer: "Yes.", summarise: () => completion("A long summary. ".repeat(300)) })
    const sid = await h.chat(4)
    const rings = h.of("contextRingUpdate").length
    await h.host.handle({ type: "compactContext", sessionID: sid })

    expect(h.compactCalls()).toHaveLength(1)
    expect(notices(h).at(-1)).toMatch(/wouldn't make this conversation any shorter yet, so nothing was changed/)
    expect(h.of("contextCompressed").some((e) => e.method === "llm-summary")).toBe(false) // no divider
    expect(h.of("contextRingUpdate")).toHaveLength(rings)
    expect(h.of("sendMessageFailed")).toEqual([])
    expect(h.of("sessionTurnClosed").at(-1)).toMatchObject({ reason: "completed" })
    expect((await (await openStorage()).loadAll()).find((x) => x.id === sid)!.compaction).toBeUndefined()
  })

  it("says so when there is too little to summarise, and calls nothing", async () => {
    const h = harness()
    const sid = await h.chat(1)
    await h.host.handle({ type: "compactContext", sessionID: sid })

    expect(h.compactCalls()).toHaveLength(0)
    expect(notices(h).at(-1)).toMatch(/isn't enough conversation to summarise yet/)
    expect(h.of("sessionTurnClosed").at(-1)).toMatchObject({ reason: "completed" })
    expect((await (await openStorage()).loadAll())[0]!.compaction).toBeUndefined()
  })

  it("with a DeepSeek key, uses DeepSeek's own model and says nothing about another one", async () => {
    const h = harness({ provider: "deepseek" })
    const sid = await h.chat(4)
    await h.host.handle({ type: "compactContext", sessionID: sid })

    expect(h.compactCalls()).toHaveLength(1)
    const c = h.compactCalls()[0]!
    expect(c.url).toBe("https://api.deepseek.com/chat/completions")
    expect(c.body.model).toBe("deepseek-flash")
    expect(c.body.thinking).toEqual({ type: "disabled" })
    expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    expect(h.calls.every((x) => x.url.startsWith("https://api.deepseek.com/"))).toBe(true) // the key went nowhere else
    const stored = (await (await openStorage()).loadAll()).find((x) => x.id === sid)!
    expect(stored.compaction!.summary).toBe("THE SUMMARY")
    expect(notices(h).at(-1)).toMatch(/^Summarised the earlier 4 messages; the latest 4 are kept/)
    expect(JSON.stringify(h.events)).not.toContain(KEY)
  })

  it("on the shared key, the server's model summarises: only the older messages are sent, to our own server", async () => {
    const h = harness({ serverSummary: "SHARED SUMMARY" })
    const sid = await h.chat(4)
    h.useKey(null)
    const providerCalls = h.calls.length
    await h.host.handle({ type: "compactContext", sessionID: sid })

    expect(h.calls).toHaveLength(providerCalls) // no provider is called from the browser
    const ask = h.own.filter((c) => c.url.endsWith("/api/compact"))
    expect(ask).toHaveLength(1)
    expect(Object.keys(ask[0]!.body!).sort()).toEqual(["history"]) // the server builds the prompt; the page sends the chat, nothing else
    const sent = (ask[0]!.body!.history as { role: string; content: string }[]).map((m) => m.content).join("\n")
    expect(sent).toContain("question 0")
    expect(sent).not.toContain("question 3") // the latest messages are kept, not summarised

    const stored = (await (await openStorage()).loadAll()).find((x) => x.id === sid)!
    expect(stored.compaction!.summary).toBe("SHARED SUMMARY")
    expect(notices(h).at(-1)).toMatch(/^Summarised the earlier 4 messages; the latest 4 are kept/)
    expect(h.of("sessionTurnClosed").at(-1)).toMatchObject({ sessionID: sid, reason: "completed" })
  })

  it("on the shared key, folds the summary already in force into the next request", async () => {
    const h = harness({ serverSummary: "SHARED 1" })
    const sid = await h.chat(4)
    h.useKey(null)
    await h.host.handle({ type: "compactContext", sessionID: sid })
    h.useKey("nebius")
    for (let i = 4; i < 7; i++) await h.host.handle({ type: "sendMessage", sessionID: sid, text: `question ${i}`, messageID: `m${i}` })
    h.useKey(null)
    await h.host.handle({ type: "compactContext", sessionID: sid })

    const asks = h.own.filter((c) => c.url.endsWith("/api/compact"))
    expect(asks[1]!.body!.summary).toBe("SHARED 1")
  })

  it("on the shared key, shows the server's own words when it refuses, and changes nothing", async () => {
    const h = harness()
    const sid = await h.chat(4)
    h.useKey(null)
    const f = (h.host as any).fetchImpl as typeof fetch
    ;(h.host as any).fetchImpl = (async (u: string, i?: RequestInit) =>
      String(u).endsWith("/api/compact")
        ? json({ error: { code: "rate_limited", message: "You're sending messages too quickly. Please wait 5s and try again." } }, 429)
        : f(u, i)) as typeof fetch
    await h.host.handle({ type: "compactContext", sessionID: sid })

    expect(String(h.of("sendMessageFailed").at(-1)!.error)).toMatch(/too quickly\. Please wait 5s/)
    expect(h.of("sessionTurnClosed").at(-1)).toMatchObject({ reason: "error" })
    expect((await (await openStorage()).loadAll()).find((x) => x.id === sid)!.compaction).toBeUndefined()
  })

  it("closes the busy state for a chat that no longer exists", async () => {
    const h = harness()
    await h.host.handle({ type: "compactContext", sessionID: "gone" })
    expect(h.of("sessionTurnClosed")).toEqual([{ type: "sessionTurnClosed", sessionID: "gone", reason: "completed" }])
    expect(h.calls).toHaveLength(0)
  })

  it("shows the provider's own words when it refuses, and changes nothing", async () => {
    const h = harness({ summarise: () => new Response(JSON.stringify({ error: { message: "key revoked" } }), { status: 401 }) })
    const sid = await h.chat(4)
    await h.host.handle({ type: "compactContext", sessionID: sid })

    const failed = h.of("sendMessageFailed").at(-1)!
    expect(String(failed.error)).toMatch(/Nebius rejected your API key/)
    expect(String(failed.error)).toContain("key revoked")
    expect(JSON.stringify(h.events)).not.toContain(KEY)
    expect(h.of("sessionTurnClosed").at(-1)).toMatchObject({ reason: "error" })
    expect(h.of("contextCompressed").some((e) => e.method === "llm-summary")).toBe(false)
    expect((await (await openStorage()).loadAll()).find((x) => x.id === sid)!.compaction).toBeUndefined()
  })

  it("does not keep a blank summary", async () => {
    const h = harness({ summarise: () => completion("   ") })
    const sid = await h.chat(4)
    await h.host.handle({ type: "compactContext", sessionID: sid })

    expect(String(h.of("sendMessageFailed").at(-1)!.error)).toMatch(/NVIDIA Nemotron 3 Nano returned an empty summary/)
    expect((await (await openStorage()).loadAll()).find((x) => x.id === sid)!.compaction).toBeUndefined()
  })

  it("can be stopped: nothing is changed, and it is not reported as an error", async () => {
    const h = harness({
      summarise: (init) =>
        new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
    })
    const sid = await h.chat(4)
    const running = h.host.handle({ type: "compactContext", sessionID: sid })
    await vi.waitFor(() => expect(h.compactCalls()).toHaveLength(1))
    await h.host.handle({ type: "abort", sessionID: sid })
    await running

    expect(notices(h).at(-1)).toMatch(/Compaction stopped\. Nothing was changed/)
    expect(h.of("sendMessageFailed")).toEqual([])
    expect(h.of("sessionTurnClosed").at(-1)).toMatchObject({ reason: "completed" }) // not "interrupted": that would label the last answer "stopped"
    expect((await (await openStorage()).loadAll()).find((x) => x.id === sid)!.compaction).toBeUndefined()
  })

  it("leaves a reply that is already streaming alone", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const events: Emitted[] = []
    const host = new WebHost((m) => events.push(m as Emitted), {
      getByok: () => ({ provider: "nebius", key: KEY }),
      fetchImpl: (async (url: string) => {
        const u = String(url)
        if (u.endsWith("/api/limits")) return json(DEFAULT_LIMITS)
        if (u.startsWith("/api/agent")) return json(bundle)
        if (u.endsWith("/api/links")) return json({ citations: [] })
        await gate // the provider is slow
        return sse("late")
      }) as unknown as typeof fetch,
    })
    const turn = host.handle({ type: "sendMessage", text: "hi", messageID: "m1" })
    await vi.waitFor(() => expect(events.some((e) => e.type === "sessionStatus" && e.status === "busy")).toBe(true))
    const sid = events.find((e) => e.type === "messageCreated")!.message.sessionID
    await host.handle({ type: "compactContext", sessionID: sid })

    // no notice, and no turn closed on the reply's behalf
    expect(events.filter((e) => e.type === "contextCompressed")).toEqual([])
    expect(events.filter((e) => e.type === "sessionTurnClosed")).toEqual([])
    release()
    await turn
    expect(events.filter((e) => e.type === "sessionTurnClosed").map((e) => e.reason)).toEqual(["completed"])
  })
})
