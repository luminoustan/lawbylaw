/**
 * Composer.tsx — the prompt input box: rich contenteditable composer on top
 * and a footer row INSIDE the bordered box.
 *
 * Quoted text from the transcript is inserted as a pill directly inside the
 * chatbox. Typing "/" opens the skills menu (see `composer/use-slash-menu`).
 * The footer carries the key badge on the left and, on the right, the action
 * cluster: the context ring (toggle → breakdown popover) and the send/stop
 * button. Enter sends, Shift+Enter inserts a newline. The composer is
 * text-only: pasted or dropped images are ignored.
 *
 * The editor spine lives in `composer/editor-core`, the feature hooks in
 * `composer/use-{edit-mode,clipboard,slash-menu}`, and the footer in
 * `composer/ComposerFooter`.
 */

import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useSession } from "../../store/session"
import { SKILLS } from "../../lib/skills"
import { XIcon } from "../icons"
import { SlashMenu } from "../SlashMenu"
import { serializeComposerContent } from "../../lib/composer-content"
import { createEditorCore } from "./editor-core"
import { useEditMode } from "./use-edit-mode"
import { useClipboard } from "./use-clipboard"
import { useSlashMenu } from "./use-slash-menu"
import { ComposerFooter } from "./ComposerFooter"
import { StarterQuestions } from "./StarterQuestions"

export function Composer() {
  const { sendPrompt, stopTurn, isCurrentBusy, state, editMessage, editingMessageID, cancelEditMessage, currentMessages, setDraftTokens } =
    useSession()

  const core = createEditorCore({
    currentSessionID: () => state.currentSessionID,
    setDraftTokens,
  })

  const busy = isCurrentBusy
  const disabled = () => !state.ready || (!busy() && !state.currentSessionID && state.sessions.length === 0)

  const edit = useEditMode({
    core,
    editingMessageID,
    currentMessages,
    cancelEditMessage,
  })
  const editingTarget = edit.editingTarget

  const clipboard = useClipboard({ core })
  const slash = useSlashMenu({ core, skills: () => SKILLS })

  let boxRef: HTMLDivElement | undefined

  // ── Input size cap (mirrors the server's per-message limit) ──────────────
  const [charCount, setCharCount] = createSignal(0)
  const [capNotice, setCapNotice] = createSignal("")
  const charMax = () => {
    const limits = (state.config as { limits?: { message_chars?: number } }).limits
    return limits?.message_chars ?? 200_000
  }
  const enforceCap = () => {
    const el = core.editorRef()
    if (!el) return
    let text = el.innerText ?? ""
    if (text.length > charMax()) {
      text = text.slice(0, charMax())
      el.innerText = text
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      setCapNotice(`Message cut to the ${charMax()}-character limit`)
    } else if (text.length < charMax()) {
      setCapNotice("")
    }
    setCharCount(text.length)
  }
  // The composer is text-only: dropping an image or file on it must not insert it
  // (a contenteditable would embed the image) or navigate the page to it.
  const blockFileDrop = (e: DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault()
  }
  const guardedPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain") ?? ""
    const el = core.editorRef()
    const room = charMax() - (el?.innerText.length ?? 0)
    if (text.length > Math.max(room, 0)) {
      // Never hand a huge blob to contenteditable (it can freeze the page).
      e.preventDefault()
      if (room > 0) document.execCommand("insertText", false, text.slice(0, room))
      setCapNotice(`Pasted text cut to the ${charMax()}-character limit`)
      enforceCap()
      return
    }
    clipboard.onPaste(e)
  }

  const canSend = () => !core.isEmpty()

  // Suggested questions: only on a fresh conversation with an empty box.
  const showStarters = () =>
    state.ready && !disabled() && !busy() && !editingTarget() && core.isEmpty() && currentMessages().length === 0

  const submit = () => {
    const editor = core.editorRef()
    if (!editor) return
    const { fullPrompt, displayText, hasPills } = serializeComposerContent(editor)
    if (!fullPrompt && !hasPills) return
    if (busy()) return

    const target = editingTarget()
    editor.innerHTML = ""
    setCharCount(0)
    setCapNotice("")
    core.setSlashDismissed(false)
    core.syncEditorState()

    if (target) {
      // Editing an existing user message: fork the turn from there.
      editMessage(target, fullPrompt, displayText)
    } else {
      sendPrompt(fullPrompt, displayText)
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (slash.isSlashOpen()) {
      const items = slash.items()
      if (items.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault()
          slash.setSlashIndex((slash.slashIndex() + 1) % items.length)
          return
        }
        if (e.key === "ArrowUp") {
          e.preventDefault()
          slash.setSlashIndex((slash.slashIndex() - 1 + items.length) % items.length)
          return
        }
        if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.isComposing) {
          const item = items[slash.slashIndex()]
          // Enter on a draft that already is the full skill name runs it; otherwise Enter/Tab complete it.
          if (e.key === "Enter" && item && core.rawText().trim().toLowerCase() === `/${item.name}`) {
            slash.dismiss()
            e.preventDefault()
            if (canSend() && !busy()) submit()
            return
          }
          e.preventDefault()
          if (item) {
            slash.selectSlashItem(item)
            return
          }
        }
      }
      if (e.key === "Escape") {
        e.preventDefault()
        slash.dismiss()
        return
      }
    }

    if (e.key === "Escape" && editingTarget()) {
      e.preventDefault()
      edit.cancelEdit()
      return
    }

    if (e.key === "Enter") {
      if (e.shiftKey) {
        e.preventDefault()
        // Prefer the native line-break command: it places the caret correctly
        // on the new line, whereas a hand-inserted <br> leaves the caret at the
        // element level and the next keystroke merges into the previous line.
        if (!document.execCommand("insertLineBreak")) core.insertPlainText("\n")
        core.syncEditorState()
        core.setSlashDismissed(false)
        return
      }
      if (!e.isComposing) {
        e.preventDefault()
        if (canSend() && !busy()) submit()
        return
      }
    }

    if (e.key === "Backspace") {
      const sel = window.getSelection()
      if (sel && sel.isCollapsed && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0)
        let prevNode: Node | null = null
        if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
          prevNode = range.startContainer.previousSibling
        } else if (range.startContainer === core.editorRef() && range.startOffset > 0) {
          prevNode = core.editorRef()?.childNodes[range.startOffset - 1] ?? null
        }
        if (
          prevNode &&
          prevNode.nodeType === Node.ELEMENT_NODE &&
          (prevNode as HTMLElement).classList.contains("dsm-composer-pill")
        ) {
          e.preventDefault()
          prevNode.parentNode?.removeChild(prevNode)
          core.syncEditorState()
          return
        }
      }
    }
  }

  onMount(() => {
    const onInsertText = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const raw = typeof detail === "string" ? detail : detail?.text
      const text = typeof raw === "string" ? raw.trim() : ""
      if (!text) return
      const firstLine = text.split(/\r?\n/)[0] ?? ""
      const snippet = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
      // The chip stays short, but the marker sent with the prompt is long enough
      // to identify a big paste. The blockquote above it carries the full text,
      // so this is a breadcrumb rather than the payload.
      const oneLine = text.replace(/\s+/g, " ").trim()
      const marker = oneLine.length > 1000 ? `${oneLine.slice(0, 1000)}…` : oneLine
      core.insertPill({
        label: snippet || "Quoted text",
        title: text.length > 400 ? `${text.slice(0, 400)}…` : text,
        fullContext: text,
        marker: marker || snippet || "Quoted text",
      })
    }

    // Escape cancels edit mode from anywhere on the page, not just while the
    // composer input holds focus — mirroring the banner's X button. When the
    // input itself is focused it handles Escape (slash menu / cancel) on its own.
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !editingTarget()) return
      const target = e.target as HTMLElement | null
      if (target?.closest?.(".dsm-composer-input")) return
      e.preventDefault()
      edit.cancelEdit()
    }

    window.addEventListener("dsm-insert-text", onInsertText)
    window.addEventListener("keydown", onWindowKeyDown)
    // Track the composer caret continuously; selecting in the transcript fires
    // this too, but the containment check keeps those updates out.
    document.addEventListener("selectionchange", core.rememberCaret)
    onCleanup(() => {
      window.removeEventListener("dsm-insert-text", onInsertText)
      window.removeEventListener("keydown", onWindowKeyDown)
      document.removeEventListener("selectionchange", core.rememberCaret)
    })
  })

  return (
    <>
    <div class="dsm-composer">
      <Show when={showStarters()}>
        <StarterQuestions onPick={(q) => sendPrompt(q, q)} />
      </Show>
      <SlashMenu
        open={slash.isSlashOpen()}
        items={slash.items()}
        selectedIndex={slash.slashIndex()}
        anchorRef={() => boxRef}
        onSelect={slash.selectSlashItem}
        onClose={slash.dismiss}
        onIndexChange={(idx) => slash.setSlashIndex(idx)}
      />
      <div
        ref={boxRef}
        class="dsm-composer-box"
        classList={{ "is-editing": !!editingTarget() }}
        onClick={(e) => {
          if (e.target === boxRef || (e.target as HTMLElement).classList.contains("dsm-composer-box")) {
            core.editorRef()?.focus()
          }
        }}
      >
        <Show when={editingTarget()}>
          <div class="dsm-composer-editing" role="status">
            <span class="dsm-composer-editing-dot" aria-hidden="true" />
            <span class="dsm-composer-editing-label">Editing message</span>
            <button
              type="button"
              class="dsm-composer-editing-cancel"
              title="Cancel edit (Esc)"
              aria-label="Cancel edit"
              onClick={edit.cancelEdit}
            >
              <XIcon size={11} />
            </button>
          </div>
        </Show>
        <div class="dsm-composer-editor">
          <Show when={core.isEmpty()}>
            <div class="dsm-composer-placeholder" aria-hidden="true">
              {editingTarget()
                ? "Edit your message…"
                : "You are interacting with AI"}
            </div>
          </Show>
          <div
            ref={core.setEditorRef}
            class="dsm-composer-input"
            contenteditable={!disabled()}
            role="textbox"
            aria-multiline="true"
            aria-label="Ask a legal question"
            tabindex={0}
            onInput={() => {
              enforceCap()
              core.syncEditorState()
              core.setSlashDismissed(false)
              core.rememberCaret()
            }}
            onKeyUp={core.rememberCaret}
            onMouseUp={core.rememberCaret}
            onKeyDown={onKeyDown}
            onPaste={guardedPaste}
            onDragOver={blockFileDrop}
            onDrop={blockFileDrop}
          />
        </div>
        <ComposerFooter
          ready={() => state.ready}
          busy={busy}
          editingTarget={editingTarget}
          canSend={canSend}
          submit={submit}
          stopTurn={stopTurn}
          charCount={charCount}
          charMax={charMax}
          capNotice={capNotice}
        />
      </div>
    </div>
    </>
  )
}
