/**
 * use-popover.ts — shared anchor/placement logic for popovers.
 *
 * The composer menus and the context ring need the same behaviour: anchor a
 * popover above or below its trigger, clamp it to the viewport, and close it
 * on outside pointerdown / Escape / scroll / resize. The two callers differ
 * only in alignment, size and focus handling, which are options here.
 */

import { createSignal, onCleanup, onMount, type Accessor } from "solid-js"

export interface PopPosition {
  /** Either top (open downward) or bottom (open upward) is set. */
  top?: number
  bottom?: number
  left: number
  maxHeight: number
}

export interface UsePopoverOptions {
  /** Clamp the pop's left edge to the trigger's left ("start") or right edge ("end"). */
  align?: "start" | "end"
  maxWidth?: number
  maxHeight?: number
  gap?: number
  /** Return focus to the trigger when the pop closes. */
  restoreFocus?: boolean
  /** Called on Escape before closing (e.g. preventDefault). */
  onEscape?: (e: KeyboardEvent) => void
}

export interface UsePopoverResult {
  open: Accessor<boolean>
  pos: Accessor<PopPosition | null>
  setTriggerRef: (el: HTMLButtonElement) => void
  setPopRef: (el: HTMLElement) => void
  toggle: () => void
  close: () => void
}

/**
 * The fixed-position style shared by every portaled popover: pin to the
 * computed position, setting BOTH top and bottom explicitly (a class-level
 * `bottom: calc(100% + 4px)` would otherwise stretch the box).
 */
export function popoverStyle(pos: PopPosition | null, fallbackMaxHeight: number): Record<string, string> {
  return {
    position: "fixed",
    "z-index": "1000",
    left: `${pos?.left ?? 0}px`,
    top: pos?.top !== undefined ? `${pos.top}px` : "auto",
    bottom: pos?.bottom !== undefined ? `${pos.bottom}px` : "auto",
    "max-height": `${pos?.maxHeight ?? fallbackMaxHeight}px`,
  }
}

const DEFAULT_GAP = 4
const DEFAULT_MAX_HEIGHT = 320
const DEFAULT_MAX_WIDTH = 280

export function usePopover(opts: UsePopoverOptions = {}): UsePopoverResult {
  const gap = opts.gap ?? DEFAULT_GAP
  const maxWidth = opts.maxWidth ?? DEFAULT_MAX_WIDTH
  const maxHeight = opts.maxHeight ?? DEFAULT_MAX_HEIGHT
  const align = opts.align ?? "start"

  const [open, setOpen] = createSignal(false)
  const [pos, setPos] = createSignal<PopPosition | null>(null)
  let triggerRef: HTMLButtonElement | undefined
  let popRef: HTMLElement | undefined

  const close = () => {
    if (!open()) return
    setOpen(false)
    if (opts.restoreFocus) triggerRef?.focus()
  }

  const place = () => {
    const btn = triggerRef
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    const spaceUp = rect.top - gap - 8
    const spaceDown = window.innerHeight - rect.bottom - gap - 8
    const left = align === "end"
      ? Math.max(8, Math.min(rect.right - maxWidth, window.innerWidth - maxWidth - 8))
      : Math.max(8, Math.min(rect.left, window.innerWidth - maxWidth - 8))
    if (spaceUp >= spaceDown) {
      // Open upward: anchor the pop's bottom edge a few px above the trigger.
      setPos({
        bottom: window.innerHeight - rect.top + gap,
        left,
        maxHeight: Math.min(maxHeight, Math.max(spaceUp, 0)),
      })
    } else {
      // Open downward: anchor the pop's top edge a few px below the trigger.
      setPos({
        top: rect.bottom + gap,
        left,
        maxHeight: Math.min(maxHeight, Math.max(spaceDown, 0)),
      })
    }
  }

  const reposition = () => {
    if (open()) place()
  }

  const toggle = () => {
    if (open()) {
      close()
      return
    }
    place()
    setOpen(true)
  }

  function onDocPointerDown(e: PointerEvent): void {
    const t = e.target as Node | null
    if (triggerRef && triggerRef.contains(t)) return
    if (popRef && popRef.contains(t)) return
    close()
  }

  function onDocKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape" || !open()) return
    opts.onEscape?.(e)
    close()
  }

  onMount(() => {
    document.addEventListener("pointerdown", onDocPointerDown)
    document.addEventListener("keydown", onDocKeyDown)
    document.addEventListener("scroll", reposition, true)
    window.addEventListener("resize", reposition)
  })

  onCleanup(() => {
    document.removeEventListener("pointerdown", onDocPointerDown)
    document.removeEventListener("keydown", onDocKeyDown)
    document.removeEventListener("scroll", reposition, true)
    window.removeEventListener("resize", reposition)
  })

  return {
    open,
    pos,
    setTriggerRef: (el) => { triggerRef = el },
    setPopRef: (el) => { popRef = el },
    toggle,
    close,
  }
}
