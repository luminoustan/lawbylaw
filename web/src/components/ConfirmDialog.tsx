/**
 * ConfirmDialog.tsx — a small confirmation modal, portaled to <body>.
 *
 * Used to warn before an action that leaves the app or writes a file:
 * downloading a transcript, or opening an external link from the chat.
 * The trigger owns the open state; this component only renders when `open`
 * and reports the choice back through `onConfirm` / `onCancel`.
 *
 * Dismissal: the Cancel button, clicking the backdrop, or Escape.
 */

import { createEffect, onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { createFocusTrap } from "../lib/focus-trap"
import { AlertTriangleIcon } from "./icons"

export interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  /** Optional emphasised detail, e.g. the URL being opened. */
  detail?: string
  /** Optional warning shown with an alert icon below the detail, e.g. a bright-light notice. */
  notice?: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  let boxRef: HTMLDivElement | undefined

  createFocusTrap(() => boxRef, () => props.open)

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") props.onCancel()
  }

  createEffect(() => {
    if (!props.open) return
    document.addEventListener("keydown", onKeyDown)
    onCleanup(() => document.removeEventListener("keydown", onKeyDown))
  })

  return (
    <Portal>
      <Show when={props.open}>
        <div
          class="dsm-confirm-scrim"
          onClick={(e) => {
            if (e.target === e.currentTarget) props.onCancel()
          }}
        >
          <div
            ref={boxRef}
            tabindex="-1"
            class="dsm-confirm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="dsm-confirm-title"
            aria-describedby="dsm-confirm-message"
          >
            <h2 id="dsm-confirm-title" class="dsm-confirm-title">{props.title}</h2>
            <p id="dsm-confirm-message" class="dsm-confirm-message">{props.message}</p>
            <Show when={props.detail}>
              <p class="dsm-confirm-detail">{props.detail}</p>
            </Show>
            <Show when={props.notice}>
              <p class="dsm-confirm-notice" role="note">
                <AlertTriangleIcon size={14} />
                <span>{props.notice}</span>
              </p>
            </Show>
            <div class="dsm-confirm-actions">
              <button type="button" class="dsm-btn dsm-confirm-cancel" onClick={props.onCancel}>
                {props.cancelLabel ?? "Cancel"}
              </button>
              <button type="button" class="dsm-btn dsm-btn-primary dsm-confirm-confirm" onClick={props.onConfirm}>
                {props.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </Portal>
  )
}
