import { describe, expect, it } from "vitest"
import { readSse } from "./sse"

describe("readSse", () => {
  it("returns promptly when the turn was stopped before reading began", async () => {
    // A stream that never sends or ends, as a stalled provider would.
    const body = new ReadableStream<Uint8Array>({ start() {} })
    const ac = new AbortController()
    ac.abort()
    const started = Date.now()
    await readSse(body, () => {}, 30_000, ac.signal)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it("returns promptly when stopped while waiting", async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)
    await readSse(body, () => {}, 30_000, ac.signal)
  })

  it("delivers events split across chunks and ignores malformed ones", async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"a":'))
        c.enqueue(enc.encode('1}\n\ndata: not json\n\ndata: {"b":2}\n\n'))
        c.close()
      },
    })
    const got: unknown[] = []
    await readSse(body, (e) => got.push(e), 1000, new AbortController().signal)
    expect(got).toEqual([{ a: 1 }, { b: 2 }])
  })
})
