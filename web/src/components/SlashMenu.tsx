/**
 * SlashMenu.tsx — floating skills popup triggered by "/" in the composer.
 *
 * Lists the available skills (e.g. /compact), filtered as the user types. Full
 * keyboard navigation (Up/Down arrows, Enter, Tab, Escape) is handled by the
 * composer; this component renders the list, scrolls the highlighted row into
 * view and supports mouse selection.
 */

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { SlashItem } from "../lib/types"
import { ZapIcon } from "./icons"

/** Only one slash menu is open at a time, so a fixed id namespace is safe. */
const LIST_ID = "dsm-slash-list"

export interface SlashMenuProps {
  open: boolean
  items: SlashItem[]
  selectedIndex: number
  anchorRef: () => HTMLElement | undefined
  onSelect: (item: SlashItem) => void
  onClose: () => void
  onIndexChange: (index: number) => void
}

export function SlashMenu(props: SlashMenuProps) {
  let menuRef: HTMLDivElement | undefined
  const [pos, setPos] = createSignal<{ left: number; width: number; bottom: number; maxHeight: number }>({
    left: 0,
    width: 300,
    bottom: 0,
    maxHeight: 320,
  })

  const updatePosition = () => {
    const el = props.anchorRef()
    if (!el) return
    const rect = el.getBoundingClientRect()
    const spaceUp = rect.top - 12
    setPos({
      left: rect.left,
      width: rect.width,
      bottom: window.innerHeight - rect.top + 6,
      maxHeight: Math.min(340, Math.max(120, spaceUp)),
    })
  }

  createEffect(() => {
    if (props.open) updatePosition()
  })

  // Keep the selected item comfortably inside the list viewport. Scrolling the
  // list container directly (rather than scrollIntoView) keeps a margin above
  // and below the selection, so the highlight visibly travels as the arrow
  // keys cycle instead of sitting flush against the edge.
  const SCROLL_MARGIN = 8
  createEffect(() => {
    const idx = props.selectedIndex
    if (!menuRef || idx < 0) return
    const list = menuRef.querySelector<HTMLElement>(".dsm-slash-list")
    const target = menuRef.querySelectorAll<HTMLElement>(".dsm-slash-item")[idx]
    if (!list || !target) return

    const listRect = list.getBoundingClientRect()
    const itemRect = target.getBoundingClientRect()
    const itemTop = itemRect.top - listRect.top + list.scrollTop
    const itemBottom = itemTop + itemRect.height

    if (itemTop - SCROLL_MARGIN < list.scrollTop) {
      list.scrollTop = Math.max(0, itemTop - SCROLL_MARGIN)
    } else if (itemBottom + SCROLL_MARGIN > list.scrollTop + list.clientHeight) {
      list.scrollTop = itemBottom + SCROLL_MARGIN - list.clientHeight
    }
  })

  function onDocPointerDown(e: PointerEvent): void {
    if (!props.open) return
    const target = e.target as Node | null
    const anchor = props.anchorRef()
    if (menuRef && menuRef.contains(target)) return
    if (anchor && anchor.contains(target)) return
    props.onClose()
  }

  onMount(() => {
    document.addEventListener("pointerdown", onDocPointerDown)
    window.addEventListener("resize", updatePosition)
    document.addEventListener("scroll", updatePosition, true)
  })

  onCleanup(() => {
    document.removeEventListener("pointerdown", onDocPointerDown)
    window.removeEventListener("resize", updatePosition)
    document.removeEventListener("scroll", updatePosition, true)
  })

  return (
    <Show when={props.open}>
      <Portal>
        <div
          ref={menuRef}
          class="dsm-slash-menu"
          style={{
            position: "fixed",
            left: `${pos().left}px`,
            width: `${pos().width}px`,
            bottom: `${pos().bottom}px`,
            "max-height": `${pos().maxHeight}px`,
            "z-index": "100",
          }}
          role="dialog"
          aria-label="Skills"
        >
          <div class="dsm-slash-header">Skills</div>

          <div
            class="dsm-slash-list"
            role="listbox"
            aria-label="Skills"
            aria-activedescendant={props.items.length > 0 ? `${LIST_ID}-item-${props.selectedIndex}` : undefined}
          >
            <Show when={props.items.length > 0} fallback={<div class="dsm-slash-empty">No matching skills</div>}>
              <For each={props.items}>
                {(item, idx) => {
                  const isSelected = () => idx() === props.selectedIndex
                  return (
                    <div
                      id={`${LIST_ID}-item-${idx()}`}
                      class="dsm-slash-item"
                      classList={{ "is-selected": isSelected() }}
                      role="option"
                      aria-selected={isSelected()}
                      onPointerEnter={() => props.onIndexChange(idx())}
                      onClick={() => props.onSelect(item)}
                    >
                      <div class="dsm-slash-item-left">
                        <span class="dsm-slash-item-icon-wrap">
                          <ZapIcon size={13} class="dsm-slash-item-icon" />
                        </span>
                        <span class="dsm-slash-item-name">/{item.name}</span>
                        <span class="dsm-slash-item-desc">{item.description}</span>
                      </div>
                      <span class="dsm-slash-badge">Skill</span>
                    </div>
                  )
                }}
              </For>
            </Show>
          </div>

          <div class="dsm-slash-footer">
            <span><kbd>↑</kbd> <kbd>↓</kbd> to navigate</span>
            <span><kbd>Enter</kbd> or <kbd>Tab</kbd> to select</span>
            <span><kbd>Esc</kbd> to dismiss</span>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
