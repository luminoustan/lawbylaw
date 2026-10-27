/**
 * tool-cards/legal.tsx — cards for the legal research tools (ported from grpo's
 * ToolCallBadge): per-tool icon and name, what is being researched, a live
 * phase label ("Researching legislation…", "Synthesizing answer…"), search
 * count and elapsed timer while running, and an expandable result. For
 * `classify_issue` it also renders the interactive follow-up questions form.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { isRunningToolStatus } from "../../lib/tool-display"
import type { ToolPart } from "../../lib/types"
import { useSession } from "../../store/session"
import { AlertTriangleIcon } from "../icons"
import { toolIcon } from "./shared"

interface Meta {
  label: string
  running: string
}

const META: Record<string, Meta> = {
  research_legislation: { label: "Legislation research", running: "Researching legislation…" },
  legislation_agent: { label: "Legislation research", running: "Researching legislation…" },
  research_subsidiary_legislation: { label: "Subsidiary legislation research", running: "Researching subsidiary legislation…" },
  research_sl: { label: "Subsidiary legislation research", running: "Researching subsidiary legislation…" },
  judiciary_agent: { label: "Case law research", running: "Researching case law…" },
  research_judiciary: { label: "Case law research", running: "Researching case law…" },
  get_judgment: { label: "Read judgment", running: "Reading judgment…" },
  search_judiciary: { label: "Case law search", running: "Searching judgments…" },
  search_legislation: { label: "Legislation search", running: "Searching legislation…" },
  get_section: { label: "Read section", running: "Reading provision…" },
  classify_issue: { label: "Classify issue", running: "Classifying…" },
}

const str = (v: unknown) => (typeof v === "string" ? v : "")

function subtitleOf(tool: string, input: Record<string, unknown>): string {
  if (tool === "classify_issue") return str(input.summary)
  if (input.prompt) return str(input.prompt).slice(0, 140)
  if (input.query) return `“${str(input.query)}”`
  if (input.case) return `${str(input.case)}${input.part ? ` (part ${str(input.part)})` : ""}`
  if (input.section_id) return `${str(input.source_file)} ${str(input.section_id)}`.trim()
  return ""
}

const fmt = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`)

export function LegalToolCard(props: { part: ToolPart }) {
  const { currentMessages, isCurrentBusy, sendPrompt } = useSession()
  const [open, setOpen] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())

  const state = () => props.part.state
  const tool = () => props.part.tool
  const meta = () => META[tool()] ?? { label: tool(), running: "Working…" }
  const running = () => isRunningToolStatus(state().status)
  const isError = () => state().status === "error"
  const output = () => {
    const s = state()
    return s.status === "completed" ? s.output : ""
  }
  const md = () => (props.part.metadata ?? {}) as { phase?: string; searches?: number; startedAt?: number }
  const phaseLabel = () => (md().phase === "synthesising" || md().phase === "synthesizing" ? "Synthesizing answer…" : meta().running)
  const elapsed = () => (running() && md().startedAt ? Math.max(0, Math.floor((now() - md().startedAt!) / 1000)) : 0)

  createEffect(() => {
    if (!running()) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(t))
  })

  const Icon = toolIcon(tool())

  // classify_issue: ask the user the model's follow-up questions, but only while
  // this is still the latest turn.
  const questions = createMemo(() => {
    if (tool() !== "classify_issue") return []
    const d = state().input.missing_details
    return Array.isArray(d) ? d.map(String).filter(Boolean).slice(0, 8) : []
  })
  const formActive = () => {
    if (questions().length === 0 || state().status !== "completed" || isCurrentBusy()) return false
    const list = currentMessages()
    const last = list[list.length - 1]
    return !!last && last.role === "assistant" && last.id === props.part.messageID
  }

  return (
    <>
      <div class="dsm-tool dsm-legal" data-status={state().status}>
        <button
          type="button"
          class="dsm-legal-head"
          aria-expanded={open()}
          disabled={running() || (!output() && !isError())}
          onClick={() => setOpen((v) => !v)}
        >
          <span class="dsm-tool-icon">{isError() ? <AlertTriangleIcon size={13} /> : <Icon size={13} />}</span>
          <span class="dsm-legal-name">{meta().label}</span>
          <span class="dsm-legal-sub">{subtitleOf(tool(), state().input)}</span>
          <Show when={running()}>
            <span class="dsm-legal-live">
              <span class="dsm-legal-phase">{phaseLabel()}</span>
              <Show when={(md().searches ?? 0) > 0}>
                <span class="dsm-legal-count">{md().searches} searches</span>
              </Show>
              <Show when={elapsed() > 0}>
                <span class="dsm-legal-count">{fmt(elapsed())}</span>
              </Show>
            </span>
          </Show>
          <Show when={!running() && (output() || isError())}>
            <span class="dsm-tool-group-caret" data-open={open()}>›</span>
          </Show>
        </button>
        <Show when={open()}>
          <div class="dsm-legal-body">{isError() ? (state() as { error: string }).error : output()}</div>
        </Show>
      </div>
      <Show when={formActive()}>
        <FollowUpForm questions={questions()} onSend={(t) => sendPrompt(t)} />
      </Show>
    </>
  )
}

const SKIPPED = "__skipped__"

function FollowUpForm(props: { questions: string[]; onSend: (text: string) => void }) {
  const [answers, setAnswers] = createSignal<Record<number, string>>({})
  const set = (i: number, v: string) => setAnswers((p) => ({ ...p, [i]: v }))
  const any = () => Object.values(answers()).some((v) => v.length > 0)
  const all = () => props.questions.every((_, i) => (answers()[i] ?? "").length > 0)

  const submit = (e: Event) => {
    e.preventDefault()
    if (!any()) return
    const parts = props.questions
      .map((q, i) => {
        const raw = answers()[i] ?? ""
        if (raw === SKIPPED) return null
        return `**${q}**\n${raw.trim() || "(no answer)"}`
      })
      .filter(Boolean)
    props.onSend(parts.length ? parts.join("\n\n") : "Please proceed with the information already provided.")
    setAnswers({})
  }

  return (
    <form class="dsm-followup" aria-label="Follow-up questions" onSubmit={submit}>
      <p class="dsm-followup-intro">Please answer these questions so I can help further</p>
      <For each={props.questions}>
        {(q, i) => {
          const val = () => answers()[i()] ?? ""
          const skipped = () => val() === SKIPPED
          return (
            <div class="dsm-followup-q">
              <div class="dsm-followup-row">
                <label for={`fu-${i()}`} classList={{ "is-skipped": skipped() }}>{q}</label>
                <button type="button" class="dsm-followup-link" onClick={() => set(i(), skipped() ? "" : SKIPPED)}>
                  {skipped() ? "Unskip" : "Skip"}
                </button>
              </div>
              <Show when={!skipped()}>
                <div class="dsm-followup-input">
                  <input
                    id={`fu-${i()}`}
                    type="text"
                    value={val()}
                    maxLength={500}
                    placeholder="Your answer…"
                    autocomplete="off"
                    enterkeyhint="send"
                    onInput={(e) => set(i(), e.currentTarget.value)}
                  />
                  <button type="button" classList={{ "is-on": val().toLowerCase() === "yes" }} onClick={() => set(i(), val().toLowerCase() === "yes" ? "" : "Yes")}>Yes</button>
                  <button type="button" classList={{ "is-on": val().toLowerCase() === "no" }} onClick={() => set(i(), val().toLowerCase() === "no" ? "" : "No")}>No</button>
                </div>
              </Show>
              <Show when={skipped()}>
                <p class="dsm-followup-skipped">This question will be skipped</p>
              </Show>
            </div>
          )
        }}
      </For>
      <div class="dsm-followup-actions">
        <button
          type="button"
          class="dsm-followup-link"
          disabled={all()}
          onClick={() => setAnswers(Object.fromEntries(props.questions.map((_, i) => [i, SKIPPED])))}
        >
          Skip all
        </button>
        <button type="submit" class="dsm-btn dsm-followup-send" disabled={!any()}>Send answers</button>
      </div>
    </form>
  )
}
