/**
 * SessionRail.tsx — the session/history list: create, switch, delete
 * (two-step arm/confirm), and rename (double-click). Shown as an overlay dock.
 */

import { createSignal, For, onCleanup, Show } from "solid-js"
import { useSession } from "../store/session"
import type { WireSession } from "../lib/types"
import { timeAgo } from "../lib/time"
import { ChatIcon, PlusIcon, TrashIcon, XIcon } from "./icons"

export function SessionRail() {
  const { state, selectSession, newChat, deleteSession, renameSession, setRailOpen } = useSession()
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editText, setEditText] = createSignal("")
  const [armedId, setArmedId] = createSignal<string | null>(null)
  let armTimer: number | undefined
  let clickTimer: number | undefined
  let cancelRename = false

  onCleanup(() => {
    if (armTimer !== undefined) window.clearTimeout(armTimer)
    if (clickTimer !== undefined) window.clearTimeout(clickTimer)
  })

  const armDelete = (id: string) => {
    if (armedId() === id) {
      if (armTimer !== undefined) {
        window.clearTimeout(armTimer)
        armTimer = undefined
      }
      setArmedId(null)
      deleteSession(id)
    } else {
      setArmedId(id)
      if (armTimer !== undefined) window.clearTimeout(armTimer)
      armTimer = window.setTimeout(() => {
        armTimer = undefined
        if (armedId() === id) setArmedId(null)
      }, 3000)
    }
  }

  const startRename = (session: WireSession) => {
    if (clickTimer !== undefined) {
      window.clearTimeout(clickTimer)
      clickTimer = undefined
    }
    cancelRename = false
    setArmedId(null)
    setEditingId(session.id)
    setEditText(session.title ?? "")
  }

  // Escape must cancel, not commit: setting editingId(null) unmounts the input
  // and fires onBlur, so guard the blur-triggered commit with a cancel flag.
  const commitRename = (id: string) => {
    if (cancelRename) {
      cancelRename = false
      setEditingId(null)
      return
    }
    if (editingId() !== id) return
    setEditingId(null)
    if (editText().trim()) renameSession(id, editText())
  }

  const cancelRenameEdit = () => {
    cancelRename = true
    setEditingId(null)
  }

  const pick = (id: string) => {
    selectSession(id)
    setRailOpen(false)
  }

  // Single click selects and closes the rail; double-click renames. Delay the
  // select so the second click of a double-click can cancel it and open the
  // rename input instead of the rail closing underneath the gesture.
  const onRowClick = (id: string) => {
    if (clickTimer !== undefined) window.clearTimeout(clickTimer)
    clickTimer = window.setTimeout(() => {
      clickTimer = undefined
      pick(id)
    }, 220)
  }

  return (
    <aside class="dsm-rail" aria-label="Chats">
      <div class="dsm-rail-head">
        <span class="dsm-rail-title">Chats</span>
        <div class="dsm-rail-actions">
          <button type="button" class="dsm-btn dsm-btn-icon" title="New chat" onClick={() => newChat()}>
            <PlusIcon size={14} />
          </button>
          <button
            type="button"
            class="dsm-btn dsm-btn-icon dsm-rail-close"
            title="Close chats"
            onClick={() => setRailOpen(false)}
          >
            <XIcon size={14} />
          </button>
        </div>
      </div>

      <Show
        when={state.sessions.length > 0}
        fallback={
          <div class="dsm-rail-empty">
            <ChatIcon size={20} />
            <span>No chats yet</span>
          </div>
        }
      >
        <ul class="dsm-rail-list">
          <For each={state.sessions}>
            {(session) => {
              const active = () => state.currentSessionID === session.id
              const busy = () => !!state.busy[session.id]
              return (
                <li
                  class="dsm-rail-item"
                  classList={{ "is-active": active(), "is-armed": armedId() === session.id }}
                >
                  <Show
                    when={editingId() === session.id}
                    fallback={
                      <button
                        type="button"
                        class="dsm-rail-open"
                        onClick={() => onRowClick(session.id)}
                        onDblClick={() => startRename(session)}
                        title="Switch chat · double-click to rename"
                      >
                        <span class="dsm-rail-item-title">{session.title || "New chat"}</span>
                        <span class="dsm-rail-item-time">{timeAgo(session.updatedAt)}</span>
                      </button>
                    }
                  >
                    <input
                      class="dsm-rail-rename"
                      value={editText()}
                      autofocus
                      onInput={(e) => setEditText(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(session.id)
                        else if (e.key === "Escape") cancelRenameEdit()
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => commitRename(session.id)}
                    />
                  </Show>
                  <Show when={editingId() !== session.id}>
                    <div class="dsm-rail-ops">
                      <Show when={busy()}>
                        <span class="dsm-spinner dsm-spinner-sm" aria-label="Working" />
                      </Show>
                      <button
                        type="button"
                        class="dsm-btn dsm-btn-icon dsm-rail-delete"
                        classList={{ "is-armed": armedId() === session.id }}
                        title={armedId() === session.id ? "Click again to delete" : "Delete chat"}
                        aria-label="Delete chat"
                        onClick={() => armDelete(session.id)}
                      >
                        <TrashIcon size={13} />
                      </button>
                    </div>
                  </Show>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
    </aside>
  )
}
