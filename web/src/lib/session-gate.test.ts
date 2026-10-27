import { describe, expect, it, vi } from "vitest"
import { createGatedFetch, SESSION_HEADER } from "./session-gate"

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } })

function server(enforce: boolean) {
  const calls: { url: string; headers: Headers }[] = []
  let minted = 0
  const base = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: new Headers(init?.headers) })
    if (url === "/api/session" && !init?.method) return json({ enforce, site_key: "sk" })
    if (url === "/api/session") return json({ session: `tok${++minted}`, expires_at: 10_000 })
    return json({ ok: true })
  }) as unknown as typeof fetch
  return { base, calls }
}

describe("gated fetch", () => {
  it("adds nothing when the server does not enforce Turnstile", async () => {
    const s = server(false)
    const solve = vi.fn()
    const f = createGatedFetch({ base: s.base, solve, now: () => 0 })
    await f("/api/chat", { method: "POST" })
    expect(solve).not.toHaveBeenCalled()
    expect(s.calls.at(-1)!.headers.has(SESSION_HEADER)).toBe(false)
  })

  it("solves once, sends the token, and reuses it", async () => {
    const s = server(true)
    const solve = vi.fn(async () => "widget")
    const f = createGatedFetch({ base: s.base, solve, now: () => 0 })
    await f("/api/chat", { method: "POST" })
    await f("/api/tool", { method: "POST" })
    expect(solve).toHaveBeenCalledTimes(1)
    expect(s.calls.at(-1)!.headers.get(SESSION_HEADER)).toBe("tok1")
  })

  it("shares one challenge between concurrent calls", async () => {
    const s = server(true)
    const solve = vi.fn(async () => "widget")
    const f = createGatedFetch({ base: s.base, solve, now: () => 0 })
    await Promise.all([f("/api/chat"), f("/api/tool"), f("/api/cite")])
    expect(solve).toHaveBeenCalledTimes(1)
  })

  it("refreshes an expiring token", async () => {
    const s = server(true)
    let t = 0
    const f = createGatedFetch({ base: s.base, solve: async () => "w", now: () => t })
    await f("/api/chat")
    t = 9_990
    await f("/api/chat")
    expect(s.calls.at(-1)!.headers.get(SESSION_HEADER)).toBe("tok2")
  })

  it("never touches other origins or open routes", async () => {
    const s = server(true)
    const solve = vi.fn(async () => "w")
    const f = createGatedFetch({ base: s.base, solve, now: () => 0 })
    await f("https://api.deepseek.com/chat/completions", { method: "POST" })
    await f("/api/limits")
    expect(solve).not.toHaveBeenCalled()
    for (const c of s.calls) expect(c.headers.has(SESSION_HEADER)).toBe(false)
  })

  it("retries once with a fresh token after a 403", async () => {
    const calls: string[] = []
    let n = 0
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === "/api/session" && !init?.method) return json({ enforce: true, site_key: "sk" })
      if (url === "/api/session") return json({ session: `tok${++n}`, expires_at: 10_000 })
      calls.push(new Headers(init?.headers).get(SESSION_HEADER) ?? "")
      return calls.length === 1 ? json({ error: { code: "session_required" } }, 403) : json({ ok: true })
    }) as unknown as typeof fetch
    const f = createGatedFetch({ base, solve: async () => "w", now: () => 0 })
    const r = await f("/api/chat", { method: "POST" })
    expect(r.status).toBe(200)
    expect(calls).toEqual(["tok1", "tok2"])
  })
})

describe("verification failures", () => {
  it("throws a SessionError with the server's message when the exchange is refused", async () => {
    const { SessionError } = await import("./session-gate")
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/session" && !init?.method) return json({ enforce: true, site_key: "sk" })
      return json({ error: { message: "Verification failed. Please reload the page and try again." } }, 403)
    }) as unknown as typeof fetch
    const f = createGatedFetch({ base, solve: async () => "w", now: () => 0 })
    await expect(f("/api/chat", { method: "POST" })).rejects.toBeInstanceOf(SessionError)
  })
})
