/**
 * composer-dom.ts — imperative DOM helpers for the composer's contenteditable.
 *
 * Pill construction/insertion, caret placement and plain-text insertion. The
 * state that must survive across calls (the remembered caret range) stays with
 * the caller and is passed in; signal updates are delivered through the
 * `onChange` callback.
 */

/** The current caret range when it is inside `editor`; null otherwise. */
export function caretRangeIn(editor: HTMLElement | undefined): Range | null {
  if (!editor) return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!editor.contains(range.commonAncestorContainer)) return null
  return range.cloneRange()
}

/**
 * Place the caret immediately after `node`. When `node` is a `<br>` the
 * browser would otherwise leave the caret at the element level, and the next
 * typed character lands in the *preceding* text node — i.e. before the line
 * break. Anchoring the caret inside a trailing text node keeps typing on the
 * new line.
 */
export function placeCaretAfter(node: Node, sel: Selection): void {
  const range = document.createRange()
  if (node.nodeName === "BR") {
    const parent = node.parentNode
    const next = node.nextSibling
    if (next && next.nodeType === Node.TEXT_NODE) {
      range.setStart(next, 0)
    } else if (parent) {
      const text = document.createTextNode("")
      parent.insertBefore(text, next)
      range.setStart(text, 0)
    } else {
      range.setStartAfter(node)
    }
  } else {
    range.setStartAfter(node)
  }
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

/** Insert plain text at the caret (or append), preserving line breaks. */
export function insertPlainText(editor: HTMLElement | undefined, text: string): void {
  if (!text || !editor) return
  editor.focus()
  const sel = window.getSelection()
  let inserted = false

  const createFragment = () => {
    const fragment = document.createDocumentFragment()
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        fragment.appendChild(document.createElement("br"))
      }
      if (lines[i]) {
        fragment.appendChild(document.createTextNode(lines[i]))
      }
    }
    return fragment
  }

  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0)
    if (editor.contains(range.commonAncestorContainer)) {
      range.deleteContents()
      const fragment = createFragment()
      const lastNode = fragment.lastChild || fragment
      range.insertNode(fragment)

      placeCaretAfter(lastNode, sel)
      inserted = true
    }
  }

  if (!inserted) {
    const fragment = createFragment()
    const lastNode = fragment.lastChild || fragment
    editor.appendChild(fragment)
    if (sel) {
      placeCaretAfter(lastNode, sel)
    }
  }
}

export interface ComposerPillData {
  label: string
  title: string
  fullContext: string
  marker?: string
}

/**
 * Build and insert a quote pill at the remembered caret (or the live
 * selection when it is already inside the editor), then notify `onChange`.
 */
export function insertPill(
  editor: HTMLElement,
  data: ComposerPillData,
  savedRange: Range | null,
  onChange: () => void,
): void {
  const pill = document.createElement("span")
  pill.contentEditable = "false"
  pill.className = "dsm-composer-pill dsm-quote-pill"
  pill.dataset.label = data.label
  pill.dataset.title = data.title
  pill.dataset.fullContext = data.fullContext
  if (data.marker) pill.dataset.marker = data.marker
  pill.title = data.title

  const iconSpan = document.createElement("span")
  iconSpan.className = "dsm-pill-icon"
  iconSpan.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v7a3 3 0 0 1-3 3"/><path d="M19 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v7a3 3 0 0 1-3 3"/></svg>`
  pill.appendChild(iconSpan)

  const labelSpan = document.createElement("span")
  labelSpan.className = "dsm-pill-label"
  labelSpan.textContent = data.label
  pill.appendChild(labelSpan)

  const xBtn = document.createElement("button")
  xBtn.type = "button"
  xBtn.className = "dsm-pill-x"
  xBtn.title = `Remove ${data.label}`
  xBtn.setAttribute("aria-label", `Remove ${data.label}`)
  xBtn.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
  xBtn.onmousedown = (e) => {
    e.preventDefault()
    e.stopPropagation()
  }
  xBtn.onclick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    pill.remove()
    onChange()
    editor.focus()
  }
  pill.appendChild(xBtn)

  // Resolve the insertion point BEFORE focusing. focus() can drop the caret at
  // the start of the editor, which would otherwise beat the position the user
  // was actually typing at. The live selection only counts when it is already
  // inside the composer; otherwise fall back to the remembered caret, so a
  // pill added while the transcript selection is active lands mid-sentence.
  const sel = window.getSelection()
  let target: Range | null = null
  if (sel && sel.rangeCount > 0) {
    const live = sel.getRangeAt(0)
    if (editor.contains(live.commonAncestorContainer)) target = live.cloneRange()
  }
  if (!target && savedRange && editor.contains(savedRange.commonAncestorContainer)) {
    target = savedRange.cloneRange()
  }

  editor.focus()
  let inserted = false

  if (target) {
    const range = target
    range.deleteContents()

    const preceding = range.startContainer.textContent?.slice(0, range.startOffset) || ""
    if (preceding && !/\s$/.test(preceding)) {
      const spaceBefore = document.createTextNode(" ")
      range.insertNode(spaceBefore)
      range.setStartAfter(spaceBefore)
      range.collapse(true)
    }

    range.insertNode(pill)

    const trailingSpace = document.createTextNode(" ")
    pill.after(trailingSpace)

    const newRange = document.createRange()
    newRange.setStartAfter(trailingSpace)
    newRange.setEndAfter(trailingSpace)
    sel?.removeAllRanges()
    sel?.addRange(newRange)
    inserted = true
  }

  if (!inserted) {
    if (editor.lastChild && editor.lastChild.textContent && !/\s$/.test(editor.lastChild.textContent)) {
      editor.appendChild(document.createTextNode(" "))
    }
    editor.appendChild(pill)
    const trailingSpace = document.createTextNode(" ")
    editor.appendChild(trailingSpace)

    const newRange = document.createRange()
    newRange.setStartAfter(trailingSpace)
    newRange.setEndAfter(trailingSpace)
    sel?.removeAllRanges()
    sel?.addRange(newRange)
  }

  onChange()
}
