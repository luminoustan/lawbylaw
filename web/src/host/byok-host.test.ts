import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_LIMITS, WebHost } from "./web-host"
import { openStorage } from "./storage"
import { clearByok, loadByok, saveByok } from "../agent/key-store"

/**
 * Bring your own key, through the real host: the model loop runs in the browser, the key goes to
 * the provider and nowhere else, and the transcript is stored and closed like any other turn.
 */

type Emitted = Record<string, any>
const KEY = "sk-canary-host-0123456789"

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

const providerSse = (text: string) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } })}\n\n` +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )

function harness(opts: { byok: boolean; provider: (init: RequestInit) => Response }) {
  const events: Emitted[] = []
  const own: { url: string; init?: RequestInit }[] = []
  const provider: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (u.startsWith("https://")) {
      provider.push({ url: u, init: init! })
      return opts.provider(init!)
    }
    own.push({ url: u, init })
    if (u.endsWith("/api/limits")) return json(DEFAULT_LIMITS)
    if (u.startsWith("/api/agent")) return json(bundle)
    if (u.endsWith("/api/links")) return json({ citations: [] })
    if (u.endsWith("/api/chat")) return new Response("data: " + JSON.stringify({ type: "token", content: "from server" }) + "\n\ndata: " + JSON.stringify({ type: "done" }) + "\n\n")
    return json({}, 404)
  }) as unknown as typeof fetch
  const host = new WebHost((m) => events.push(m as Emitted), {
    fetchImpl,
    getByok: opts.byok ? () => ({ provider: "nebius", key: KEY }) : undefined,
  })
  return { host, events, own, provider, of: (t: string) => events.filter((e) => e.type === t) }
}

beforeEach(async () => {
  await (await openStorage()).clear()
})

const text = (msg: Emitted) => msg.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("")

describe("a turn with the user's own key", () => {
  it("runs in the browser: the key goes to the provider only, never to the app's server", async () => {
    const h = harness({ byok: true, provider: () => providerSse("Your deposit is recoverable.") })
    await h.host.handle({ type: "sendMessage", text: "deposit?", messageID: "m1" })

    const reply = h.of("messageCreated").map((e) => e.message).filter((m) => m.role === "assistant").at(-1)!
    expect(text(reply)).toBe("Your deposit is recoverable.")
    expect(reply.finish).toBe("stop")
    expect(h.of("sessionTurnClosed").map((e) => e.reason)).toEqual(["completed"])

    // the loop talked to the provider with the key ...
    expect(h.provider).toHaveLength(1)
    expect(h.provider[0]!.url).toBe("https://api.tokenfactory.nebius.com/v1/chat/completions")
    expect((h.provider[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    // ... and the app's own server never saw the key, and never ran the chat
    expect(h.own.some((c) => c.url.endsWith("/api/chat"))).toBe(false)
    expect(JSON.stringify(h.own)).not.toContain(KEY)
    // nor did it reach anything the UI renders or persists
    expect(JSON.stringify(h.events)).not.toContain(KEY)
    expect(JSON.stringify(await (await openStorage()).loadAll())).not.toContain(KEY)
  })

  it("shows a rejected key as a failed turn with the provider's own message, never the key", async () => {
    const h = harness({ byok: true, provider: () => new Response(`detail from provider: ${KEY} is not valid`, { status: 401 }) })
    await h.host.handle({ type: "sendMessage", text: "hi", messageID: "m1" })

    const failed = h.of("sendMessageFailed")
    expect(failed).toHaveLength(1)
    expect(String(failed[0]!.error)).toMatch(/rejected your API key/i)
    expect(String(failed[0]!.error)).toContain("detail from provider")
    expect(JSON.stringify(h.events)).not.toContain(KEY)
  })

  it("shows a provider problem that did not stop the reply as a notice in the chat", async () => {
    let n = 0
    const h = harness({
      byok: true,
      // 1st call asks to compact? no: simply fail the first call mid-way is fatal, so use a context error then success
      provider: () => (++n === 1 ? new Response(JSON.stringify({ error: { message: "too long" } }), { status: 400 }) : providerSse("Recovered.")),
    })
    await h.host.handle({ type: "sendMessage", text: "hi", messageID: "m1" })
    const reply = h.of("messageCreated").map((e) => e.message).filter((m) => m.role === "assistant").at(-1)!
    expect(text(reply)).toBe("Recovered.")
    expect(h.of("sendMessageFailed")).toEqual([])
  })

  it("keeps using /api/chat when no key is set", async () => {
    const h = harness({ byok: false, provider: () => providerSse("unused") })
    await h.host.handle({ type: "sendMessage", text: "hi", messageID: "m1" })

    expect(h.provider).toHaveLength(0)
    expect(h.own.some((c) => c.url.endsWith("/api/chat"))).toBe(true)
    const reply = h.of("messageCreated").map((e) => e.message).filter((m) => m.role === "assistant").at(-1)!
    expect(text(reply)).toBe("from server")
  })
})

describe("deleting all data", () => {
  it("removes the API key too, wherever it is kept", async () => {
    saveByok("nebius", KEY, "session")
    expect(loadByok()).not.toBeNull()
    const h = harness({ byok: false, provider: () => providerSse("unused") })
    await h.host.handle({ type: "clearAllData" })
    expect(loadByok()).toBeNull()
    clearByok()
  })
})
