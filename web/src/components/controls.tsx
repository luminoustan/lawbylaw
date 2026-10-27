/**
 * controls.tsx — small flat controls: a lightweight dropdown selector and a
 * plain text button. In-house replacements for the upstream fork's ui controls.
 *
 * MenuSelect renders its open list through a Solid <Portal> into
 * document.body at `position: fixed`, positioned from the trigger's live
 * bounding rect. The mode/model triggers live inside `.dsm-docks` — a scroll /
 * overflow container that would clip an absolutely-positioned popup (the
 * original bug: mode/model lists rendered "behind" the chat). Portaling
 * escapes every overflow ancestor (docks, chat-scroll, rail) so an open list
 * always paints in FRONT of messages / composer / docks / overlays. It also
 * escapes the composer box itself (now a bordered column that wraps the
 * selectors), so an in-box trigger's popup is never clipped. The same fix
 * therefore also covers dropdowns opened from the Settings overlay.
 */

import { createEffect, createSignal, For, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { ChevronDownIcon } from "./icons"
import { usePopover, popoverStyle } from "../lib/use-popover"

export interface MenuOption {
  value: string
  label: string
  detail?: string
  disabled?: boolean
}

const POP_MAX_HEIGHT = 320
const POP_MAX_WIDTH = 280

let menuInstance = 0

export function MenuSelect(props: {
  /** Current value shown in the trigger. */
  value: () => string
  /** Map a value to its display label (fallback to value). */
  labelFor?: (value: string) => string
  options: () => MenuOption[]
  onSelect: (value: string) => void
  disabled?: boolean
  title?: string
  /** Optional per-option icon renderer (e.g. mode menu draws an SVG per agent). */
  iconFor?: (opt: MenuOption) => JSX.Element
}) {
  const pop = usePopover({ align: "start", maxWidth: POP_MAX_WIDTH })
  const popId = `dsm-menu-pop-${++menuInstance}`
  const optionId = (i: number) => `${popId}-opt-${i}`
  const [activeIndex, setActiveIndex] = createSignal(-1)
  let listRef: HTMLUListElement | undefined

  createEffect(() => {
    if (props.disabled) pop.close()
  })

  const openMenu = () => {
    const opts = props.options()
    const current = opts.findIndex((o) => o.value === props.value())
    setActiveIndex(current >= 0 ? current : opts.findIndex((o) => !o.disabled))
    pop.toggle()
  }

  const moveActive = (delta: number) => {
    const opts = props.options()
    if (opts.length === 0) return
    let i = activeIndex()
    for (let step = 0; step < opts.length; step++) {
      i = (i + delta + opts.length) % opts.length
      if (!opts[i].disabled) {
        setActiveIndex(i)
        return
      }
    }
  }

  const onTriggerKeyDown = (e: KeyboardEvent) => {
    const opts = props.options()
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (!pop.open()) openMenu()
      else moveActive(e.key === "ArrowDown" ? 1 : -1)
      return
    }
    if (e.key === "Home" || e.key === "End") {
      if (!pop.open()) return
      e.preventDefault()
      if (e.key === "Home") {
        const i = opts.findIndex((o) => !o.disabled)
        if (i >= 0) setActiveIndex(i)
      } else {
        for (let i = opts.length - 1; i >= 0; i--) {
          if (!opts[i].disabled) {
            setActiveIndex(i)
            break
          }
        }
      }
      return
    }
    if ((e.key === "Enter" || e.key === " ") && pop.open()) {
      e.preventDefault()
      const opt = opts[activeIndex()]
      if (opt && !opt.disabled) {
        props.onSelect(opt.value)
        pop.close()
      }
    }
  }

  // Keep the active option in view as the highlight moves.
  createEffect(() => {
    const i = activeIndex()
    if (!pop.open() || i < 0) return
    listRef?.querySelectorAll<HTMLElement>(".dsm-menu-opt")[i]?.scrollIntoView({ block: "nearest" })
  })

  const triggerLabel = () => {
    const v = props.value()
    if (props.labelFor) return props.labelFor(v)
    const opt = props.options().find((o) => o.value === v)
    return opt ? opt.label : v
  }

  return (
    <>
      <div class="dsm-menu">
        <button
          ref={pop.setTriggerRef}
          type="button"
          class="dsm-menu-trigger"
          classList={{ "is-open": pop.open() }}
          disabled={props.disabled}
          title={props.title}
          onClick={() => (pop.open() ? pop.close() : openMenu())}
          onKeyDown={onTriggerKeyDown}
          aria-haspopup="listbox"
          aria-expanded={pop.open()}
          aria-controls={popId}
        >
          <Show when={props.iconFor} fallback={<span class="dsm-menu-trigger-label">{triggerLabel()}</span>}>
            <span class="dsm-menu-trigger-row">
              <span class="dsm-menu-trigger-icon">{props.iconFor!(props.options().find((o) => o.value === props.value()) ?? { value: props.value(), label: triggerLabel() })}</span>
              <span class="dsm-menu-trigger-label">{triggerLabel()}</span>
            </span>
          </Show>
          <ChevronDownIcon size={12} class="dsm-menu-chevron" />
        </button>
      </div>
      <Portal>
        <Show when={pop.open()}>
          <ul
            ref={(el) => {
              listRef = el
              pop.setPopRef(el)
            }}
            id={popId}
            class="dsm-menu-pop"
            role="listbox"
            aria-activedescendant={pop.open() && activeIndex() >= 0 ? optionId(activeIndex()) : undefined}
            style={popoverStyle(pop.pos(), POP_MAX_HEIGHT)}
          >
            <For each={props.options()}>
              {(opt, i) => (
                <li>
                  <button
                    type="button"
                    id={optionId(i())}
                    role="option"
                    class="dsm-menu-opt"
                    aria-selected={opt.value === props.value()}
                    classList={{ "is-selected": opt.value === props.value(), "is-active": activeIndex() === i() }}
                    disabled={opt.disabled}
                    onPointerEnter={() => setActiveIndex(i())}
                    onClick={() => {
                      props.onSelect(opt.value)
                      pop.close()
                    }}
                  >
                    <Show when={props.iconFor} fallback={<span class="dsm-menu-opt-label">{opt.label}</span>}>
                      <span class="dsm-menu-opt-row">
                        <span class="dsm-menu-opt-icon">{props.iconFor!(opt)}</span>
                        <span class="dsm-menu-opt-label">{opt.label}</span>
                      </span>
                    </Show>
                    {opt.detail ? <span class="dsm-menu-opt-detail">{opt.detail}</span> : null}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Portal>
    </>
  )
}
