/**
 * sse.ts — POST-capable SSE reader with an idle watchdog.
 *
 * EventSource cannot POST, so we parse `text/event-stream` from a fetch body.
 * The server sends a keep-alive comment every 10s; if no bytes arrive for
 * `idleMs` the stream is treated as dead (no infinite spinners).
 */

export type SseHandler = (data: unknown) => void

export class StreamIdleError extends Error {
  constructor() {
    super("stream idle")
  }
}

const MAX_BUFFER = 1_000_000

export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: SseHandler,
  idleMs: number,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  let idle = false

  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      idle = true
      void reader.cancel().catch(() => {})
    }, idleMs)
  }
  const onAbort = () => void reader.cancel().catch(() => {})
  signal.addEventListener("abort", onAbort)
  // A stop that landed before this point never fires the listener; honour it now, or the read
  // would wait for the idle watchdog.
  if (signal.aborted) onAbort()
  arm()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      arm()
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_BUFFER) throw new Error("oversized event")
      let sep: number
      while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2))
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n")
        if (!data) continue
        try {
          onEvent(JSON.parse(data))
        } catch {
          /* ignore malformed event */
        }
      }
    }
    if (idle) throw new StreamIdleError()
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}
