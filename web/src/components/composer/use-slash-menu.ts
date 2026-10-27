/**
 * composer/use-slash-menu.ts — the `/` skills popup for the composer.
 *
 * Owns the query derived from the draft text, the filtered skill list, the
 * highlighted index, and the selection that writes `/<name> ` back into the
 * editor.
 */

import { createEffect, createMemo, createSignal, type Accessor, type Setter } from "solid-js"
import type { SlashItem } from "../../lib/types"
import type { EditorCore } from "./editor-core"

export interface SlashMenuDeps {
  core: EditorCore
  /** The skills on offer. */
  skills: Accessor<SlashItem[]>
}

export interface SlashMenu {
  isSlashOpen: Accessor<boolean>
  items: Accessor<SlashItem[]>
  slashIndex: Accessor<number>
  setSlashIndex: Setter<number>
  selectSlashItem: (item: SlashItem) => void
  dismiss: () => void
}

export function useSlashMenu(deps: SlashMenuDeps): SlashMenu {
  const { core } = deps
  const [slashIndex, setSlashIndex] = createSignal(0)

  // The menu is open while the draft is a single "/word" with no argument yet.
  const slashQuery = () => {
    const t = core.rawText()
    if (!t.startsWith("/") || core.slashDismissed()) return null
    if (t.includes(" ") || t.includes("\n")) return null
    return t.slice(1).toLowerCase().trim()
  }

  const isSlashOpen = () => slashQuery() !== null

  const items = createMemo(() => {
    const q = slashQuery()
    if (q === null) return []
    const list = deps.skills()
    if (!q) return list
    return list
      .filter((i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q)
        const bStarts = b.name.toLowerCase().startsWith(q)
        if (aStarts && !bStarts) return -1
        if (!aStarts && bStarts) return 1
        return a.name.localeCompare(b.name)
      })
  })

  // Keep the highlight valid when the filtered list shrinks.
  createEffect(() => {
    if (slashIndex() >= items().length) setSlashIndex(0)
  })

  const selectSlashItem = (item: SlashItem) => {
    const editor = core.editorRef()
    if (!editor) return
    editor.innerHTML = ""
    const textNode = document.createTextNode(`/${item.name} `)
    editor.appendChild(textNode)
    core.setSlashDismissed(true)
    editor.focus()
    const sel = window.getSelection()
    if (sel) {
      const range = document.createRange()
      range.setStartAfter(textNode)
      range.setEndAfter(textNode)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    core.syncEditorState()
  }

  return {
    isSlashOpen,
    items,
    slashIndex,
    setSlashIndex,
    selectSlashItem,
    dismiss: () => core.setSlashDismissed(true),
  }
}
