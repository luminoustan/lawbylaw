import { describe, expect, it, vi } from "vitest"
import { cleanQuery, formatHits, httpError, MAX_QUERY_CHARS, parseTavily, searchTavily, tavilyRequestBody, TAVILY_URL } from "./tavily"

// These mirror the tests in `server/src/services/web_search.rs`: the two sides must agree.

const KEY = "tvly-canary-0123456789abcdef"
const signal = () => new AbortController().signal

describe("tavily: request building (parity with web_search.rs)", () => {
  it("cleans and caps queries", () => {
    expect(cleanQuery("  a \n b\t c ")).toBe("a b c")
    expect(Array.from(cleanQuery("x".repeat(300)))).toHaveLength(MAX_QUERY_CHARS)
    expect(Array.from(cleanQuery("法".repeat(200)))).toHaveLength(MAX_QUERY_CHARS)
    expect(Array.from(cleanQuery("😀".repeat(200)))).toHaveLength(MAX_QUERY_CHARS)
    expect(cleanQuery("   ")).toBe("")
  })

  it("clamps and validates", () => {
    const r = tavilyRequestBody({ query: "CPF contribution rates", max_results: 99, topic: "news", include_domains: ["https://www.cpf.gov.sg/", " ", "gov.sg"] })
    if (!r.ok) throw new Error("expected ok")
    expect(r.body.max_results).toBe(8)
    expect(r.body.topic).toBe("news")
    expect(r.body.include_domains).toEqual(["www.cpf.gov.sg", "gov.sg"])
    expect(r.body).toMatchObject({ search_depth: "basic", include_answer: false, include_raw_content: false, include_images: false })
    const d = tavilyRequestBody({ query: "x", topic: "weird", max_results: 0 })
    if (!d.ok) throw new Error("expected ok")
    expect(d.body.topic).toBe("general")
    expect(d.body.max_results).toBe(1)
    expect("include_domains" in d.body).toBe(false)
    expect(tavilyRequestBody({ query: "x", max_results: 2.5 })).toMatchObject({ body: { max_results: 5 } })
    expect(tavilyRequestBody({ query: "x", max_results: "3" })).toMatchObject({ body: { max_results: 5 } })
    expect(tavilyRequestBody({ query: "  " }).ok).toBe(false)
    expect(tavilyRequestBody({}).ok).toBe(false)
  })

  it("takes at most ten domains and drops ones with spaces", () => {
    const domains = Array.from({ length: 15 }, (_, i) => `d${i}.sg`)
    const r = tavilyRequestBody({ query: "q", include_domains: ["bad domain.sg", ...domains] })
    if (!r.ok) throw new Error("expected ok")
    expect(r.body.include_domains).toEqual(domains.slice(0, 10))
  })
})

describe("tavily: results (parity with web_search.rs)", () => {
  it("parses results and drops non-web URLs", () => {
    const hits = parseTavily({
      results: [
        { url: "https://www.mom.gov.sg/a", title: " MOM ", content: " Fees ", published_date: "2026-01-02" },
        { url: "javascript:alert(1)", title: "bad", content: "x" },
        { url: "https://has space.sg", title: "bad", content: "x" },
        { title: "no url" },
      ],
    })
    expect(hits).toEqual([{ title: "MOM", url: "https://www.mom.gov.sg/a", text: "Fees", date: "2026-01-02" }])
    expect(parseTavily({})).toEqual([])
    expect(parseTavily(null)).toEqual([])
  })

  it("marks the text untrusted, clips each hit and bounds the whole", () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, url: `https://e.sg/${i}`, text: "word ".repeat(400), date: null }))
    const out = formatHits("Tavily", "q", hits)
    expect(out).toContain("UNTRUSTED")
    expect(out).toContain("\n   URL: https://e.sg/0")
    expect(Array.from(out).length).toBeLessThanOrEqual(7000 + 200)
    expect(out).toContain("further results omitted")
    expect(out).toContain("…")
    expect(formatHits("Tavily", "q", []).endsWith("No results.")).toBe(true)
    expect(formatHits("Tavily", "q", [{ title: "", url: "https://e.sg", text: "", date: "2026-02-03" }])).toContain("1. (untitled)\n   URL: https://e.sg\n   Date: 2026-02-03")
  })

  it("never puts a response body in an error", () => {
    expect(httpError(401)).toContain("key was rejected")
    expect(httpError(401)).toContain("401")
    expect(httpError(432)).toContain("out of credit")
    expect(httpError(429)).toContain("rate limit")
    expect(httpError(503)).toContain("service had an error")
  })
})

describe("tavily: searching", () => {
  it("calls Tavily with the key in the header only, no cookies, no referrer", async () => {
    const f = vi.fn(async () => Response.json({ results: [{ url: "https://e.sg/1", title: "One", content: "c" }] }))
    const r = await searchTavily(KEY, { query: "  work   pass " }, { signal: signal(), fetchImpl: f as unknown as typeof fetch })
    expect(r.ok).toBe(true)
    expect(r.text).toContain('for "work pass"')
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(TAVILY_URL)
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    expect(init.credentials).toBe("omit")
    expect(init.referrerPolicy).toBe("no-referrer")
    expect(String(init.body)).not.toContain(KEY)
  })

  it("reports failures as text, with neither the key nor the body", async () => {
    const bad = vi.fn(async () => new Response(`echo ${KEY}`, { status: 402 }))
    const a = await searchTavily(KEY, { query: "q" }, { signal: signal(), fetchImpl: bad as unknown as typeof fetch })
    expect(a).toEqual({ ok: false, text: httpError(402) })
    const down = vi.fn(async () => {
      throw new TypeError(`Failed to fetch ${KEY}`)
    })
    const b = await searchTavily(KEY, { query: "q" }, { signal: signal(), fetchImpl: down as unknown as typeof fetch })
    expect(b.ok).toBe(false)
    expect(b.text).toContain("could not be reached")
    expect(b.text).not.toContain(KEY)
    const junk = vi.fn(async () => new Response("<html>", { status: 200 }))
    const c = await searchTavily(KEY, { query: "q" }, { signal: signal(), fetchImpl: junk as unknown as typeof fetch })
    expect(c.text).toContain("unreadable")
    const empty = await searchTavily(KEY, { query: " " }, { signal: signal(), fetchImpl: junk as unknown as typeof fetch })
    expect(empty).toEqual({ ok: false, text: "web_search_tavily needs a non-empty query." })
  })

  it("times out and honours a stop", async () => {
    const hang = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))))
    const slow = await searchTavily(KEY, { query: "q" }, { signal: signal(), fetchImpl: hang as unknown as typeof fetch, timeoutMs: 20 })
    expect(slow.text).toContain("timed out")
    const c = new AbortController()
    const p = searchTavily(KEY, { query: "q" }, { signal: c.signal, fetchImpl: hang as unknown as typeof fetch })
    c.abort()
    expect((await p).text).toContain("stopped")
  })
})
