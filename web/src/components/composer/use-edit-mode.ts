/**
 * composer/use-edit-mode.ts — edit-in-composer mode for the prompt box.
 *
 * Clicking a user bubble marks it as the edit target; the composer loads its
 * text and resends through `editMessage()` instead of `sendPrompt()`. Owns the
 * load-once-per-session effect and the cancel path.
 */

import { createEffect, untrack, type Accessor } from "solid-js"
import type { EditorCore } from "./editor-core"

export interface EditModeDeps {
  core: EditorCore
  /** The message currently being edited, if any. */
  editingMessageID: Accessor<string | null>
  /** All messages in the current session (to resolve the edit target text). */
  currentMessages: Accessor<Array<{ id: string; parts: Array<{ type: string; text?: string }> }>>
  /** Clear the edit target in the store. */
  cancelEditMessage: () => void
}

export interface EditMode {
  editingTarget: Accessor<string | null>
  cancelEdit: () => void
}

export function useEditMode(deps: EditModeDeps): EditMode {
  const { core } = deps

  const editingTarget = () => deps.editingMessageID()

  const editingText = () => {
    const id = editingTarget()
    if (!id) return ""
    const msg = deps.currentMessages().find((m) => m.id === id)
    const part = msg?.parts.find((p) => p.type === "text")
    return part && "text" in part && typeof part.text === "string" ? part.text : ""
  }

  const cancelEdit = () => {
    core.clearEditor()
    deps.cancelEditMessage()
  }

  // Load the target text once per edit session (untracked so streamed deltas
  // don't rewrite the draft), and clear the box when edit mode ends.
  let lastEditTarget: string | null = null
  createEffect(() => {
    const id = editingTarget()
    if (id === lastEditTarget) return
    lastEditTarget = id
    if (id) {
      core.setEditorText(untrack(editingText))
    } else if (core.editorRef()) {
      core.clearEditor()
    }
  })

  return { editingTarget, cancelEdit }
}
