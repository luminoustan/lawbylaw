/**
 * parts.tsx — message-part renderers that are not tool cards.
 *
 * ReasoningBlock and UnknownPartCard plus the per-part
 * dispatcher. Tool cards live in components/tool-cards/; the markdown
 * container lives in components/markdown-text.tsx.
 */

import { createSignal, Show } from "solid-js"
import { isToolPart, type ReasoningPart, type TextPart, type ToolPart, type WirePart } from "../lib/types"
import { MarkdownText } from "./markdown-text"
import { ToolCard } from "./tool-cards"

// ── Reasoning (thinking) block ───────────────────────────────────────────────

function ReasoningBlock(props: { text: () => string; streaming?: boolean }) {
  // Collapsed by default — the user expands it if they want to read the
  // reasoning. The summary still shows the streaming "Thinking..." indicator.
  const [open, setOpen] = createSignal(false)
  return (
    <details class="dsm-reasoning" open={open()} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span class="dsm-reasoning-glyph" aria-hidden="true" />
        <Show when={props.streaming} fallback={<span>Reasoning</span>}>
          <span class="dsm-reasoning-thinking">
            <span class="dsm-reasoning-dot" />
            <span class="dsm-reasoning-dot" />
            <span class="dsm-reasoning-dot" />
            Thinking...
          </span>
        </Show>
      </summary>
      <div class="dsm-reasoning-body">{props.text()}</div>
    </details>
  )
}

function UnknownPartCard(props: { part: WirePart }) {
  return (
    <div class="dsm-unknown-part">
      <span class="dsm-unknown-tag">{props.part.type}</span>
      <pre>{JSON.stringify(props.part, null, 2)}</pre>
    </div>
  )
}

// ── Part stream ──────────────────────────────────────────────────────────────

export function PartRenderer(props: { part: WirePart; busy: boolean; streaming?: boolean; hardBreaks?: boolean }) {
  const p = () => props.part
  // Every branch reads the live part through `p()` rather than capturing it:
  // a part row is now reused across updates, so the accessors must see the
  // replacement object the store hands back for the same part id.
  if (p().type === "text") {
    return <MarkdownText text={() => (p() as TextPart).text} hardBreaks={props.hardBreaks} streaming={props.streaming} />
  }
  // Image parts saved by earlier versions (when images could be attached) are not shown.
  if (p().type === "image") return null
  if (p().type === "reasoning") {
    return <ReasoningBlock text={() => (p() as ReasoningPart).text} streaming={props.streaming && props.busy} />
  }
  if (isToolPart(p())) {
    return <ToolCard part={p() as ToolPart} />
  }
  return <UnknownPartCard part={p()} />
}
