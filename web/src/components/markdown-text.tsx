/**
 * markdown-text.tsx — the shared markdown container for user + assistant text.
 *
 * While a reply streams, only the settled prefix is re-parsed as Markdown and
 * the growing tail is a plain text node (see `splitSettled`).
 */

import { createMemo, createSignal, Show } from "solid-js"
import { renderMarkdown } from "../lib/markdown-lite"
import { copyText, postHostMessage } from "../lib/host-link"
import { MermaidLightbox } from "./MermaidLightbox"
import { ConfirmDialog } from "./ConfirmDialog"

// ── Markdown container (shared by user + assistant text) ─────────────────────

/** True when the line `[start, end)` opens or closes a fenced code block. */
function isFenceLine(s: string, start: number, end: number): boolean {
  let j = start
  while (j < end && (s[j] === " " || s[j] === "\t")) j++
  return s[j] === "`" && s[j + 1] === "`" && s[j + 2] === "`"
}

/**
 * Split a still-streaming reply into the part that is safe to render as
 * Markdown and the still-growing tail.
 *
 * The split point is the last blank-line boundary that is not inside an
 * unclosed fenced code block. A fence that is still arriving therefore stays in
 * the tail and is never half-rendered — and, more importantly, a ```mermaid
 * fence is not re-parsed into a fresh inline SVG on every single token.
 *
 * One linear pass: `openFence` tracks the offset of an unclosed fence (or -1).
 */
export function splitSettled(text: string): { prefix: string; tail: string } {
  let openFence = -1
  let i = 0
  while (i < text.length) {
    const nl = text.indexOf("\n", i)
    const end = nl === -1 ? text.length : nl
    if (isFenceLine(text, i, end)) openFence = openFence === -1 ? i : -1
    if (nl === -1) break
    i = nl + 1
  }
  const limit = openFence === -1 ? text.length : openFence
  const idx = text.lastIndexOf("\n\n", limit)
  const boundary = idx === -1 ? 0 : idx + 2
  return { prefix: text.slice(0, boundary), tail: text.slice(boundary) }
}

export function MarkdownText(props: { text: () => string; hardBreaks?: boolean; streaming?: boolean }) {
  // Only the settled prefix is re-parsed, and `createMemo`'s default equality
  // means that happens when the boundary actually moves rather than per token.
  const prefix = createMemo(() => {
    const t = props.text()
    if (!t) return ""
    return props.streaming ? splitSettled(t).prefix : t
  })
  const tail = createMemo(() => {
    const t = props.text()
    if (!t || !props.streaming) return ""
    return splitSettled(t).tail
  })

  const html = createMemo(() => {
    const p = prefix()
    return p ? renderMarkdown(p, { hardBreaks: props.hardBreaks }) : ""
  })

  let root: HTMLDivElement | undefined

  const [mermaid, setMermaid] = createSignal<string | null>(null)
  const [pendingUrl, setPendingUrl] = createSignal<string | null>(null)

  /**
   * Capture the live diagram as markup for the fullscreen viewer. The clone's
   * inline size overrides are replaced with the viewBox's natural size so the
   * viewer's fit/zoom math is not constrained by the transcript layout.
   */
  const openMermaid = (diagram: HTMLElement) => {
    const svg = diagram.querySelector<SVGSVGElement>(".dsm-mermaid-svg")
    if (!svg) return
    const clone = svg.cloneNode(true) as SVGSVGElement
    const vb = svg.viewBox.baseVal
    const w = vb?.width || svg.clientWidth
    const h = vb?.height || svg.clientHeight
    clone.style.width = `${w}px`
    clone.style.height = `${h}px`
    clone.style.maxWidth = "none"
    clone.style.minWidth = "0"
    clone.style.margin = "0"
    setMermaid(clone.outerHTML)
  }

  const onMarkdownClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null
    const anchor = target?.closest?.("a[data-href]") as HTMLAnchorElement | null
    if (anchor) {
      e.preventDefault()
      e.stopPropagation()
      const url = anchor.getAttribute("data-href")
      if (url) setPendingUrl(url)
      return
    }

    // The diagram block is injected HTML, so the fullscreen trigger is wired
    // by delegation too (MermaidLightbox renders the overlay itself).
    const diagram = target?.closest?.(".dsm-mermaid-diagram") as HTMLElement | null
    if (diagram) {
      e.preventDefault()
      e.stopPropagation()
      openMermaid(diagram)
      return
    }

    // Copy buttons live inside the injected markdown HTML, so they are wired
    // by delegation rather than Solid handlers. The code is read back from the
    // block's <pre> elements, whose textContent decodes the escaped markup.
    // A collapsed block has two <pre>s (preview + hidden tail), so join them.
    const copyBtn = target?.closest?.(".dsm-code-copy") as HTMLButtonElement | null
    if (!copyBtn) return
    e.preventDefault()
    e.stopPropagation()
    const block = copyBtn.closest(".dsm-code")
    const code = block
      ? Array.from(block.querySelectorAll("pre"))
          .map((pre) => pre.textContent ?? "")
          .join("\n")
      : ""
    if (!code) return
    void copyText(code).then((ok) => {
      if (!ok) return
      copyBtn.classList.add("is-copied")
      window.setTimeout(() => copyBtn.classList.remove("is-copied"), 1600)
    })
  }

  /** Enter/Space on a focused diagram opens the fullscreen viewer, matching
   *  the click affordance on the injected HTML. */
  const onMarkdownKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return
    const diagram = (e.target as HTMLElement | null)?.closest?.(".dsm-mermaid-diagram") as HTMLElement | null
    if (!diagram) return
    e.preventDefault()
    e.stopPropagation()
    openMermaid(diagram)
  }

  return (
    <>
      <div
        ref={root}
        class="dsm-md"
        classList={{ "dsm-md--streaming": Boolean(props.streaming) }}
        onClick={onMarkdownClick}
        onKeyDown={onMarkdownKeyDown}
      >
        {/* Settled blocks: rendered Markdown, re-parsed only when the safe
            boundary moves. The markdown-lite output is fully escaped before
            markup is applied. */}
        <div class="dsm-md-settled" innerHTML={html()} />
        {/* The live tail is a plain text node: it updates in place per delta
            with no parsing, no subtree rebuild and no scroll-height jump from
            half-rendered markup. */}
        <Show when={tail()}>
          <p class="dsm-md-tail">{tail()}</p>
        </Show>
      </div>
      <MermaidLightbox open={Boolean(mermaid())} svg={mermaid() ?? ""} onClose={() => setMermaid(null)} />
      <ConfirmDialog
        open={pendingUrl() !== null}
        title="Open external link?"
        message="This will open the following link in a new browser tab."
        detail={pendingUrl() ?? ""}
        notice="Bright light warning: the page may load in a bright white theme. If you are in a dark room or using dark mode, it may be harsh on your eyes."
        confirmLabel="Open link"
        onConfirm={() => {
          const url = pendingUrl()
          setPendingUrl(null)
          if (url) postHostMessage({ type: "openExternal", url })
        }}
        onCancel={() => setPendingUrl(null)}
      />
    </>
  )
}
