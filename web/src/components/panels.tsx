/**
 * panels.tsx — session-scoped panels docked around the composer:
 *  - QuestionDock (askquestion tool → questionReply)
 *  - ErrorBanner  (sendMessageFailed)
 */

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useSession } from "../store/session"
import { visibleErrorBanner } from "../lib/error-banner"
import type { QuestionInfo } from "../lib/types"
import { AlertIcon, ChevronDownIcon, HelpCircleIcon, XIcon } from "./icons"

// ── Askquestion dock ─────────────────────────────────────────────────────────
// A "Questions" card styled like the reference: header (? Questions / page
// count / collapse), one question per page with lettered option rows, an
// always-present "Other..." row that reveals a free-text area, and a
// "Skip Esc" / "Continue" footer. Answers are buffered per page and submitted
// as one array (one entry per question) in order.

const OTHER = "Other..."

const isOtherLabel = (label: string): boolean => {
  const n = label.trim().toLowerCase()
  return n === "other" || n === "other..."
}

interface OtherOption {
  id?: string
  label: string
  other?: boolean
}

interface BufEntry {
  sel: string[]
  custom: string
}

export function QuestionDock() {
  const { answerQuestion, dismissQuestion, editingMessageID, state } = useSession()
  const [selected, setSelected] = createSignal<Record<string, string[]>>({})
  const [custom, setCustom] = createSignal<Record<string, string>>({})
  const [page, setPage] = createSignal(0)
  const [open, setOpen] = createSignal(true)
  const [buf, setBuf] = createSignal<Record<number, BufEntry>>({})
  let customRef: HTMLTextAreaElement | undefined

  // A question belongs to the session whose turn asked it. Showing the dock in
  // another session would let the user answer it from the wrong place, which
  // would start a turn in a session they cannot see.
  const active = () => {
    const q = state.activeQuestion
    if (!q) return null
    if (q.sessionID && q.sessionID !== state.currentSessionID) return null
    return q
  }
  const questions = () => active()?.questions ?? []
  const currentQ = () => questions()[page()]

  // Reset everything when a new question request arrives.
  let lastRequestId: string | null = null
  createEffect(() => {
    const rid = active()?.requestId ?? null
    if (rid !== lastRequestId) {
      lastRequestId = rid
      setSelected({})
      setCustom({})
      setPage(0)
      setBuf({})
    }
  })

  // Focus the free-text box as soon as "Other..." becomes the chosen option.
  createEffect(() => {
    const q = currentQ()
    if (q && (selected()[q.id] ?? []).includes(OTHER)) customRef?.focus()
  })

  const displayOptions = (q: QuestionInfo): OtherOption[] => [
    ...q.options.filter((o) => !isOtherLabel(o.label)),
    { id: "__other__", label: OTHER, other: true },
  ]

  const toggle = (q: QuestionInfo, label: string) => {
    const current = selected()[q.id] ?? []
    let next: string[]
    if (q.allow_multiple) {
      next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label]
    } else {
      next = current.includes(label) ? [] : [label]
    }
    setSelected((prev) => ({ ...prev, [q.id]: next }))
    if (!next.includes(OTHER)) setCustom((prev) => ({ ...prev, [q.id]: "" }))
  }

  const onCustom = (qid: string, text: string) => setCustom((prev) => ({ ...prev, [qid]: text }))

  const isAnswered = (q?: QuestionInfo) => {
    if (!q) return false
    const sel = selected()[q.id] ?? []
    if (sel.length === 0) return false
    if (sel.includes(OTHER) && !(custom()[q.id] ?? "").trim()) return false
    return true
  }

  const resolveAnswer = (entry?: BufEntry): string[] => {
    const sel = entry?.sel ?? []
    const customText = (entry?.custom ?? "").trim()
    return sel.map((l) => (l === OTHER ? customText || OTHER : l))
  }

  const reset = () => {
    setSelected({})
    setCustom({})
    setPage(0)
    setBuf({})
  }

  const goPage = (idx: number) => {
    const q = questions()[idx]
    if (!q) return
    // Preserve the page being left before switching, so paging away and back
    // does not discard the current selection.
    const cur = currentQ()
    const nextBuf = cur
      ? {
          ...buf(),
          [page()]: { sel: selected()[cur.id] ?? [], custom: custom()[cur.id] ?? "" },
        }
      : buf()
    setBuf(nextBuf)
    const entry = nextBuf[idx]
    if (entry) {
      setSelected({ [q.id]: entry.sel })
      setCustom({ [q.id]: entry.custom })
    } else {
      setSelected({})
      setCustom({})
    }
    setPage(idx)
  }

  const submit = (req: { requestId: string; questions: QuestionInfo[] }) => {
    const q = currentQ()
    if (!q || !isAnswered(q)) return
    const nextBuf = {
      ...buf(),
      [page()]: { sel: selected()[q.id] ?? [], custom: custom()[q.id] ?? "" },
    }
    setBuf(nextBuf)
    if (page() < req.questions.length - 1) {
      setPage(page() + 1)
      setSelected({})
      setCustom({})
      return
    }
    const answers = req.questions.map((_, i) => resolveAnswer(nextBuf[i]))
    answerQuestion(answers)
    reset()
  }

  // Escape skips the question panel (unless the user is mid-edit in the composer).
  const onWindowKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !active()) return
    if (editingMessageID()) return
    e.preventDefault()
    dismissQuestion()
    reset()
  }
  onMount(() => {
    window.addEventListener("keydown", onWindowKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onWindowKeyDown))
  })

  return (
    <Show when={active()}>
      {(qget) => {
        const q = qget()
        const count = q.questions.length
        return (
          <section class="dsm-question" classList={{ "is-collapsed": !open() }}>
            <div class="dsm-question-head">
              <span class="dsm-question-head-icon">
                <HelpCircleIcon size={14} />
              </span>
              <span class="dsm-question-head-title">Questions</span>
              <span class="dsm-question-head-spacer" />
              <div class="dsm-question-head-nav">
                {count > 1 ? (
                  <>
                    <button type="button" class="dsm-question-navbtn" disabled={page() === 0} onClick={() => goPage(page() - 1)} aria-label="Previous question">
                      ‹
                    </button>
                    <span class="dsm-question-count">
                      {page() + 1} of {count}
                    </span>
                    <button
                      type="button"
                      class="dsm-question-navbtn"
                      disabled={page() === count - 1}
                      onClick={() => goPage(page() + 1)}
                      aria-label="Next question"
                    >
                      ›
                    </button>
                  </>
                ) : (
                  <span class="dsm-question-count">1 of 1</span>
                )}
                <button
                  type="button"
                  class="dsm-question-navbtn dsm-question-collapse"
                  onClick={() => setOpen((o) => !o)}
                  title={open() ? "Collapse" : "Expand"}
                  aria-label={open() ? "Collapse questions" : "Expand questions"}
                  aria-expanded={open()}
                >
                  <ChevronDownIcon size={13} class="is-collapsed-ic" />
                </button>
              </div>
            </div>

            <Show when={open()}>
              <div class="dsm-question-body">
                <Show when={q.title}>
                  <span class="dsm-question-subtitle">{q.title}</span>
                </Show>
                <Show when={currentQ()}>
                  {(cq) => (
                    <div class="dsm-question-item">
                      <div class="dsm-question-q">
                        <span class="dsm-question-number">{page() + 1}.</span>
                        <span class="dsm-question-prompt">{cq().prompt}</span>
                      </div>
                      <div class="dsm-question-options">
                        <For each={displayOptions(cq())}>
                          {(opt, i) => {
                            const isOther = () => opt.other === true
                            const active = () => (selected()[cq().id] ?? []).includes(opt.label)
                            const letter = String.fromCharCode(65 + i())
                            return (
                              <div class="dsm-question-option-row">
                                <button
                                  type="button"
                                  class="dsm-question-opt"
                                  classList={{ "is-active": active() }}
                                  aria-pressed={active()}
                                  onClick={() => toggle(cq(), opt.label)}
                                >
                                  <span class="dsm-question-opt-key">{letter}</span>
                                  <span class="dsm-question-opt-label">{opt.label}</span>
                                </button>
                                <Show when={isOther() && active()}>
                                  <textarea
                                    ref={customRef}
                                    class="dsm-question-custom"
                                    value={custom()[cq().id] ?? ""}
                                    placeholder="Type your own answer…"
                                    aria-label={`Custom answer for: ${cq().prompt}`}
                                    onInput={(e) => onCustom(cq().id, e.currentTarget.value)}
                                  />
                                </Show>
                              </div>
                            )
                          }}
                        </For>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
              <div class="dsm-question-actions">
                <button type="button" class="dsm-question-skip" onClick={() => { dismissQuestion(); reset() }}>
                  Skip <kbd aria-hidden="true">Esc</kbd>
                </button>
                <button
                  type="button"
                  class="dsm-question-continue"
                  disabled={!isAnswered(currentQ())}
                  onClick={() => submit(q)}
                >
                  Continue <span class="dsm-question-continue-arrow">→</span>
                </button>
              </div>
            </Show>
          </section>
        )
      }}
    </Show>
  )
}

// ── sendMessageFailed banner ─────────────────────────────────────────────────

export function ErrorBanner() {
  const { state, dismissBanner } = useSession()
  // Only show a banner raised by the session being viewed; see lib/error-banner.
  const banner = () => visibleErrorBanner(state.errorBanner, state.currentSessionID)
  return (
    <Show when={banner()}>
      {(bget) => {
        const b = bget()
        return (
          <div class="dsm-error-banner" role="alert">
            <AlertIcon size={14} />
            <span class="dsm-error-text">{b.message}</span>
            <button
              type="button"
              class="dsm-btn dsm-btn-icon"
              aria-label="Dismiss"
              onClick={dismissBanner}
            >
              <XIcon size={13} />
            </button>
          </div>
        )
      }}
    </Show>
  )
}
