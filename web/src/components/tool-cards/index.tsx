/**
 * tool-cards/index.tsx — the tool-part dispatcher and the grouped summary row.
 */

import { createMemo, createSignal, For, Show } from "solid-js"
import type { ToolPart } from "../../lib/types"
import { toolCategory } from "../../lib/tool-display"
import { AnswerCard } from "./answer"
import { LegalToolCard } from "./legal"
import { SummaryRow } from "./summary"
import { TaskCard } from "./task"

/** Dispatch a tool part to its renderer. */
export function ToolCard(props: { part: ToolPart }) {
  const cat = () => toolCategory(props.part.tool)

  if (cat() === "legal") return <LegalToolCard part={props.part} />
  if (cat() === "ask") return <AnswerCard part={props.part} />
  if (cat() === "task") return <TaskCard part={props.part} />
  return <SummaryRow part={props.part} />
}

// ── Grouped search/web summary ───────────────────────────────────────────────
//
// A run of consecutive web searches folds into one collapsible row
// ("Explored 2 web searches ⌄"): the header counts the calls and expands to the
// individual summary lines.

export function ToolGroup(props: { parts: ToolPart[] }) {
  const [open, setOpen] = createSignal(false)
  const parts = () => props.parts

  const label = createMemo(() => {
    const n = parts().length
    return `Explored ${n} web search${n === 1 ? "" : "es"}`
  })

  return (
    <div class="dsm-tool-group">
      <button
        type="button"
        class="dsm-tool-group-head"
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
      >
        <span class="dsm-tool-group-caret" data-open={open()}>
          ›
        </span>
        <span class="dsm-tool-group-label">{label()}</span>
      </button>
      <Show when={open()}>
        <div class="dsm-tool-group-body">
          <For each={parts()}>
            {(p) => <SummaryRow part={p} />}
          </For>
        </div>
      </Show>
    </div>
  )
}
