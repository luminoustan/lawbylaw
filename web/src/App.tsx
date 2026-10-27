/**
 * App.tsx — application shell: top bar (brand, chats dock toggle, new chat,
 * settings), the session rail overlay, the single chat view, and the
 * Settings overlay (also opened by the host's settingsButtonClicked action).
 */

import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useSession } from "./store/session"
import { SessionRail } from "./components/SessionRail"
import { ChatView } from "./components/ChatView"
import { SettingsView } from "./components/SettingsView"
import { ConfirmDialog } from "./components/ConfirmDialog"
import { WelcomeNotice } from "./components/WelcomeNotice"
import { ChatIcon, DownloadIcon, GearIcon, PlusIcon, SpinnerIcon, XIcon } from "./components/icons"

export function App() {
  const { state, newChat, selectSession, closeSession, openSessions, setRailOpen, setSettingsOpen, exportTranscript } = useSession()

  const [confirmDownload, setConfirmDownload] = createSignal(false)
  const [online, setOnline] = createSignal(typeof navigator === "undefined" ? true : navigator.onLine)
  onMount(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener("online", up)
    window.addEventListener("offline", down)
    onCleanup(() => {
      window.removeEventListener("online", up)
      window.removeEventListener("offline", down)
    })
  })

  // Convert mousewheel motion over the session strip into horizontal scrolling
  // of the chips, so a plain wheel or trackpad swipe can page through open chats.
  let stripRef: HTMLElement | undefined
  onMount(() => {
    const strip = stripRef
    if (!strip) return
    const onWheel = (e: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth) return
      // Use the dominant scroll axis so both a vertical mouse wheel and a
      // horizontal trackpad swipe page through the chips. Without this, the
      // preventDefault below swallows native horizontal scrolling.
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      strip.scrollLeft += delta
      e.preventDefault()
    }
    strip.addEventListener("wheel", onWheel, { passive: false })
    onCleanup(() => strip.removeEventListener("wheel", onWheel))
  })

  return (
    <div class="dsm-app" classList={{ "dsm-rail-visible": state.railOpen }}>
      <header class="dsm-topbar">
        {/* Session chips — open chats as little rectangles; click to open, x to close tab. */}
        <nav ref={stripRef} class="dsm-session-strip" aria-label="Chat sessions">
          <For each={openSessions()}>
            {(sess) => {
              const active = () => state.currentSessionID === sess.id
              const busy = () => !!state.busy[sess.id]
              return (
                <div
                  class="dsm-session-chip"
                  classList={{ "is-active": active(), "dsm-session-chip--sub": !!sess.synthetic }}
                  aria-busy={busy() ? "true" : undefined}
                >
                  {/* Working indicator — an inline SVG spinner, only mounted mid-turn. */}
                  <Show when={busy()}>
                    <span
                      class="dsm-session-chip-working"
                      role="status"
                      aria-label="Working"
                      title="Working"
                    >
                      <SpinnerIcon size={11} class="dsm-session-chip-spinner" />
                    </span>
                  </Show>
                  <button
                    type="button"
                    class="dsm-session-chip-label"
                    title={sess.synthetic ? `Subagent: ${sess.title || "Subagent"}` : sess.title || "New chat"}
                    onClick={() => selectSession(sess.id)}
                  >
                    <Show when={sess.synthetic}>
                      <span class="dsm-session-chip-sub-mark" aria-hidden="true">↳</span>
                    </Show>
                    {sess.title || "New chat"}
                  </button>
                  <button
                    type="button"
                    class="dsm-session-chip-close"
                    title="Close tab"
                    aria-label="Close tab"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeSession(sess.id)
                    }}
                  >
                    <XIcon size={11} />
                  </button>
                </div>
              )
            }}
          </For>
        </nav>

        <div class="dsm-topbar-actions">
          <button
            type="button"
            class="dsm-btn dsm-btn-icon"
            classList={{ "is-active": state.railOpen }}
            title={state.railOpen ? "Close chats" : "Show chats"}
            aria-label="Chats"
            onClick={() => setRailOpen(!state.railOpen)}
          >
            <ChatIcon size={15} />
          </button>
          <button
            type="button"
            class="dsm-btn dsm-btn-icon"
            title="New chat"
            aria-label="New chat"
            onClick={() => newChat()}
          >
            <PlusIcon size={15} />
          </button>
          <button
            type="button"
            class="dsm-btn dsm-btn-icon"
            disabled={!state.currentSessionID}
            title="Download chat transcript (Markdown)"
            aria-label="Download chat transcript"
            onClick={() => setConfirmDownload(true)}
          >
            <DownloadIcon size={15} />
          </button>
          <button
            type="button"
            class="dsm-btn dsm-btn-icon"
            classList={{ "is-active": state.settingsOpen }}
            title="Settings"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <GearIcon size={15} />
          </button>
        </div>
      </header>

      <Show when={!online()}>
        <div class="dsm-offline-banner" role="alert">
          You're offline. You can read your chats, but new messages need a connection.
        </div>
      </Show>

      <div class="dsm-body">
        <Show when={state.railOpen}>
          <>
            <div class="dsm-backdrop" onClick={() => setRailOpen(false)} />
            <SessionRail />
          </>
        </Show>
        <ChatView />
      </div>

      <Show when={state.settingsOpen}>
        <SettingsView />
      </Show>

      <ConfirmDialog
        open={confirmDownload()}
        title="Download transcript?"
        message="This will save the current chat transcript as a Markdown file to your device."
        confirmLabel="Download"
        onConfirm={() => {
          setConfirmDownload(false)
          exportTranscript()
        }}
        onCancel={() => setConfirmDownload(false)}
      />

      <WelcomeNotice />
    </div>
  )
}
