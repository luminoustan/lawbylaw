/**
 * ContextUsage.tsx — the "Context Usage" popover content panel.
 *
 * Rendered inside a <Portal> by the context-ring trigger (components/ContextRing.tsx),
 * which owns the placement/anchor logic and the fixed-position wrapper. This
 * component owns only the panel's innards: the header, the "N% Full"/token
 * summary line, the stacked breakdown bar and the legend.
 *
 * "N% Full" and "~X / Y Tokens" (and every bar segment) are all computed
 * against the per-turn budget (SESSION_CONTEXT_BUDGET, 200K) from the most
 * recent assistant message's token breakdown; with no breakdown recorded the
 * panel shows an empty note instead of any fake bars.
 */

import { For, Show } from "solid-js"
import { useSession } from "../store/session"
import type { UiMessage } from "../store/types"
import type { WireTokenUsage } from "../lib/types"
import { XIcon } from "./icons"

/** The breakdown categories, in bar/legend order. */
const CATEGORIES = [
  { name: "System prompt",          key: "systemPrompt",       color: "var(--dsm-ramp-1)" },
  { name: "Tool definitions",       key: "toolDefinitions",    color: "var(--dsm-ramp-2)" },
  { name: "Subagent definitions",   key: "subagentDefinitions",color: "var(--dsm-ramp-3)" },
  { name: "Summarised conversation",key: "summarisedConversation", color: "var(--dsm-ramp-4)" },
  { name: "Conversation",           key: "conversation",       color: "var(--dsm-ramp-5)" },
] as const

function compactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n)
}

/** The most recent assistant message that carries a real token breakdown. */
export function lastBreakdown(messages: UiMessage[]): WireTokenUsage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== "assistant" || !m.tokens?.breakdown) continue
    const b = m.tokens.breakdown
    const total =
      (b.systemPrompt || 0) +
      (b.toolDefinitions || 0) +
      (b.subagentDefinitions || 0) +
      (b.summarisedConversation || 0) +
      (b.conversation || 0)
    if (total > 0) return m.tokens
  }
  return undefined
}

interface ContextBreakdown {
  systemPrompt: number
  toolDefinitions: number
  subagentDefinitions: number
  summarisedConversation: number
  conversation: number
  budget: number
}

export function ContextUsage(props: {
  messages: () => UiMessage[]
  liveBreakdown?: () => ContextBreakdown | undefined
  onClose: () => void
}) {
  const { state } = useSession()
  const turnTokens = () => lastBreakdown(props.messages())

  /** Prefer live breakdown (streamed during the turn) over the post-turn snapshot. */
  const activeBreakdown = (): ContextBreakdown | undefined => {
    const live = props.liveBreakdown?.()
    const id = state.currentSessionID
    const draft = id ? (state.draftTokens[id] || 0) : 0
    const base = live ?? (turnTokens()?.breakdown as ContextBreakdown | undefined)
    if (!base) return undefined
    return {
      ...base,
      conversation: (base.conversation || 0) + draft,
    }
  }

  const breakdownRows = () => {
    const b = activeBreakdown()
    if (!b) return []
    const rows: Array<{ name: string; value: number; color: string }> = []
    for (const cat of CATEGORIES) {
      const v = (b[cat.key] as number) || 0
      if (v > 0) rows.push({ name: cat.name, value: v, color: cat.color })
    }
    return rows
  }

  const overallTotal = () => breakdownRows().reduce((acc, r) => acc + r.value, 0)
  const budget = () => (activeBreakdown()?.budget ?? 0) > 0 ? activeBreakdown()!.budget : 0

  /** Denominator for "N% Full" and every bar segment: the turn budget when
   *  known, otherwise the category total (a safe fallback that never divides
   *  by zero). */
  const denominator = () => (budget() > 0 ? budget() : overallTotal() > 0 ? overallTotal() : 1)

  const pctFull = () =>
    budget() > 0 && overallTotal() > 0 ? Math.round((overallTotal() / budget()) * 1000) / 10 : 0

  const segWidth = (value: number) => Math.max(0, Math.min(100, Math.round((value / denominator()) * 1000) / 10))

  return (
    <>
      <div class="dsm-ctx-pop-head">
        <span class="dsm-ctx-pop-title">Context Usage</span>
        <button
          type="button"
          class="dsm-btn dsm-btn-icon dsm-ctx-pop-close"
          title="Close"
          aria-label="Close"
          onClick={props.onClose}
        >
          <XIcon size={15} />
        </button>
      </div>

      <Show
        when={breakdownRows().length > 0}
        fallback={<div class="dsm-ctx-pop-empty">No context usage recorded yet.</div>}
      >
        <div class="dsm-ctx-pop-summary">
          <span class="dsm-ctx-pop-pct">{pctFull()}% Full</span>
          <span class="dsm-ctx-pop-figures">
            ~{compactTokens(overallTotal())} / {compactTokens(budget() || overallTotal())} Tokens
          </span>
        </div>

        <div class="dsm-ctx-pop-track" aria-hidden="true">
          <For each={breakdownRows()}>
            {(row) => (
              <span class="dsm-ctx-pop-seg" style={{ width: `${segWidth(row.value)}%`, background: row.color }} />
            )}
          </For>
        </div>

        <dl class="dsm-ctx-pop-legend">
          <For each={breakdownRows()}>
            {(row) => (
              <div class="dsm-ctx-pop-row">
                <dt>
                  <span class="dsm-ctx-pop-swatch" style={{ background: row.color }} aria-hidden="true" />
                  {row.name}
                </dt>
                <dd>{compactTokens(row.value)}</dd>
              </div>
            )}
          </For>
        </dl>
      </Show>
    </>
  )
}
