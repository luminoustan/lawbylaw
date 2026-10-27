/**
 * messages/MessageList.tsx — the auto-scrolling transcript list.
 *
 * Owns the list/scroll/streaming concerns: turn grouping, the sticky-bottom
 * scroll behaviour, the compaction divider, notices and the empty/intro state.
 *
 * Split out of `components/messages.tsx`; behaviour is unchanged.
 */

import { createEffect, createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { useSession, type UiMessage } from "../../store/session"
import { CompactionDivider } from "./CompactionDivider"
import { NoticeRow } from "./NoticeRow"
import { TurnBubble } from "./TurnBubble"
import { TypingDots } from "./TypingDots"
import { setNow } from "./time-ticker"

export function MessageList() {
  const { currentMessages, currentNotices, isCurrentCompacted, isCurrentBusy, streamRevision } = useSession()
  let scrollRef: HTMLDivElement | undefined
  let contentRef: HTMLDivElement | undefined
  let stick = true
  let scrollQueued = false

  const onScroll = () => {
    const el = scrollRef
    if (!el) return
    stick = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  // Coalesce any number of content changes into a single scroll per frame.
  // Auto-scroll is instant ("auto"), never "smooth": re-issuing a smooth scroll
  // on every streamed token restarts the animation and reads as jitter. Smooth
  // is reserved for explicit jumps (initial load / session switch).
  const pinToBottom = (smooth = false) => {
    if (scrollQueued) return
    scrollQueued = true
    requestAnimationFrame(() => {
      scrollQueued = false
      const el = scrollRef
      if (!el || !stick) return
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" })
    })
  }

  const messages = currentMessages
  const notices = currentNotices
  const busy = isCurrentBusy
  const hasContent = () => messages().length > 0 || notices().length > 0 || busy()

  // Group consecutive messages into "turns": a turn starts at a user message
  // and runs through every following assistant message until the next user
  // message, so each question + reply shares one bubble.
  //
  // The rows are keyed by the head (user) message id rather than by an array
  // object. Returning fresh arrays made `<For>` remount every turn bubble — and
  // with it every Markdown block, diagram and image in the transcript — on each
  // `messageCreated` (turn start and turn end). The key list only changes when a
  // turn is actually added or removed.
  const turnKeys = createMemo(() => {
    const list = messages()
    const keys: string[] = []
    for (const m of list) {
      if (m.role === "user" || keys.length === 0) keys.push(m.id)
    }
    return keys
  })

  // The messages of the turn whose head is `key`, read from the live store array
  // so a replaced message object is picked up without remounting the row.
  const groupFor = (key: string): UiMessage[] => {
    const list = messages()
    const start = list.findIndex((m) => m.id === key)
    if (start < 0) return []
    const head = list[start]!
    const out: UiMessage[] = [head]
    for (let i = start + 1; i < list.length; i++) {
      const m = list[i]!
      if (m.role === "user") break
      out.push(m)
    }
    return out
  }

  // Cheap scroll trigger: the stream counter (bumped on every part update) plus
  // the structural sizes. Replaces the old full-transcript scan, which
  // JSON.stringify'd every tool part on each token.
  createEffect(() => {
    void streamRevision()
    void messages().length
    void notices().length
    void busy()
    pinToBottom()
  })

  onMount(() => {
    // Keep the "<time> ago" labels ticking every second.
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => window.clearInterval(timer))

    // ResizeObserver is the robust catch-all for content growth (streamed text,
    // tool cards, images) — it replaces per-token measurement.
    if (contentRef && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => pinToBottom())
      ro.observe(contentRef)
      onCleanup(() => ro.disconnect())
    }

    // Reset pinned state on session switches and jump once (explicit → smooth).
    requestAnimationFrame(() => {
      stick = true
      if (scrollRef) scrollRef.scrollTo({ top: scrollRef.scrollHeight, behavior: "smooth" })
    })
  })

  return (
    <div class="dsm-scroll" ref={scrollRef} onScroll={onScroll}>
      <div class="dsm-msglist" ref={contentRef}>
        <Show when={hasContent()}>
          <Show when={isCurrentCompacted()}>
            <CompactionDivider />
          </Show>
          <For each={turnKeys()}>
            {(key, i) => (
              <TurnBubble
                messages={() => groupFor(key)}
                busy={busy() && i() === turnKeys().length - 1}
              />
            )}
          </For>
          <For each={notices()}>{(n) => <NoticeRow notice={n} />}</For>
          {/* Only render a standalone streaming bubble when the session is busy
              but there are no messages yet (e.g. a brand-new chat). Otherwise the
              last turn bubble owns the reply + typing dots. */}
          <Show when={busy() && messages().length === 0}>
            <div class="dsm-turn">
              <div class="dsm-turn-main">
                <div class="dsm-turn-body">
                  <div class="dsm-turn-reply">
                    <div class="dsm-turn-assistant">
                      <TypingDots />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
