/**
 * host-link.ts: the in-page link between the UI and the browser host (`host/web-host.ts`).
 *
 * UI to host: `postHostMessage` hands a plain object to the handler that `connectHost` registered.
 * Host to UI: the host posts to this window, and `createMessageBus` queues and delivers those messages.
 * Everything is in one page: nothing here touches the network.
 */

import { batch } from "solid-js"

export type HostMessage = Record<string, unknown> & { type?: string }

type HostHandler = (message: Record<string, unknown>) => void

let sendToHost: HostHandler = (m) => console.warn("[ui] no host is connected; dropped", m.type)

/** Register the host that receives every UI message. Called once at start-up. */
export function connectHost(handler: HostHandler): void {
  sendToHost = handler
}

/** Fire-and-forget message to the host, from code outside the store (links, delete-all). */
export function postHostMessage(message: Record<string, unknown>): void {
  sendToHost(message)
}

/** Copy text to the clipboard: the async Clipboard API, then the legacy `execCommand` path. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // A restricted context (no permission): fall through to the legacy path.
  }
  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.top = "-1000px"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export interface MessageBus {
  /** Send a message to the host. */
  post(message: Record<string, unknown>): void
  /** Subscribe to host messages. Returns an unsubscribe function. */
  onMessage(handler: (message: HostMessage) => void): () => void
}

export function createMessageBus(): MessageBus {
  const handlers = new Set<(message: HostMessage) => void>()

  // Host messages arrive one per postMessage, and during a stream that is one
  // message per token. Handling each one on arrival runs a full render pass per
  // token; instead, queue them and drain once per animation frame inside a
  // Solid batch, so a burst of N deltas costs one render instead of N.
  //
  // Ordering is preserved (the queue is FIFO and nothing is dropped), and the
  // wire protocol is untouched — this is purely how the UI schedules the
  // work it has already received.
  const queue: HostMessage[] = []
  let scheduled = false

  const deliver = (message: HostMessage) => {
    for (const handler of [...handlers]) {
      try {
        handler(message)
      } catch (err) {
        console.error("[ui] message handler error", err)
      }
    }
  }

  const drain = () => {
    scheduled = false
    if (queue.length === 0) return
    const pending = queue.splice(0, queue.length)
    // One notification pass for every store write in this frame.
    batch(() => {
      for (const message of pending) deliver(message)
    })
  }

  const schedule = () => {
    if (scheduled) return
    // A hidden document gets no animation frames, so a rAF-only queue would
    // stall until the view is shown again. While hidden there is nothing to
    // paint either, so handle messages as they arrive.
    if (typeof document !== "undefined" && document.hidden) {
      drain()
      return
    }
    scheduled = true
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(drain)
    else setTimeout(drain, 0)
  }

  const listener = (event: MessageEvent<HostMessage>) => {
    // Only accept messages our own host posted to this window (same origin).
    if (event.source !== window || event.origin !== window.location.origin) return
    const message = event.data
    if (!message || typeof message !== "object") return
    queue.push(message)
    schedule()
  }
  window.addEventListener("message", listener)

  // Never strand a queued message: a pending frame is not guaranteed to arrive
  // if the view is being hidden or the page is going away.
  const flush = () => {
    if (queue.length > 0) drain()
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", flush)
  window.addEventListener("pagehide", flush)
  window.addEventListener("beforeunload", flush)

  return {
    post(message) {
      postHostMessage(message)
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
  }
}
