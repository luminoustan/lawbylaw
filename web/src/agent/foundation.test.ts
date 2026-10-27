import { describe, expect, it } from "vitest"
import { LlmError, chat, cleanDetail, streamChat } from "./llm"
import { buildApiMessages, estimateTokens, isOkReply, shouldCheck, trimToCap, compactionSplit, attachToolNudge, type ApiMessage } from "./messages"
import { PROVIDERS, PROVIDER_IDS, chatUrl, cleanApiKey, disableThinking, isProviderId } from "./providers"
import { ServerToolError, createServerTools } from "./server-tools"

const signal = new AbortController().signal

describe("providers", () => {
  it("are fixed presets: only these two hosts, with the model pinned", () => {
    expect(chatUrl(PROVIDERS.nebius)).toBe("https://api.tokenfactory.nebius.com/v1/chat/completions")
    expect(chatUrl(PROVIDERS.deepseek)).toBe("https://api.deepseek.com/chat/completions")
    expect(PROVIDERS.nebius.model).toBe("deepseek-ai/DeepSeek-V4.1-Flash")
    expect(Object.isFrozen(PROVIDERS)).toBe(true)
    expect(isProviderId("nebius") && isProviderId("deepseek")).toBe(true)
    expect(isProviderId("https://evil.test")).toBe(false)
  })

  it("are offered with Nebius first, then DeepSeek", () => {
    expect(PROVIDER_IDS).toEqual(["nebius", "deepseek"])
    expect(PROVIDER_IDS.every(isProviderId)).toBe(true)
  })

  it("only ever call https endpoints under a provider's own base URL", () => {
    for (const id of PROVIDER_IDS) {
      expect(chatUrl(PROVIDERS[id]).startsWith("https://")).toBe(true)
      expect(chatUrl(PROVIDERS[id]).startsWith(PROVIDERS[id].baseUrl)).toBe(true)
    }
  })

  it("turn thinking off the way each provider expects", () => {
    const n: Record<string, unknown> = {}
    disableThinking(PROVIDERS.nebius, n)
    expect(n).toEqual({ reasoning_effort: "none" })
    const d: Record<string, unknown> = {}
    disableThinking(PROVIDERS.deepseek, d)
    expect(d).toEqual({ thinking: { type: "disabled" } })
  })

  it("accept a pasted key and refuse anything that could break out of a header", () => {
    expect(cleanApiKey("  sk-abc123  ")).toEqual({ ok: true, key: "sk-abc123" })
    for (const bad of ["sk-abc\r\nX-Evil: 1", "sk abc", "", "   ", "k".repeat(513), "clé-é"]) {
      expect(cleanApiKey(bad).ok).toBe(false)
    }
  })
})

describe("llm errors", () => {
  const reply = (s: number, body = "") => (async () => new Response(body, { status: s })) as unknown as typeof fetch
  const fail = async (s: number, body = "", apiKey = "k") => {
    try {
      await chat({ provider: PROVIDERS.deepseek, apiKey, payload: { messages: [] }, signal, fetchImpl: reply(s, body) })
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      return e as LlmError
    }
    throw new Error("expected a failure")
  }

  it("map status codes to kinds", async () => {
    expect((await fail(401)).kind).toBe("auth")
    expect((await fail(403)).kind).toBe("auth")
    expect((await fail(402)).kind).toBe("billing")
    expect((await fail(429)).kind).toBe("rate")
    expect((await fail(400)).kind).toBe("context")
    expect((await fail(503)).kind).toBe("server")
    expect((await fail(404)).kind).toBe("rejected")
  })

  it("show the user what the provider said, after our own explanation", async () => {
    const e = await fail(402, JSON.stringify({ error: { message: "Insufficient Balance", type: "unknown_error" } }))
    expect(e.detail).toBe("Insufficient Balance")
    expect(e.message).toContain("no remaining balance")
    expect(e.message).toContain('DeepSeek said: "Insufficient Balance"')
  })

  it("read the shapes both providers use", async () => {
    expect((await fail(401, '{"error":{"message":"Authentication Fails, Your api key: ****alid is invalid"}}')).detail).toBe(
      "Authentication Fails, Your api key: ****alid is invalid",
    )
    expect((await fail(401, JSON.stringify({ detail: "Could not authenticate. Reason: Unable authenticate" }))).detail).toBe(
      "Could not authenticate. Reason: Unable authenticate",
    )
    expect((await fail(404, "model not found")).detail).toBe("model not found")
  })

  it("say nothing extra when the body is empty, unrecognised or HTML", async () => {
    for (const body of ["", "   ", '{"x":1}', "<html><body>Bad gateway</body></html>", '{"detail":[{"loc":["a"]}]}']) {
      const e = await fail(502, body)
      expect(e.detail).toBeUndefined()
      expect(e.message).not.toContain("said:")
    }
  })

  it("never show the key, even if the provider echoes it", async () => {
    const key = "sk-live-0123456789abcdef"
    const e = await fail(401, JSON.stringify({ error: { message: `Invalid key ${key} for account` } }), key)
    expect(e.message).not.toContain(key)
    expect(e.message).toContain("[your key]")
    // also a differently formatted key of the same family
    expect(cleanDetail("bad token sk-abcdefghijklmnop1234", "other")).toBe("bad token [redacted]")
  })

  it("show provider text as one plain line of bounded length", async () => {
    expect(cleanDetail(JSON.stringify({ message: "line one\n\n  line\ttwo\u0007" }), "k")).toBe("line one line two")
    const long = cleanDetail(JSON.stringify({ message: "x".repeat(5000) }), "k")!
    expect([...long].length).toBe(401) // 400 characters and an ellipsis
    expect(long.endsWith("…")).toBe(true)
  })

  it("read only a bounded amount of a huge error body", async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1024
        c.enqueue(new Uint8Array(1024).fill(65))
      },
    })
    const f = (async () => new Response(body, { status: 500 })) as unknown as typeof fetch
    await expect(chat({ provider: PROVIDERS.deepseek, apiKey: "k", payload: {}, signal, fetchImpl: f })).rejects.toMatchObject({ kind: "server" })
    expect(pulled).toBeLessThan(64 * 1024)
  })

  it("report a dropped connection as a network error, and a user stop as aborted", async () => {
    const down = (async () => {
      throw new TypeError("Failed to fetch")
    }) as unknown as typeof fetch
    await expect(chat({ provider: PROVIDERS.deepseek, apiKey: "k", payload: {}, signal, fetchImpl: down })).rejects.toMatchObject({ kind: "network" })
    const ac = new AbortController()
    ac.abort()
    await expect(chat({ provider: PROVIDERS.deepseek, apiKey: "k", payload: {}, signal: ac.signal, fetchImpl: down })).rejects.toMatchObject({ kind: "aborted" })
  })

  it("never surfaces reasoning content", async () => {
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "SECRET THOUGHTS", content: "Hello" } }] })}\n\n` + "data: [DONE]\n\n"
    const got: string[] = []
    const r = await streamChat({
      provider: PROVIDERS.deepseek, apiKey: "k", payload: {}, signal,
      fetchImpl: (async () => new Response(sse)) as unknown as typeof fetch,
      onContent: (t) => got.push(t),
    })
    expect(r.content).toBe("Hello")
    expect(got.join("")).toBe("Hello")
  })

  it("assemble tool calls streamed in fragments", async () => {
    const frame = (tc: unknown) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [tc] } }] })}\n\n`
    const sse =
      frame({ index: 0, id: "c1", function: { name: "search", arguments: '{"q":' } }) +
      frame({ index: 0, function: { arguments: '"x"}' } }) +
      "data: [DONE]\n\n"
    const r = await streamChat({
      provider: PROVIDERS.deepseek, apiKey: "k", payload: {}, signal,
      fetchImpl: (async () => new Response(sse)) as unknown as typeof fetch,
      onContent: () => {},
    })
    expect(r.toolCalls).toEqual([{ id: "c1", name: "search", arguments: '{"q":"x"}' }])
  })
})

describe("message helpers", () => {
  it("estimate tokens as utf-8 bytes / 2", () => {
    expect(estimateTokens([{ role: "user", content: "abcd" }])).toBeGreaterThanOrEqual(2)
  })

  it("recognise the OK reply in its usual disguises", () => {
    for (const t of ["OK", " ok. ", "`OK`", '"OK"', "**OK**"]) expect(isOkReply(t)).toBe(true)
    expect(isOkReply("OK, but the date is wrong")).toBe(false)
  })

  it("decide when to check: after tools, below the skip limit, within the nudge budget; always when pending", () => {
    const base = { enabled: true, nudgesUsed: 0, toolSteps: 1, wasPending: false, maxNudges: 1, skipAfterToolSteps: 5 }
    expect(shouldCheck(base)).toBe(true)
    expect(shouldCheck({ ...base, toolSteps: 0 })).toBe(false)
    expect(shouldCheck({ ...base, toolSteps: 5 })).toBe(false)
    expect(shouldCheck({ ...base, nudgesUsed: 1 })).toBe(false)
    expect(shouldCheck({ ...base, enabled: false })).toBe(false)
    expect(shouldCheck({ ...base, enabled: false, wasPending: true })).toBe(true)
  })

  it("attach the tool nudge to the last tool message only", () => {
    const m: ApiMessage[] = [
      { role: "tool", tool_call_id: "a", content: "one" },
      { role: "tool", tool_call_id: "b", content: "two" },
    ]
    attachToolNudge(m, "NOTE")
    expect(m[0]!.content).toBe("one")
    expect(m[1]!.content).toContain("<system-reminder>\nNOTE\n</system-reminder>")
  })

  it("trim to the cap while keeping the system prompt and the latest message", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: "y".repeat(2000) }))
    const msgs = buildApiMessages({ systemPrompt: "SYS", actsContext: null, summary: null, history })
    const t = trimToCap(msgs, 3000)
    expect(estimateTokens(t.messages)).toBeLessThanOrEqual(3000)
    expect(t.messages[0]!.content).toBe("SYS")
    expect(t.messages.at(-1)).toEqual(msgs.at(-1))
    expect(t.notice).toBeTruthy()
    expect(compactionSplit(history)).not.toBeNull()
  })
})

describe("server tools client", () => {
  const route = (handler: (url: string, init: RequestInit) => Response) =>
    createServerTools({ baseUrl: "", fetchImpl: (async (u: string, i: RequestInit) => handler(u, i)) as unknown as typeof fetch })

  it("posts the documented shapes and tolerates missing fields", async () => {
    const seen: { url: string; body: unknown }[] = []
    const s = route((url, init) => {
      seen.push({ url, body: init.body ? JSON.parse(String(init.body)) : null })
      return Response.json({ result: "r" })
    })
    const r = await s.tool({ tool: "t", args: { a: 1 }, context: "orchestrator" }, signal)
    expect(r).toEqual({ result: "r", is_error: false, citations: [], sections: [] })
    await s.cite({ kind: "judiciary", output: "o", sections: [] }, signal)
    await s.links("text", signal)
    expect(seen.map((x) => x.url)).toEqual(["/api/tool", "/api/cite", "/api/links"])
    expect(seen[0]!.body).toEqual({ tool: "t", args: { a: 1 }, context: "orchestrator" })
  })

  it("carry the server's own message and status on failure, and a fixed one when unreachable", async () => {
    const limited = route(() => Response.json({ error: { message: "Slow down." } }, { status: 429 }))
    await expect(limited.links("x", signal)).rejects.toMatchObject({ message: "Slow down.", status: 429 })
    const down = createServerTools({
      fetchImpl: (async () => {
        throw new Error("boom")
      }) as unknown as typeof fetch,
    })
    await expect(down.agent("legislation", signal)).rejects.toBeInstanceOf(ServerToolError)
  })
})

describe("server tools client under load", () => {
  const busy = (retryAfter: string | null, status = 503) =>
    new Response(JSON.stringify({ error: { message: "The server is busy." } }), {
      status,
      headers: retryAfter === null ? {} : { "retry-after": retryAfter },
    })
  /** A scripted server plus the waits the client chose; `sleep` returns at once so tests are instant. */
  function setup(replies: (() => Response)[]) {
    let n = 0
    const waits: number[] = []
    const tools = createServerTools({
      fetchImpl: (async () => replies[Math.min(n++, replies.length - 1)]!()) as unknown as typeof fetch,
      sleep: async (ms) => void waits.push(ms),
      random: () => 0.5, // no jitter: wait = exactly what was asked
    })
    return { tools, waits, calls: () => n }
  }
  const ok = () => Response.json({ result: "found" })
  const call = { tool: "get_section", args: {}, context: "orchestrator" as const }

  it("waits out a busy answer for as long as the server asked, then succeeds", async () => {
    const { tools, waits, calls } = setup([() => busy("2"), () => busy("1"), ok])
    await expect(tools.tool(call, signal)).resolves.toMatchObject({ result: "found" })
    expect(calls()).toBe(3)
    expect(waits).toEqual([2000, 1000])
  })

  it("retries a rate-limit refusal too, and backs off when no Retry-After is sent", async () => {
    const { tools, waits } = setup([() => busy(null, 429), () => busy(null, 429), ok])
    await tools.tool(call, signal)
    expect(waits).toEqual([400, 800])
  })

  it("gives up after a few tries and reports what the server said", async () => {
    const { tools, calls } = setup([() => busy("1")])
    await expect(tools.tool(call, signal)).rejects.toMatchObject({ status: 503, message: "The server is busy." })
    expect(calls()).toBe(4) // the first try and three retries
  })

  it("does not wait on a long Retry-After (a restarting server)", async () => {
    const { tools, calls, waits } = setup([() => busy("60")])
    await expect(tools.tool(call, signal)).rejects.toMatchObject({ status: 503 })
    expect(calls()).toBe(1)
    expect(waits).toEqual([])
  })

  it("never retries a request the server rejected as wrong, or one that could not be sent", async () => {
    const bad = setup([() => Response.json({ error: { message: "nope" } }, { status: 400 })])
    await expect(bad.tools.tool(call, signal)).rejects.toMatchObject({ status: 400 })
    expect(bad.calls()).toBe(1)
    let sent = 0
    const down = createServerTools({
      fetchImpl: (async () => {
        sent++
        throw new Error("offline")
      }) as unknown as typeof fetch,
    })
    await expect(down.tool(call, signal)).rejects.toBeInstanceOf(ServerToolError)
    expect(sent).toBe(1)
  })

  it("retries links only once, so a streaming answer is never held up", async () => {
    const { tools, calls } = setup([() => busy("1")])
    await expect(tools.links("text", signal)).rejects.toMatchObject({ status: 503 })
    expect(calls()).toBe(2)
  })

  it("spreads out retries so a herd refused together does not return together", async () => {
    const waitWith = async (r: number) => {
      const waits: number[] = []
      let first = true
      await createServerTools({
        fetchImpl: (async () => (first ? ((first = false), busy("2")) : ok())) as unknown as typeof fetch,
        sleep: async (ms) => void waits.push(ms),
        random: () => r,
      }).tool(call, signal)
      return waits[0]!
    }
    expect(await waitWith(0)).toBe(1500) // 2 s x 0.75
    expect(await waitWith(1)).toBe(2500) // 2 s x 1.25
  })

  it("stops waiting the moment the user stops the turn", async () => {
    const ac = new AbortController()
    const tools = createServerTools({ fetchImpl: (async () => busy("3")) as unknown as typeof fetch })
    const started = Date.now()
    const pending = tools.tool(call, ac.signal)
    setTimeout(() => ac.abort(), 30)
    await expect(pending).rejects.toBeInstanceOf(ServerToolError)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
