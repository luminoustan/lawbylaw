/**
 * SelectionToolbar.tsx — a floating "Add to chat" button that appears next to a
 * text selection in the message list.
 *
 * Clicking it dispatches `dsm-insert-text`; the Composer listens for that and
 * turns the payload into a removable quote pill. Portaled to <body> so the
 * `position: fixed` coordinates from getBoundingClientRect() are not affected
 * by any transformed ancestor.
 *
 * Only selections inside `.dsm-msglist` (assistant text and tool output) are
 * offered — a caret in the composer must not raise the button.
 */

import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { ChatIcon } from "./icons"

interface SelectionState {
  text: string
  top: number
  left: number
  below: boolean
}

/** Gap between the selection edge and the button. */
const GAP = 8
/** Below this viewport offset there is no room above, so the button drops below. */
const TOP_LIMIT = 44

/**
 * Interactive chrome that lives inside the transcript but is not content: the
 * code block's language label + Copy pill, the group caret, and the turn footer (copy button, "Worked for 5s", "16m ago").
 * `Selection.toString()` happily returns their labels, so they are dropped here.
 */
const CHROME_SELECTOR = [
  ".dsm-code-head",
  ".dsm-code-copy",
  ".dsm-code-more > summary",
  ".dsm-mermaid-source > summary",
  ".dsm-tool-group-caret",
  ".dsm-turn-actions",
].join(", ")

/** Blocks that read as their own paragraph, so a blank line follows them. */
const PARAGRAPH_TAGS = new Set([
  "ARTICLE",
  "BLOCKQUOTE",
  "DIV",
  "FIGURE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
])
/** Blocks that read as list rows, so only a single line break follows them. */
const LIST_TAGS = new Set(["DD", "DT", "LI", "TR"])

function flatten(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.nodeValue ?? "")
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return
  const el = node as Element
  if (el.matches(CHROME_SELECTOR)) return
  if (el.tagName === "BR") {
    out.push("\n")
    return
  }
  for (const child of Array.from(el.childNodes)) flatten(child, out)
  if (PARAGRAPH_TAGS.has(el.tagName)) out.push("\n\n")
  else if (LIST_TAGS.has(el.tagName)) out.push("\n")
}

/**
 * Flatten a range to plain text, dropping UI chrome and turning block
 * boundaries into line breaks. `Range.toString()` does neither, so a quote of a
 * code block used to arrive as "Copy" plus the code, with the surrounding
 * paragraphs run together.
 */
export function selectionText(range: Range): string {
  const out: string[] = []
  for (const node of Array.from(range.cloneContents().childNodes)) flatten(node, out)
  return out
    .join("")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function SelectionToolbar() {
  const [selection, setSelection] = createSignal<SelectionState | null>(null)

  const hide = () => setSelection(null)

  const sync = () => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      hide()
      return
    }
    const range = sel.getRangeAt(0)
    const node = range.commonAncestorContainer
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
    if (!el?.closest(".dsm-msglist")) {
      hide()
      return
    }
    // Flatten only once we know the selection is in the transcript — this runs
    // on every selectionchange while dragging, so keep it off the hot path.
    const text = selectionText(range)
    if (!text) {
      hide()
      return
    }
    const rect = range.getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hide()
      return
    }
    const below = rect.top <= TOP_LIMIT
    setSelection({
      text,
      top: below ? rect.bottom + GAP : rect.top - GAP,
      left: Math.min(Math.max(rect.left + rect.width / 2, 70), window.innerWidth - 70),
      below,
    })
  }

  // A press anywhere other than the button dismisses it; pressing the button
  // itself is handled by the click handler below.
  const onMouseDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null
    if (target?.closest?.(".dsm-selection-toolbar")) return
    hide()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") hide()
  }

  onMount(() => {
    document.addEventListener("selectionchange", sync)
    document.addEventListener("mouseup", sync)
    document.addEventListener("mousedown", onMouseDown)
    document.addEventListener("keydown", onKeyDown)
    // Hide while the transcript scrolls so the button never floats detached.
    document.addEventListener("scroll", hide, true)
    window.addEventListener("resize", hide)
    onCleanup(() => {
      document.removeEventListener("selectionchange", sync)
      document.removeEventListener("mouseup", sync)
      document.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("keydown", onKeyDown)
      document.removeEventListener("scroll", hide, true)
      window.removeEventListener("resize", hide)
    })
  })

  const addToChat = () => {
    const current = selection()
    if (!current) return
    // No removeAllRanges() here: the composer focuses itself and places the
    // caret after the new pill, which already replaces the transcript
    // selection. Clearing afterwards would wipe that caret and send the next
    // keystroke to the start of the composer.
    window.dispatchEvent(new CustomEvent("dsm-insert-text", { detail: { text: current.text } }))
    hide()
  }

  return (
    <Portal>
      <Show when={selection()}>
        {(sel) => (
          <button
            type="button"
            class="dsm-selection-toolbar"
            style={{
              top: `${sel().top}px`,
              left: `${sel().left}px`,
              transform: sel().below ? "translate(-50%, 0)" : "translate(-50%, -100%)",
            }}
            // Keep the selection alive until the click fires.
            onMouseDown={(e) => e.preventDefault()}
            onClick={addToChat}
          >
            <ChatIcon size={12} />
            <span>Add to chat</span>
          </button>
        )}
      </Show>
    </Portal>
  )
}
