/**
 * composer/use-clipboard.ts — paste handling for the composer.
 *
 * The composer is text-only: a paste inserts the clipboard's plain text and
 * nothing else, so an image on the clipboard is ignored instead of being
 * embedded by the contenteditable.
 */

import type { EditorCore } from "./editor-core"

export interface ClipboardDeps {
  core: EditorCore
}

export interface Clipboard {
  onPaste: (e: ClipboardEvent) => void
}

export function useClipboard(deps: ClipboardDeps): Clipboard {
  const { core } = deps

  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData?.getData("text/plain") ?? ""
    if (text) core.insertPlainText(text)
  }

  return { onPaste }
}
