/**
 * focus-trap.ts — modal focus containment for the portaled overlays.
 *
 * `aria-modal="true"` promises that the rest of the page is inert, so every
 * modal must move focus inside on open, keep Tab/Shift+Tab cycling within it,
 * and return focus to the element that opened it on close. This is the one
 * place that behaviour lives; SettingsView and the two lightboxes all use it.
 *
 * The initial target is the first `[data-autofocus]` element inside the
 * container (so a dialog can prefer its primary action), otherwise the first
 * focusable element, otherwise the container itself (which must be focusable).
 */

import { createEffect, onCleanup } from "solid-js"

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0,
  )
}

/**
 * Trap focus while `active()` is true. `container` must return the element that
 * wraps the modal's content once it is mounted.
 */
export function createFocusTrap(
  container: () => HTMLElement | undefined,
  active: () => boolean,
): void {
  createEffect(() => {
    if (!active()) return
    const el = container()
    if (!el) return

    const restore =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    // Focus after layout so the target is measurable/visible.
    const raf = requestAnimationFrame(() => {
      const preferred = el.querySelector<HTMLElement>("[data-autofocus]")
      const items = focusableWithin(el)
      ;(preferred ?? items[0] ?? el).focus()
    })

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return
      const items = focusableWithin(el)
      if (items.length === 0) {
        e.preventDefault()
        el.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement as HTMLElement | null
      const inside = current !== null && el.contains(current)
      if (e.shiftKey) {
        if (!inside || current === first) {
          e.preventDefault()
          last.focus()
        }
      } else if (!inside || current === last) {
        e.preventDefault()
        first.focus()
      }
    }

    el.addEventListener("keydown", onKeyDown)
    onCleanup(() => {
      cancelAnimationFrame(raf)
      el.removeEventListener("keydown", onKeyDown)
      if (restore && restore.isConnected) restore.focus()
    })
  })
}
