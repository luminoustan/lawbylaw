/**
 * composer/editor-core.ts — the shared contenteditable spine for the composer.
 *
 * Owns the editor element ref, the saved caret range, the derived draft
 * signals (raw text / pill count / emptiness) and the pill/plain-text insert
 * helpers. The composer's feature hooks (edit mode, clipboard) all
 * build on this one object so they share a single source of truth for the
 * editor DOM and its caret.
 */

import { createSignal, type Accessor, type Setter } from "solid-js"
import { caretRangeIn, insertPill as insertPillDom, insertPlainText as insertPlainTextDom } from "../../lib/composer-dom"

/** Text density for the draft-token estimate, matching the agent engine's
 *  CHARS_PER_TOKEN so the context ring's draft count uses the same math. */
export const CHARS_PER_TOKEN = 4

export interface EditorCoreDeps {
  /** Current session id, read when syncing the draft-token estimate. */
  currentSessionID: Accessor<string | null>
  /** Report the draft token estimate for a session. */
  setDraftTokens: (sessionID: string, tokens: number) => void
}

export interface EditorCore {
  editorRef: () => HTMLDivElement | undefined
  setEditorRef: (el: HTMLDivElement) => void
  rawText: Accessor<string>
  pillCount: Accessor<number>
  isEmpty: Accessor<boolean>
  /** True after the `/` menu was dismissed or used, until the next edit re-arms it. */
  slashDismissed: Accessor<boolean>
  setSlashDismissed: Setter<boolean>
  rememberCaret: () => void
  syncEditorState: () => void
  setEditorText: (text: string) => void
  insertPill: (data: { label: string; title: string; fullContext: string; marker?: string }) => void
  insertPlainText: (text: string) => void
  /** Clear the editor DOM and resync derived state. */
  clearEditor: () => void
}

export function createEditorCore(deps: EditorCoreDeps): EditorCore {
  const [rawText, setRawText] = createSignal("")
  const [pillCount, setPillCount] = createSignal(0)
  const [isEmpty, setIsEmpty] = createSignal(true)
  const [slashDismissed, setSlashDismissed] = createSignal(false)

  let editorRef: HTMLDivElement | undefined
  /**
   * Last caret position inside the composer. Selecting text in the transcript
   * moves the document selection away from the composer, so by the time a pill
   * is inserted the live selection no longer says where the user was typing.
   */
  let savedRange: Range | null = null

  const rememberCaret = () => {
    const range = caretRangeIn(editorRef)
    if (range) savedRange = range
  }

  const syncEditorState = () => {
    const el = editorRef
    if (!el) return
    const textContent = el.textContent || ""
    const count = el.querySelectorAll(".dsm-composer-pill").length
    setRawText(textContent)
    setPillCount(count)
    setIsEmpty(textContent.trim().length === 0 && count === 0)
    const sid = deps.currentSessionID()
    if (sid) {
      deps.setDraftTokens(sid, textContent.trim().length > 0 ? Math.ceil(textContent.length / CHARS_PER_TOKEN) : 0)
    }
  }

  const setEditorText = (text: string) => {
    const editor = editorRef
    if (!editor) return
    editor.innerHTML = ""
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      if (i > 0) editor.appendChild(document.createElement("br"))
      if (line) editor.appendChild(document.createTextNode(line))
    })
    editor.focus()
    const sel = window.getSelection()
    if (sel) {
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    syncEditorState()
  }

  const insertPill: EditorCore["insertPill"] = (data) => {
    if (!editorRef) return
    insertPillDom(editorRef, data, savedRange, syncEditorState)
    rememberCaret()
  }

  const insertPlainText = (text: string) => {
    insertPlainTextDom(editorRef, text)
    syncEditorState()
    setSlashDismissed(false)
  }

  const clearEditor = () => {
    if (editorRef) editorRef.innerHTML = ""
    syncEditorState()
  }

  return {
    editorRef: () => editorRef,
    setEditorRef: (el) => { editorRef = el },
    rawText,
    pillCount,
    isEmpty,
    slashDismissed,
    setSlashDismissed,
    rememberCaret,
    syncEditorState,
    setEditorText,
    insertPill,
    insertPlainText,
    clearEditor,
  }
}
