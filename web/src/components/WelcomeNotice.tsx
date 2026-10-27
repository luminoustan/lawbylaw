/**
 * WelcomeNotice.tsx: the message shown in the middle of the screen the first time someone uses the app.
 *
 * Shown until it is dismissed once (see `lib/welcome.ts`). A modal, so the six points are read before
 * the first message: it is closed with the button or Escape, not by a stray click on the backdrop.
 */

import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createFocusTrap } from "../lib/focus-trap"
import { markWelcomeSeen, welcomeSeen, WELCOME_POINTS } from "../lib/welcome"

export function WelcomeNotice() {
  const [open, setOpen] = createSignal(!welcomeSeen())
  let box: HTMLDivElement | undefined

  createFocusTrap(() => box, open)

  const dismiss = () => {
    markWelcomeSeen()
    setOpen(false)
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open() && e.key === "Escape") dismiss()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })

  return (
    <Show when={open()}>
      <div class="dsm-welcome-scrim">
        <div
          ref={box}
          tabindex="-1"
          class="dsm-welcome"
          role="dialog"
          aria-modal="true"
          aria-labelledby="dsm-welcome-title"
          data-testid="welcome-notice"
        >
          <h2 id="dsm-welcome-title" class="dsm-welcome-title">Welcome</h2>
          <p class="dsm-welcome-lead">Before you start, please note:</p>
          <ol class="dsm-welcome-list">
            <For each={WELCOME_POINTS}>{(p) => <li>{p}</li>}</For>
          </ol>
          <div class="dsm-welcome-actions">
            <button type="button" class="dsm-btn dsm-btn-primary" data-autofocus onClick={dismiss}>
              I understand
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
