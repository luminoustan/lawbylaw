/**
 * MermaidLightbox.tsx — a fullscreen mermaid diagram viewer, portaled to <body>.
 *
 * Mirrors ImageLightbox.tsx: the trigger owns the open state, this component
 * only renders the overlay when `open` is true and reports dismissal back
 * through `onClose`. The diagram is interactive inside the overlay: the wheel
 * zooms around the pointer and dragging pans. Dismissal: clicking the backdrop
 * (anywhere outside the diagram), the close button, or Escape.
 *
 * The SVG is passed in as a markup string captured by the trigger
 * (`markdown-text.tsx`), so the viewer keeps working even if the transcript
 * re-renders or the source turn unmounts while the overlay is open.
 */

import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { XIcon } from "./icons"
import { createFocusTrap } from "../lib/focus-trap"

const MIN_ZOOM = 0.25
const MAX_ZOOM = 5
const WHEEL_STEP = 1.12
/** Breathing room between the fitted diagram and the viewport edge, in px. */
const VIEW_PADDING = 32
/** Pointer travel (px) past which a press counts as a drag, not a click. */
const DRAG_SLOP = 3

/**
 * The interactive overlay body. Mounted fresh for every open (the `Show` in
 * MermaidLightbox unmounts it on close), so the fit is measured against the
 * current viewport and the zoom/pan state never leaks between opens.
 */
function Viewer(props: { svg: string; onClose: () => void }) {
  let overlay: HTMLDivElement | undefined
  /** Scale at zoom 1 (fit-to-viewport); set once the overlay is laid out. */
  let fitScale = 1
  let natural = { w: 1, h: 1 }
  let drag: { x: number; y: number; moved: boolean } | null = null
  let suppressClick = false

  // `zoom` is a multiple of the fit size: 1 = fit. The canvas transform is
  // `translate(tx, ty) scale(fitScale * zoom)`.
  const [zoom, setZoom] = createSignal(1)
  const [tx, setTx] = createSignal(0)
  const [ty, setTy] = createSignal(0)
  const [panning, setPanning] = createSignal(false)

  const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

  // Viewer is mounted only while open, so the trap is always active here.
  createFocusTrap(() => overlay, () => true)

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") props.onClose()
  }

  const onWheel = (e: WheelEvent): void => {
    if (e.deltaY === 0 || !overlay) return
    e.preventDefault()
    const prev = zoom()
    const next = clampZoom(e.deltaY < 0 ? prev * WHEEL_STEP : prev / WHEEL_STEP)
    if (next === prev) return
    // Keep the point under the pointer anchored across the resize.
    const rect = overlay.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setTx(mx - (mx - tx()) * (next / prev))
    setTy(my - (my - ty()) * (next / prev))
    setZoom(next)
  }

  const onMouseMove = (e: MouseEvent): void => {
    if (!drag) return
    const dx = e.clientX - drag.x
    const dy = e.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > DRAG_SLOP) drag.moved = true
    setTx(tx() + dx)
    setTy(ty() + dy)
    drag.x = e.clientX
    drag.y = e.clientY
    e.preventDefault()
  }

  const onMouseUp = (): void => {
    window.removeEventListener("mousemove", onMouseMove)
    window.removeEventListener("mouseup", onMouseUp)
    if (drag) {
      // A drag that moved must not also read as a backdrop click.
      suppressClick = drag.moved
      drag = null
    }
    setPanning(false)
  }

  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return
    suppressClick = false
    drag = { x: e.clientX, y: e.clientY, moved: false }
    setPanning(true)
    // Pan listeners live only for the duration of a drag.
    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
    e.preventDefault()
  }

  const onClick = (e: MouseEvent): void => {
    if (suppressClick) {
      suppressClick = false
      return
    }
    // Clicks on the diagram itself never dismiss; the rest is the backdrop.
    if ((e.target as Element | null)?.closest?.(".dsm-mermaid-svg")) return
    props.onClose()
  }

  onMount(() => {
    const el = overlay
    if (!el) return
    const svg = el.querySelector<SVGSVGElement>(".dsm-mermaid-svg")
    const vb = svg?.viewBox.baseVal
    natural = { w: vb?.width || svg?.clientWidth || 1, h: vb?.height || svg?.clientHeight || 1 }
    // Fit the diagram to the viewport and centre it; zoom 1 means fit.
    const rect = el.getBoundingClientRect()
    fitScale = Math.min(
      (rect.width - VIEW_PADDING * 2) / natural.w,
      (rect.height - VIEW_PADDING * 2) / natural.h,
    )
    setTx((rect.width - natural.w * fitScale) / 2)
    setTy((rect.height - natural.h * fitScale) / 2)

    // The wheel listener must be non-passive to own the zoom gesture.
    el.addEventListener("wheel", onWheel, { passive: false })
    document.addEventListener("keydown", onKeyDown)
    onCleanup(() => {
      el.removeEventListener("wheel", onWheel)
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
    })
  })

  return (
    <div
      ref={overlay}
      tabindex="-1"
      class="dsm-mermaid-lightbox"
      classList={{ "is-panning": panning() }}
      role="dialog"
      aria-modal="true"
      aria-label="Diagram"
      onClick={onClick}
      onMouseDown={onMouseDown}
    >
      <div
        class="dsm-mermaid-lightbox-canvas"
        style={{ transform: `translate(${tx()}px, ${ty()}px) scale(${fitScale * zoom()})` }}
        innerHTML={props.svg}
      />
      <button type="button" class="dsm-mermaid-lightbox-close" title="Close" aria-label="Close" onClick={props.onClose}>
        <XIcon size={16} />
      </button>
    </div>
  )
}

export function MermaidLightbox(props: { open: boolean; svg: string; onClose: () => void }) {
  return (
    <Portal>
      <Show when={props.open}>
        <Viewer svg={props.svg} onClose={props.onClose} />
      </Show>
    </Portal>
  )
}
