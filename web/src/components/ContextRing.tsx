/**
 * ContextRing.tsx — a small SVG progress ring beside the composer send button,
 * now also the trigger for a "Context Usage" popover.
 *
 * The ring answers "how much of the context window has this session used so
 * far". Real data only, all from the store:
 *   - used tokens  : currentUsage() → SessionUsageData.totals.tokens
 *                    (input + output + reasoning), refreshed by
 *                    requestSessionModelUsage / sessionModelUsageLoaded /
 *                    sessionModelUsageChanged.
 *   - context size : the live breakdown's budget, else the server's
 *                    `limits.context_tokens` (state.config), capped at 200k.
 *
 * Clicking / activating the ring (it is a real <button>: role/Enter/Space are
 * native) opens a small "Context Usage" popover anchored next to the gauge,
 * NOT a centered modal. The popover's inner content (header, summary line,
 * breakdown bar, legend) lives in components/ContextUsage.tsx; this module
 * owns the trigger, the gauge arc and the anchor/placement logic only.
 *
 * The popover is portaled to document.body and pinned with position: fixed
 * from the trigger's live bounding rect (the same pattern MenuSelect uses for
 * .dsm-menu-pop): it opens upward when there is more room above the gauge,
 * else downward, right-aligned to the gauge without overflowing the viewport.
 * There is no fullscreen backdrop — it closes on outside pointerdown, Escape,
 * scroll, and resize, and restores focus to the ring trigger on close. The
 * gauge's own fill stays driven by used-vs-context-window (a window
 * hint); only the popover's "N% Full" and "~X / Y" are computed against the
 * turn budget.
 */

import { createEffect, createMemo, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useSession } from "../store/session"
import { usePopover, popoverStyle } from "../lib/use-popover"
import { ContextUsage, lastBreakdown } from "./ContextUsage"

const RADIUS = 14
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const VIEWBOX = 34

const POP_MAX_HEIGHT = 320
const POP_MAX_WIDTH = 300

export function ContextRing() {
  const { state, currentUsage, currentMessages } = useSession()
  const sid = () => state.currentSessionID

  // ---- gauge: used vs context window budget -------------------------------
  /** Live breakdown accessor for the gauge and the popover. */
  const liveBreakdown = () => {
    const id = sid()
    return id ? state.liveBreakdown[id] : undefined
  }

  // Memoized: several gauge accessors read it, and the fallback walk over the
  // transcript should run at most once per change.
  const contextLimit = createMemo(() => {
    const live = liveBreakdown()
    if (live && live.budget > 0) return live.budget
    const last = lastBreakdown(currentMessages())
    if (last?.breakdown?.budget && last.breakdown.budget > 0) return last.breakdown.budget
    const windowTokens = (state.config as { limits?: { context_tokens?: number } }).limits?.context_tokens
    if (windowTokens && windowTokens > 0 && windowTokens < 200_000) return windowTokens
    return 200_000
  })

  const usedTokens = () => {
    // Prefer live breakdown total (updates during streaming and when idle) over post-turn usage
    const id = sid()
    const live = id ? state.liveBreakdown[id] : undefined
    const draft = id ? (state.draftTokens[id] || 0) : 0
    if (live) {
      return (
        (live.systemPrompt || 0) +
        (live.toolDefinitions || 0) +
        (live.subagentDefinitions || 0) +
        (live.summarisedConversation || 0) +
        (live.conversation || 0) +
        draft
      )
    }
    const usage = currentUsage()
    const t = usage?.totals?.tokens
    if (!t) return 0
    return (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + draft
  }

  const fraction = () => {
    const limit = contextLimit()
    if (limit <= 0 || usedTokens() <= 0) return 0
    return Math.min(1, usedTokens() / limit)
  }

  const hasLimit = () => contextLimit() > 0
  const stateKind = () => {
    if (!hasLimit() || usedTokens() <= 0) return "idle"
    if (fraction() >= 0.9) return "warn"
    return "ok"
  }

  const used = () => usedTokens()
  const limit = () => contextLimit()
  const pct = () => Math.round(fraction() * 100)
  const title = () => {
    const base = `${used().toLocaleString()} tokens used`
    return limit() > 0
      ? `${base} of ${limit().toLocaleString()} context window (${pct()}% full)`
      : `${base} (context size unknown)`
  }

  const arc = () => CIRCUMFERENCE * (1 - fraction())

  // ---- popover: anchor/placement (content rendered by ContextUsage) --------
  const pop = usePopover({
    align: "end",
    maxWidth: POP_MAX_WIDTH,
    restoreFocus: true,
    onEscape: (e) => e.preventDefault(),
  })
  let popEl: HTMLDivElement | undefined

  const aria = () => `${title()}. ${pop.open() ? "Close" : "Open"} context usage.`

  // Focus the popover once it mounts; restore to the trigger happens in close().
  createEffect(() => {
    if (pop.open()) queueMicrotask(() => popEl?.focus())
  })

  return (
    <>
      <button
        ref={pop.setTriggerRef}
        type="button"
        class="dsm-ctx"
        classList={{ "is-open": pop.open() }}
        data-state={stateKind()}
        title={title()}
        aria-label={aria()}
        aria-haspopup="dialog"
        aria-expanded={pop.open()}
        onClick={pop.toggle}
      >
        <svg class="dsm-ctx-ring" viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`} width={24} height={24} aria-hidden="true">
          <circle class="dsm-ctx-track" cx={VIEWBOX / 2} cy={VIEWBOX / 2} r={RADIUS} />
          <circle
            class="dsm-ctx-arc"
            cx={VIEWBOX / 2}
            cy={VIEWBOX / 2}
            r={RADIUS}
            stroke-dasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            stroke-dashoffset={arc()}
            transform={`rotate(-90 ${VIEWBOX / 2} ${VIEWBOX / 2})`}
          />
        </svg>
      </button>

      <Portal>
        <Show when={pop.open()}>
          <div
            ref={(el: HTMLDivElement) => { popEl = el; pop.setPopRef(el) }}
            class="dsm-ctx-pop"
            role="dialog"
            aria-label="Context Usage"
            tabindex="-1"
            style={popoverStyle(pop.pos(), POP_MAX_HEIGHT)}
          >
            <ContextUsage messages={currentMessages} liveBreakdown={liveBreakdown} onClose={pop.close} />
          </div>
        </Show>
      </Portal>
    </>
  )
}
