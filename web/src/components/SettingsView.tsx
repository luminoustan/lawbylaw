/**
 * SettingsView.tsx — Settings overlay: theme, the real server limits, privacy,
 * and a one-click "delete all my data".
 */

import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useSession } from "../store/session"
import { byokSummary, clearByok, onKeyChange, saveByok, type KeySummary } from "../agent/key-store"
import { clearTavily, saveTavily, tavilySummary, type TavilySummary } from "../agent/tavily-key"
import { compactTarget } from "../agent/compact"
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "../agent/providers"
import { createFocusTrap } from "../lib/focus-trap"
import { currentTheme, setTheme, type ThemeMode } from "../lib/theme"
import { postHostMessage } from "../lib/host-link"
import { XIcon } from "./icons"

interface Limits {
  message_chars?: number
  max_messages?: number
  context_tokens?: number
  rate_per_min?: number
  rate_burst?: number
  ip_concurrency?: number
  repeat_max?: number
  repeat_window_s?: number
  request_timeout_s?: number
  body_bytes?: number
}

/** Tells a user with their own key that `/compact` exists (it has no menu of its own) and which model writes the summary. */
function CompactHint(props: { provider: ProviderId }) {
  const writer = () => compactTarget(PROVIDERS[props.provider]).label
  return (
    <div class="dsm-setting-hint" data-testid="compact-hint">
      Tip: type <code>/compact</code> in the chat to summarise a long conversation and free up room.{" "}
      {writer() ? `${writer()} writes the summary, using your key.` : "Your key writes the summary, with the same model that answers."}
    </div>
  )
}


/**
 * Use your own provider key. The key is kept in this browser only and is sent only to the provider
 * you pick (see `agent/key-store.ts`). It is never shown again after saving, never put in app state,
 * and the input is cleared as soon as it is saved.
 */
function OwnKey() {
  const [saved, setSaved] = createSignal<KeySummary | null>(byokSummary())
  const [provider, setProvider] = createSignal<ProviderId>("nebius")
  const [remember, setRemember] = createSignal(true)
  const [error, setError] = createSignal("")
  let input: HTMLInputElement | undefined

  const save = (e: Event) => {
    e.preventDefault()
    const r = saveByok(provider(), input?.value ?? "", remember() ? "device" : "session")
    if (!r.ok) {
      setError(r.reason)
      return
    }
    if (input) input.value = ""
    setError("")
    setSaved(byokSummary())
  }
  const remove = () => {
    clearByok()
    setSaved(null)
  }
  const where = (k: KeySummary) =>
    k.remember === "device" ? "kept on this device" : k.remember === "session" ? "kept until you close this tab" : "kept in memory until you reload"

  return (
    <>
      <h2 class="dsm-settings-heading">Your own API key</h2>
      <div class="dsm-settings-card">
        <p class="dsm-settings-note">
          Optional. Add your own Nebius or DeepSeek key and replies are written using your account, so the shared limits below
          no longer apply to the writing. Your key is stored only in this browser and is sent only to the provider you choose,
          never to this site. The conversation then goes straight from your browser to that provider. This site still receives
          the legal-database searches the assistant makes and the text of each answer (to add links), and keeps neither.
        </p>
        <Show
          when={saved()}
          fallback={
            <form onSubmit={save} style={{ display: "flex", "flex-direction": "column", gap: "8px" }} autocomplete="off">
              <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }} role="group" aria-label="Provider">
                <For each={PROVIDER_IDS}>
                  {(id) => (
                    <button
                      type="button"
                      class="dsm-btn"
                      classList={{ "dsm-btn-primary": provider() === id }}
                      aria-pressed={provider() === id}
                      onClick={() => setProvider(id)}
                    >
                      {PROVIDERS[id].label}
                    </button>
                  )}
                </For>
              </div>
              <input
                ref={input}
                class="dsm-settings-input dsm-settings-input--wide"
                type="password"
                name="provider-api-key"
                aria-label={`${PROVIDERS[provider()].label} API key`}
                placeholder="Paste your API key"
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                data-1p-ignore
                data-lpignore="true"
              />
              <label class="dsm-setting-hint" style={{ display: "flex", gap: "6px", "align-items": "center" }}>
                <input type="checkbox" checked={remember()} onChange={(e) => setRemember(e.currentTarget.checked)} />
                Remember on this device (otherwise it is forgotten when you close this tab)
              </label>
              <div class="dsm-setting-hint">
                Don't have one?{" "}
                <a href={PROVIDERS[provider()].keyUrl} target="_blank" rel="noopener noreferrer">
                  Get a {PROVIDERS[provider()].label} key
                </a>
                . Calls are made to {new URL(PROVIDERS[provider()].baseUrl).host}.
              </div>
              <CompactHint provider={provider()} />
              <Show when={error()}>
                <div class="dsm-settings-error" role="alert">{error()}</div>
              </Show>
              <div>
                <button type="submit" class="dsm-btn dsm-btn-primary">Save key</button>
              </div>
            </form>
          }
        >
          {(k) => (
            <>
              <div class="dsm-provider-row">
                <div class="dsm-provider-info">
                  <span class="dsm-provider-name">{PROVIDERS[k().provider].label}</span>
                  <span class="dsm-provider-status" data-state="ok">
                    Using your key{k().hint ? ` ending in ${k().hint}` : ""}, {where(k())}
                  </span>
                </div>
                <button type="button" class="dsm-btn" onClick={remove}>Remove key</button>
              </div>
              <CompactHint provider={k().provider} />
            </>
          )}
        </Show>
      </div>
    </>
  )
}

/**
 * Use your own Tavily key for web search. Kept in this browser only and sent only to api.tavily.com
 * (see `agent/tavily-key.ts`). It is never shown again after saving and the input is cleared on save.
 * It applies when replies are written with your own model key: that is the only time the conversation
 * is handled in your browser, so it is the only time a key held here can be used without this site
 * receiving it.
 */
function OwnSearchKey() {
  const [saved, setSaved] = createSignal<TavilySummary | null>(tavilySummary())
  const [ownModel, setOwnModel] = createSignal(byokSummary() !== null)
  const [remember, setRemember] = createSignal(true)
  const [error, setError] = createSignal("")
  let input: HTMLInputElement | undefined
  onCleanup(onKeyChange(() => setOwnModel(byokSummary() !== null)))

  const save = (e: Event) => {
    e.preventDefault()
    const r = saveTavily(input?.value ?? "", remember() ? "device" : "session")
    if (!r.ok) {
      setError(r.reason)
      return
    }
    if (input) input.value = ""
    setError("")
    setSaved(tavilySummary())
  }
  const remove = () => {
    clearTavily()
    setSaved(null)
  }
  const where = (k: TavilySummary) =>
    k.remember === "device" ? "kept on this device" : k.remember === "session" ? "kept until you close this tab" : "kept in memory until you reload"

  return (
    <>
      <h2 class="dsm-settings-heading">Your own Tavily key (web search)</h2>
      <div class="dsm-settings-card" data-testid="tavily-settings">
        <p class="dsm-settings-note">
          Optional. The assistant can search the web for very recent news, forms and fees. Add your own{" "}
          <a href="https://app.tavily.com/home" target="_blank" rel="noopener noreferrer">Tavily</a> key and those searches use
          your account instead of the site owner's. Like your model key, it is stored only in this browser and is sent only to
          api.tavily.com, never to this site. It is used when replies are written with your own model key (above); with the free
          shared key, searches are made by the site.
        </p>
        <Show
          when={saved()}
          fallback={
            <form onSubmit={save} style={{ display: "flex", "flex-direction": "column", gap: "8px" }} autocomplete="off">
              <input
                ref={input}
                class="dsm-settings-input dsm-settings-input--wide"
                type="password"
                name="search-api-key"
                aria-label="Tavily API key"
                placeholder="Paste your Tavily API key (tvly-...)"
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                data-1p-ignore
                data-lpignore="true"
              />
              <label class="dsm-setting-hint" style={{ display: "flex", gap: "6px", "align-items": "center" }}>
                <input type="checkbox" checked={remember()} onChange={(e) => setRemember(e.currentTarget.checked)} />
                Remember on this device (otherwise it is forgotten when you close this tab)
              </label>
              <Show when={error()}>
                <div class="dsm-settings-error" role="alert">{error()}</div>
              </Show>
              <div>
                <button type="submit" class="dsm-btn dsm-btn-primary">Save Tavily key</button>
              </div>
            </form>
          }
        >
          {(k) => (
            <>
              <div class="dsm-provider-row">
                <div class="dsm-provider-info">
                  <span class="dsm-provider-name">Tavily</span>
                  <span class="dsm-provider-status" data-state="ok">
                    Saved{k().hint ? `, ending in ${k().hint}` : ""}, {where(k())}
                  </span>
                </div>
                <button type="button" class="dsm-btn" onClick={remove}>Remove key</button>
              </div>
              <div class="dsm-setting-hint" data-testid="tavily-status">
                {ownModel()
                  ? "Web searches use your Tavily key."
                  : "Not in use yet: replies are being written with the free shared key, so the site makes the searches. Add your own model key above to use this one."}
              </div>
            </>
          )}
        </Show>
      </div>
    </>
  )
}

export function SettingsView() {
  const { state, setSettingsOpen } = useSession()
  const [theme, setThemeSig] = createSignal<ThemeMode>(currentTheme())
  const [confirming, setConfirming] = createSignal(false)
  let panel: HTMLDivElement | undefined

  const cfg = () => state.config as { limits?: Limits; storageWarning?: string | null }
  const limits = () => cfg().limits ?? {}
  const close = () => setSettingsOpen(false)
  createFocusTrap(() => panel, () => true)

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => {
      window.removeEventListener("keydown", onKey)
    })
  })

  const rows = (): Array<[string, string]> => {
    const l = limits()
    return [
      ["Message length", `${l.message_chars?.toLocaleString() ?? "?"} characters`],
      ["Context window", `${Number(l.context_tokens ?? 0).toLocaleString()} tokens; type /compact to shorten a long chat`],
      ["Speed", `${l.rate_per_min ?? "?"} messages per minute, bursts of ${l.rate_burst ?? "?"}`],
      ["Repeats", `the same message at most ${l.repeat_max ?? "?"} times per ${l.repeat_window_s ?? "?"}s`],
      ["At a time", `${l.ip_concurrency ?? "?"} reply being written at once`],
      ["Reply time", `stopped after ${l.request_timeout_s ?? "?"} seconds`],
    ]
  }

  return (
    <div class="dsm-settings-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div ref={panel} class="dsm-settings" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="dsm-settings-head">
          <span class="dsm-settings-title">Settings</span>
          <button type="button" class="dsm-btn dsm-btn-icon" aria-label="Close settings" title="Close" onClick={close}>
            <XIcon size={14} />
          </button>
        </div>
        <div class="dsm-settings-panes" style={{ display: "block", overflow: "auto" }}>
          <div class="dsm-settings-content">
            <h2 class="dsm-settings-heading">Appearance</h2>
            <div class="dsm-settings-card">
              <div style={{ display: "flex", gap: "8px", padding: "8px" }}>
                <For each={["dark", "light"] as ThemeMode[]}>
                  {(m) => (
                    <button
                      type="button"
                      class="dsm-btn"
                      classList={{ "dsm-btn-primary": theme() === m }}
                      aria-pressed={theme() === m}
                      onClick={() => {
                        setTheme(m)
                        setThemeSig(m)
                      }}
                    >
                      {m === "dark" ? "Dark" : "Light"}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <OwnKey />

            <OwnSearchKey />

            <h2 class="dsm-settings-heading">Limits</h2>
            <div class="dsm-settings-card">
              <p class="dsm-settings-note">These limits keep the service available for everyone. They are enforced by the server.</p>
              <dl style={{ margin: "0", padding: "0 8px 8px", display: "grid", "grid-template-columns": "max-content 1fr", gap: "4px 16px" }}>
                <For each={rows()}>
                  {([k, v]) => (
                    <>
                      <dt style={{ color: "var(--dsm-muted)" }}>{k}</dt>
                      <dd style={{ margin: "0" }}>{v}</dd>
                    </>
                  )}
                </For>
              </dl>
            </div>

            <h2 class="dsm-settings-heading">Privacy</h2>
            <div class="dsm-settings-card">
              <p class="dsm-settings-note">
                No account or sign-in is needed. Your chats are stored only in this browser. When you send a message,
                the conversation is sent to the server to write a reply and is not saved there (with your own key, it
                goes to your provider instead; see above). This is general legal information, not legal advice.
              </p>
              <Show when={cfg().storageWarning}>
                <div class="dsm-settings-error" role="alert">{cfg().storageWarning}</div>
              </Show>
              <div style={{ padding: "8px" }}>
                <Show
                  when={confirming()}
                  fallback={
                    <button type="button" class="dsm-btn" onClick={() => setConfirming(true)}>
                      Delete all my chats, settings and API key
                    </button>
                  }
                >
                  <span style={{ "margin-right": "8px" }}>This cannot be undone.</span>
                  <button type="button" class="dsm-btn dsm-btn-primary" onClick={() => postHostMessage({ type: "clearAllData" })}>
                    Yes, delete everything
                  </button>
                  <button type="button" class="dsm-btn" style={{ "margin-left": "8px" }} onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                </Show>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
