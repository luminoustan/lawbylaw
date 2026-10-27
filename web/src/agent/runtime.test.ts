import { describe, expect, it, vi } from "vitest"
import { type AgentEvent, classifyIssue, runAgentTurn } from "./runtime"
import { PROVIDERS } from "./providers"
import type { AgentBundle, Citation, ServerTools, ToolResult } from "./server-tools"

const KEY = "sk-canary-0123456789"

interface Step {
  content?: string
  tools?: { name: string; args: unknown }[]
  status?: number
  /** Error message the provider puts in its response body (with `status`). */
  says?: string
}

/** A provider that plays back `steps` in order, in the real wire formats (SSE when streaming, JSON otherwise). */
function fakeProvider(steps: Step[]) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = []
  let i = 0
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body })
    const step = steps[i++] ?? { content: "(script exhausted)" }
    if (step.status) {
      return new Response(JSON.stringify({ error: { message: step.says ?? "Provider says no" } }), { status: step.status })
    }
    const toolCalls = (step.tools ?? []).map((t, n) => ({
      index: n,
      id: `call_${i}_${n}`,
      type: "function",
      function: { name: t.name, arguments: JSON.stringify(t.args) },
    }))
    const usage = { prompt_tokens: 100, completion_tokens: 20 }
    if (body.stream) {
      const chunks: unknown[] = []
      const text = step.content ?? ""
      if (text) {
        const mid = Math.ceil(text.length / 2)
        chunks.push({ choices: [{ delta: { content: text.slice(0, mid) } }] })
        chunks.push({ choices: [{ delta: { content: text.slice(mid) } }] })
      }
      if (toolCalls.length) chunks.push({ choices: [{ delta: { tool_calls: toolCalls } }] })
      chunks.push({ choices: [], usage })
      const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
      return new Response(sse, { headers: { "Content-Type": "text/event-stream" } })
    }
    return Response.json({
      choices: [
        {
          finish_reason: toolCalls.length ? "tool_calls" : "stop",
          message: { content: step.content ?? null, tool_calls: toolCalls.length ? toolCalls.map(({ index: _i, ...c }) => c) : undefined },
        },
      ],
      usage,
    })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests, remaining: () => steps.length - i }
}

const toolDef = (name: string) => ({ type: "function" as const, function: { name, description: name, parameters: { type: "object" } } })

function bundle(over: Partial<AgentBundle["params"]> = {}): AgentBundle {
  return {
    mode: "self-help",
    system_prompt: "SYSTEM PROMPT",
    acts_context: null,
    tools: [
      toolDef("search_legislation"),
      toolDef("classify_issue"),
      toolDef("askquestion"),
      toolDef("web_search_tavily"),
      toolDef("legislation_agent"),
    ],
    agent_tools: { legislation_agent: { agent: "legislation_agent", context: "agent_legislation", cite: "legislation" } },
    subagents: {
      legislation_agent: { system_prompt: "SUB PROMPT", tools: [toolDef("search_acts")], final_message: null },
    },
    params: {
      temperature: 0.3,
      top_p: 0.9,
      max_output_tokens: 4096,
      subagent_max_output_tokens: 2048,
      output_reserve_tokens: 8192,
      context_window_size: 200_000,
      rag_context_fill_ratio: 0.8,
      rag_context_budget: 8000,
      sub_agent_context_budget: 60_000,
      rag_search_hard_cap: 6,
      finalization_check: true,
      tool_nudge: true,
      max_nudges: 1,
      skip_check_after_tool_steps: 5,
      revision_min_chars: 16,
      max_web_searches: 2,
      max_orchestrator_reads: 10,
      context_tokens: 180_000,
      model_window: 200_000,
      message_chars: 200_000,
      max_messages: 200,
      request_timeout_s: 60,
      ...over,
    },
    texts: {
      tool_nudge: "TOOL NUDGE",
      finalization_nudge: "Check the draft answer above. Reply OK if fine.",
      finalization_ok: "OK",
      forced_final: "FORCED FINAL after {n} searches",
      sub_forced_final: "SUB FORCED {n}",
      sub_forced_final_suffix: " (after {n})",
      summariser_system: "SUMMARISER",
      summary_instruction: "SUMMARISE",
      summary_rules: "RULES",
      subagent_definitions: "",
    },
  }
}

const found = (text: string): ToolResult => ({ result: text, is_error: false, citations: [], sections: [] })

function fakeServer(over: Partial<ServerTools> & { bundle?: AgentBundle } = {}) {
  const calls: { tool: string; context: string }[] = []
  const cites: { kind: string; output: string; sections: unknown[] }[] = []
  const server: ServerTools = {
    agent: async () => over.bundle ?? bundle(),
    tool: async (c) => {
      calls.push({ tool: c.tool, context: c.context })
      return found(`result of ${c.tool}`)
    },
    cite: async (req) => {
      cites.push(req)
      return { result: `CITED(${req.output})`, is_error: false }
    },
    links: async () => [],
    compact: async () => {
      throw new Error("a turn must never summarise")
    },
    ...over,
  }
  return { server, calls, cites }
}

async function run(
  steps: Step[],
  opts: {
    server?: ServerTools
    history?: { role: "user" | "assistant"; content: string }[]
    signal?: AbortSignal
    tavilyKey?: string
    /** Answers any request the provider script does not (Tavily). */
    otherFetch?: typeof fetch
  } = {},
) {
  const p = fakeProvider(steps)
  const providerFetch = p.fetchImpl
  const fetchImpl = opts.otherFetch
    ? ((url, init) => (String(url).startsWith("https://api.tavily.com/") ? opts.otherFetch!(url, init) : providerFetch(url, init))) as typeof fetch
    : providerFetch
  const events: AgentEvent[] = []
  const { server } = opts.server ? { server: opts.server } : fakeServer()
  let n = 0
  await runAgentTurn({
    provider: PROVIDERS.nebius,
    apiKey: KEY,
    mode: "self-help",
    history: opts.history ?? [{ role: "user", content: "my landlord kept my deposit" }],
    signal: opts.signal ?? new AbortController().signal,
    emit: (e) => events.push(e),
    server,
    fetchImpl,
    ...(opts.tavilyKey ? { tavilyKey: opts.tavilyKey } : {}),
    randomId: () => `id-${++n}`,
  })
  return { events, ...p }
}

const types = (evs: AgentEvent[]) => evs.map((e) => e.type)
const shown = (evs: AgentEvent[]) => {
  let out = ""
  for (const e of evs) {
    if (e.type === "answer_reset") out = ""
    if (e.type === "token") out += String(e.content)
  }
  return out
}

describe("runAgentTurn: plain answers", () => {
  it("streams an answer and finishes, with no check when no tool ran", async () => {
    const r = await run([{ content: "You can claim it back." }])
    expect(shown(r.events)).toBe("You can claim it back.")
    expect(types(r.events).at(-1)).toBe("done")
    expect(r.requests).toHaveLength(1)
    expect(r.events.some((e) => e.type === "context_usage")).toBe(true)
    expect(r.events.some((e) => e.type === "breakdown")).toBe(true)
  })

  it("calls the provider with the pinned model, thinking off, and the bundle's tools and sampling", async () => {
    const r = await run([{ content: "ok" }])
    const q = r.requests[0]!
    expect(q.url).toBe("https://api.tokenfactory.nebius.com/v1/chat/completions")
    expect(q.body.model).toBe("deepseek-ai/DeepSeek-V4.1-Flash")
    expect(q.body.reasoning_effort).toBe("none")
    expect(q.body.stream).toBe(true)
    expect(q.body.temperature).toBe(0.3)
    expect(q.body.tools).toHaveLength(5)
    expect(q.body.messages[0]).toEqual({ role: "system", content: "SYSTEM PROMPT" })
  })

  it("sends the key only in the Authorization header, and only to the provider", async () => {
    const r = await run([{ content: "hi" }])
    for (const q of r.requests) {
      expect(q.headers.Authorization).toBe(`Bearer ${KEY}`)
      expect(JSON.stringify(q.body)).not.toContain(KEY)
    }
    expect(r.events.map((e) => JSON.stringify(e)).join("")).not.toContain(KEY)
  })
})

describe("runAgentTurn: tools and the finalization check", () => {
  const tool = (name: string, args: unknown = {}) => ({ name, args })

  it("runs a tool, then confirms the draft: the answer is shown once", async () => {
    const r = await run([
      { tools: [tool("search_legislation", { query: "deposit" })] },
      { content: "Draft answer about deposits." },
      { content: "OK" },
    ])
    expect(shown(r.events)).toBe("Draft answer about deposits.")
    const kinds = types(r.events)
    expect(kinds.indexOf("tool_call")).toBeLessThan(kinds.indexOf("tool_result"))
    expect(kinds.at(-1)).toBe("done")
    // the check round replays the draft and the check prompt
    const checkMsgs = r.requests[2]!.body.messages
    expect(checkMsgs.at(-2)).toEqual({ role: "assistant", content: "Draft answer about deposits." })
    expect(checkMsgs.at(-1).content).toContain("Check the draft answer above")
    expect(r.requests[1]!.body.messages.at(-1).content).toContain("TOOL NUDGE")
  })

  it("replaces the draft when the check returns a rewritten answer", async () => {
    const r = await run([
      { tools: [tool("search_legislation")] },
      { content: "First draft, a bit off." },
      { content: "Corrected, complete answer that is clearly long." },
    ])
    expect(types(r.events)).toContain("answer_reset")
    expect(shown(r.events)).toBe("Corrected, complete answer that is clearly long.")
  })

  it("retracts narration that streamed before a tool call", async () => {
    const r = await run([
      { content: "Let me look that up.", tools: [tool("search_legislation")] },
      { content: "Final." },
      { content: "OK" },
    ])
    const resetAt = types(r.events).indexOf("answer_reset")
    const callAt = types(r.events).indexOf("tool_call")
    expect(resetAt).toBeGreaterThan(-1)
    expect(resetAt).toBeLessThan(callAt)
    expect(shown(r.events)).toBe("Final.")
  })

  it("does not check when the tool budget for checks is exhausted", async () => {
    const b = bundle({ finalization_check: false })
    const r = await run([{ tools: [tool("search_legislation")] }, { content: "Answer." }], { server: fakeServer({ bundle: b }).server })
    expect(r.requests).toHaveLength(2)
    expect(shown(r.events)).toBe("Answer.")
  })

  it("answers locally to classify_issue and shows askquestion as a form", async () => {
    const q = [{ id: "a", question: "When?" }]
    const r = await run([
      {
        tools: [
          tool("classify_issue", { categories: ["civil"], summary: "Deposit", missing_details: ["date"] }),
          tool("askquestion", { questions: q, title: "More" }),
        ],
      },
      { content: "Here are questions." },
      { content: "OK" },
    ])
    const form = r.events.find((e) => e.type === "questionRequest")
    expect(form).toMatchObject({ requestId: "id-1", questions: q, title: "More" })
    const results = r.requests[1]!.body.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content)
    expect(results[0]).toContain("Classification: civil\nSummary: Deposit\nStill needed: date")
    expect(results[1]).toContain("Asked the user 1 question(s)")
  })

  it("stops at the web search cap without calling the server again", async () => {
    const { server, calls } = fakeServer()
    const web = tool("web_search_tavily", { query: "x" })
    const r = await run([{ tools: [web, web, web] }, { content: "A." }, { content: "OK" }], { server })
    expect(calls.filter((c) => c.tool === "web_search_tavily")).toHaveLength(2)
    const toolMsgs = r.requests[1]!.body.messages.filter((m: any) => m.role === "tool")
    expect(toolMsgs[2].content).toContain("No more web searches are available")
  })

  describe("with the visitor's own Tavily key", () => {
    const TKEY = "tvly-canary-0123456789abcdef"
    const withoutTavily = (): AgentBundle => {
      const b = bundle()
      return { ...b, tools: b.tools.filter((t) => t.function.name !== "web_search_tavily"), tavily_tool: toolDef("web_search_tavily") }
    }
    const tavilyOk = () =>
      vi.fn(async () => Response.json({ results: [{ url: "https://www.mom.gov.sg/x", title: "MOM", content: "Fees page" }] })) as unknown as typeof fetch

    it("searches from the browser, straight to Tavily, and never asks the site to search", async () => {
      const { server, calls } = fakeServer({ bundle: withoutTavily() })
      const other = tavilyOk()
      const r = await run([{ tools: [tool("web_search_tavily", { query: "work pass fee" })] }, { content: "A." }, { content: "OK" }], {
        server,
        tavilyKey: TKEY,
        otherFetch: other,
      })
      // the model was offered the tool although the site has no Tavily key
      expect(r.requests[0]!.body.tools.map((t: any) => t.function.name)).toContain("web_search_tavily")
      expect(calls.filter((c) => c.tool === "web_search_tavily")).toHaveLength(0)
      const [url, init] = (other as any).mock.calls[0]
      expect(url).toBe("https://api.tavily.com/search")
      expect(init.headers.Authorization).toBe(`Bearer ${TKEY}`)
      expect(init.credentials).toBe("omit")
      expect(JSON.parse(init.body).query).toBe("work pass fee")
      const toolMsg = r.requests[1]!.body.messages.find((m: any) => m.role === "tool")
      expect(toolMsg.content).toContain("UNTRUSTED")
      expect(toolMsg.content).toContain("https://www.mom.gov.sg/x")
      // the key reaches no provider request, no event and no site call
      expect(JSON.stringify(r.requests.map((q) => q.body))).not.toContain(TKEY)
      expect(JSON.stringify(r.events)).not.toContain(TKEY)
    })

    it("does not offer the tool without a key when the site has none", async () => {
      const r = await run([{ content: "hi" }], { server: fakeServer({ bundle: withoutTavily() }).server })
      expect(r.requests[0]!.body.tools.map((t: any) => t.function.name)).not.toContain("web_search_tavily")
    })

    it("does not offer the tool twice when the site has a key too", async () => {
      const r = await run([{ content: "hi" }], { tavilyKey: TKEY })
      expect(r.requests[0]!.body.tools.filter((t: any) => t.function.name === "web_search_tavily")).toHaveLength(1)
    })

    it("tells the model a rejected key failed, without the key or the response body", async () => {
      const other = vi.fn(async () => new Response(`{"detail":"bad key ${TKEY}"}`, { status: 401 })) as unknown as typeof fetch
      const r = await run([{ tools: [tool("web_search_tavily", { query: "x" })] }, { content: "A." }, { content: "OK" }], {
        tavilyKey: TKEY,
        otherFetch: other,
      })
      const toolMsg = r.requests[1]!.body.messages.find((m: any) => m.role === "tool")
      expect(toolMsg.content).toContain("key was rejected")
      expect(JSON.stringify(r.requests)).not.toContain(TKEY)
      expect(JSON.stringify(r.events)).not.toContain(TKEY)
    })

    it("still counts against the per-turn search cap", async () => {
      const other = tavilyOk()
      const web = tool("web_search_tavily", { query: "x" })
      const r = await run([{ tools: [web, web, web] }, { content: "A." }, { content: "OK" }], { tavilyKey: TKEY, otherFetch: other })
      expect((other as any).mock.calls).toHaveLength(2)
      const toolMsgs = r.requests[1]!.body.messages.filter((m: any) => m.role === "tool")
      expect(toolMsgs[2].content).toContain("No more web searches are available")
    })
  })

  it("forces a final answer when every tool fails, without exposing why", async () => {
    const { server } = fakeServer({
      tool: async () => {
        throw new Error("secret upstream detail")
      },
    })
    const r = await run([{ tools: [tool("search_legislation")] }, { content: "General answer." }], { server })
    const final = r.requests[1]!.body
    expect(final.tools).toBeUndefined()
    expect(final.messages.at(-1).content).toBe("FORCED FINAL after 1 searches")
    expect(JSON.stringify(final.messages)).not.toContain("secret upstream detail")
    expect(shown(r.events)).toBe("General answer.")
    expect(types(r.events).at(-1)).toBe("done")
  })
})

describe("runAgentTurn: a busy legal database", () => {
  it("tells the user, and the model, when the database stayed busy", async () => {
    const { ServerToolError } = await import("./server-tools")
    const { server } = fakeServer({
      tool: async () => {
        throw new ServerToolError("The server is busy. Please retry in a moment.", 503)
      },
    })
    const r = await run([{ tools: [{ name: "search_legislation", args: {} }] }, { content: "General answer." }], { server })
    const notice = r.events.find((e) => e.type === "notice") as unknown as { message: string }
    expect(notice.message).toBe("The server is busy. Please retry in a moment.")
    const result = r.events.find((e) => e.type === "tool_result") as unknown as { result: string }
    expect(result.result).toContain("The server is busy")
    expect(types(r.events).at(-1)).toBe("done")
  })
})

describe("runAgentTurn: sub-agents", () => {
  it("runs the sub-agent loop with the server's context, then resolves references through /api/cite", async () => {
    const section = { text: "s", score: 1, section_id: "5", metadata: {} }
    const { server, calls, cites } = fakeServer({
      tool: async (c) => {
        calls.push({ tool: c.tool, context: c.context })
        return { ...found("ACT TEXT"), sections: [section] }
      },
    })
    const r = await run(
      [
        { tools: [{ name: "legislation_agent", args: { prompt: "deposit law" } }] }, // orchestrator
        { tools: [{ name: "search_acts", args: { q: "deposit" } }] }, // sub-agent round 1
        { content: "Findings with [ref]." }, // sub-agent answer
        { content: "Final answer." }, // orchestrator
        { content: "OK" },
      ],
      { server },
    )
    expect(calls).toEqual([{ tool: "search_acts", context: "agent_legislation" }])
    expect(cites).toEqual([{ kind: "legislation", output: "Findings with [ref].", sections: [section] }])
    const kinds = types(r.events)
    for (const k of ["subagent_start", "subagent_tool_call", "subagent_tool_result", "subagent_end"]) expect(kinds).toContain(k)
    expect(r.events.find((e) => e.type === "subagent_start")).toMatchObject({ task_id: expect.any(String), subagent_type: "legislation" })
    expect(r.events.find((e) => e.type === "subagent_tool_call")).toMatchObject({ id: "s0", name: "search_acts" })
    // sub-agent requests are non-streaming, deterministic, with its own prompt and tools
    const sub = r.requests[1]!.body
    expect(sub.stream).toBeFalsy()
    expect(sub.temperature).toBe(0)
    expect(sub.top_p).toBeUndefined()
    expect(sub.messages[0]).toEqual({ role: "system", content: "SUB PROMPT" })
    // the orchestrator sees the cited output, not the raw one
    const orch = r.requests[3]!.body.messages.filter((m: any) => m.role === "tool")
    expect(orch[0].content).toContain("CITED(Findings with [ref].)")
    expect(shown(r.events)).toBe("Final answer.")
  })

  it("falls back to a fixed message when the sub-agent produces nothing", async () => {
    const { server, cites } = fakeServer()
    await run(
      [{ tools: [{ name: "legislation_agent", args: { prompt: "p" } }] }, { content: "" }, { content: "Done." }, { content: "OK" }],
      { server },
    )
    expect(cites[0]!.output).toBe("The agent could not produce a response.")
  })
})

describe("runAgentTurn: citations from the answer text", () => {
  it("scans the finished answer for links before done", async () => {
    const cit: Citation = { act_name: "Act", section: "1", label: "Act s1", url: "https://example.test/act" }
    const links = vi.fn(async () => [cit])
    const { server } = fakeServer({ links })
    const r = await run([{ content: "See the Act section 1." }], { server })
    const kinds = types(r.events)
    expect(links).toHaveBeenCalledTimes(1)
    expect(kinds.indexOf("legislation_citations")).toBeGreaterThan(-1)
    expect(kinds.indexOf("legislation_citations")).toBeLessThan(kinds.indexOf("done"))
  })

  it("loses only the links when the scan fails", async () => {
    const { server } = fakeServer({
      links: async () => {
        throw new Error("down")
      },
    })
    const r = await run([{ content: "Answer." }], { server })
    expect(types(r.events).at(-1)).toBe("done")
  })
})

describe("runAgentTurn: failures", () => {
  it("reports a bad key with the provider's own words, and never the key", async () => {
    const r = await run([{ status: 401, says: "Authentication Fails, key ****6789 is invalid" }])
    const err = r.events.find((e) => e.type === "error") as unknown as { error: string }
    expect(err.error).toMatch(/rejected your API key/i)
    expect(err.error).toContain('Nebius said: "Authentication Fails, key ****6789 is invalid"')
    expect(err.error).not.toContain(KEY)
    expect(types(r.events)).not.toContain("done")
  })

  it("redacts the key when the provider echoes it back", async () => {
    const r = await run([{ status: 401, says: `bad key ${KEY}` }])
    const all = JSON.stringify(r.events)
    expect(all).not.toContain(KEY)
    expect(all).toContain("[your key]")
  })

  it("tells the user about a provider problem that did not end the turn", async () => {
    const r = await run([
      { tools: [{ name: "legislation_agent", args: { prompt: "p" } }] },
      { status: 429, says: "Rate limit reached for your key" },
      { content: "Answer without the agent." },
    ])
    const notice = r.events.find((e) => e.type === "notice") as unknown as { message: string }
    expect(notice.message).toContain('Nebius said: "Rate limit reached for your key"')
    expect(shown(r.events)).toBe("Answer without the agent.")
    expect(types(r.events).at(-1)).toBe("done")
  })

  it("explains an unrecoverable length error with what the provider said", async () => {
    const r = await run([
      { tools: [{ name: "search_legislation", args: {} }] },
      { status: 400, says: "maximum context length is 1000 tokens" },
      { status: 400, says: "maximum context length is 1000 tokens" },
      { status: 400, says: "maximum context length is 1000 tokens" },
    ])
    const err = r.events.find((e) => e.type === "error") as unknown as { error: string }
    expect(err.error).toContain("Context window exceeded")
    expect(err.error).toContain("maximum context length is 1000 tokens")
  })

  it("aborts the turn on a bad key inside a sub-agent instead of hiding it", async () => {
    const r = await run([{ tools: [{ name: "legislation_agent", args: { prompt: "p" } }] }, { status: 401 }])
    expect(types(r.events)).toContain("error")
    expect(types(r.events)).not.toContain("done")
  })

  it("recovers from a context-length rejection mid-loop by forcing a final answer", async () => {
    const r = await run([{ tools: [{ name: "search_legislation", args: {} }] }, { status: 400 }, { content: "Best effort." }])
    expect(shown(r.events)).toBe("Best effort.")
    expect(types(r.events).at(-1)).toBe("done")
  })

  it("reports a server that cannot be reached", async () => {
    const { server } = fakeServer({
      agent: async () => {
        throw new (await import("./server-tools")).ServerToolError("Couldn't reach the server.")
      },
    })
    const r = await run([], { server })
    expect(r.events).toEqual([{ type: "error", error: "Couldn't reach the server." }])
    expect(r.requests).toHaveLength(0)
  })

  it("emits nothing after the user stops the turn", async () => {
    const ac = new AbortController()
    const p = fakeProvider([{ content: "never shown" }])
    const events: AgentEvent[] = []
    const { server } = fakeServer({
      agent: async () => {
        ac.abort()
        return bundle()
      },
    })
    await runAgentTurn({
      provider: PROVIDERS.deepseek,
      apiKey: KEY,
      mode: "self-help",
      history: [{ role: "user", content: "q" }],
      signal: ac.signal,
      emit: (e) => events.push(e),
      server,
      fetchImpl: p.fetchImpl,
    })
    expect(events).toEqual([])
  })
})

describe("runAgentTurn: long conversations", () => {
  const long = (chars = 40_000) => {
    const big = "x".repeat(chars)
    return Array.from({ length: 12 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: big }))
  }

  it("never summarises on its own, however long the history is", async () => {
    const b = bundle({ context_tokens: 1_000_000 })
    const r = await run([{ content: "Answer." }], { history: long(10_000), server: fakeServer({ bundle: b }).server })
    expect(types(r.events)).not.toContain("compaction")
    expect(r.requests).toHaveLength(1) // one model call: the answer, no summariser call first
    expect(JSON.stringify(r.requests[0]!.body.messages)).not.toContain("SUMMARISE")
    expect(r.requests[0]!.body.messages.filter((m: { role: string }) => m.role === "user" || m.role === "assistant")).toHaveLength(12)
    expect(shown(r.events)).toBe("Answer.")
  })

  it("drops the oldest turns past the hard input cap, and says so", async () => {
    const b = bundle({ context_tokens: 30_000 })
    const r = await run([{ content: "Answer." }], { history: long(), server: fakeServer({ bundle: b }).server })
    expect(r.requests).toHaveLength(1)
    const notices = r.events.filter((e) => e.type === "notice").map((e) => String(e.message))
    expect(notices.some((m) => m.includes("Older messages were trimmed"))).toBe(true)
    expect(r.requests[0]!.body.messages.length).toBeLessThan(13)
    expect(types(r.events).at(-1)).toBe("done")
  })
})

describe("classifyIssue", () => {
  it("matches the server's format and omits empty parts", () => {
    expect(classifyIssue({ categories: ["civil", "family"] })).toBe("Classification: civil, family")
    expect(classifyIssue({ categories: ["civil"], summary: "S", missing_details: ["a", "b"] })).toBe(
      "Classification: civil\nSummary: S\nStill needed: a; b",
    )
  })
})
