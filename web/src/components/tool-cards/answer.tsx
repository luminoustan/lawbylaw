/**
 * tool-cards/answer.tsx — the askquestion "Answer" card.
 */

import { createMemo, For, Show } from "solid-js"
import type { ToolPart } from "../../lib/types"
import { HelpCircleIcon } from "../icons"
import { ToolHead } from "./shared"

/** askquestion: an "Answer" card with the question and the chosen answer. */
export function AnswerCard(props: { part: ToolPart }) {
  const state = () => props.part.state
  const input = () => state().input
  const questions = () => (Array.isArray(input().questions) ? (input().questions as Array<Record<string, unknown>>) : [])
  const output = () => {
    const s = state()
    return s.status === "completed" ? s.output : ""
  }
  const title = () => (input().title as string) ?? "Answers"

  // The host's output is "Q (id): prompt\nA: label". Split it back into pairs
  // so the card can render the question and the chosen answer distinctly.
  const pairs = createMemo(() => {
    const out = output()
    if (!out) return []
    const result: Array<{ q: string; a: string }> = []
    const lines = out.split("\n")
    let q = ""
    for (const line of lines) {
      if (line.startsWith("Q ")) q = line.replace(/^Q\s*\([^)]*\):\s*/, "")
      else if (line.startsWith("A:")) result.push({ q, a: line.slice(2).trim() })
    }
    return result
  })

  return (
    <div class="dsm-tool dsm-tool--answer" data-status={state().status}>
      <ToolHead icon={<HelpCircleIcon size={13} />} label={title()} />
      <div class="dsm-answer-body">
        <Show
          when={pairs().length > 0}
          fallback={
            <For each={questions()}>
              {(q) => <div class="dsm-answer-q">{String(q.prompt ?? "")}</div>}
            </For>
          }
        >
          <For each={pairs()}>
            {(p) => (
              <div class="dsm-answer-item">
                <div class="dsm-answer-q">{p.q}</div>
                <div class="dsm-answer-a">{p.a}</div>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}
