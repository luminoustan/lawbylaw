/**
 * composer/KeyBadge.tsx — tells the visitor whose key the next message will be written with:
 * the site owner's free shared key, or their own. Click opens Settings, where it is changed.
 *
 * It reads the same store the host reads at the start of every turn (`agent/key-store.ts`), and
 * follows it live, so it cannot say one thing while the app does another.
 */

import { createSignal, onCleanup, onMount } from "solid-js"
import { byokSummary, keyStatus, onKeyChange } from "../../agent/key-store"
import { useSession } from "../../store/session"

export function KeyBadge() {
  const { setSettingsOpen } = useSession()
  const [saved, setSaved] = createSignal(byokSummary())
  const status = () => keyStatus(saved())

  onMount(() => {
    // Re-read on any change (saved, removed, cleared, or changed in another tab).
    setSaved(byokSummary())
    onCleanup(onKeyChange(() => setSaved(byokSummary())))
  })

  return (
    <button
      type="button"
      class="dsm-keybadge"
      classList={{ "is-own": status().own }}
      data-key-source={status().own ? "own" : "shared"}
      title={status().detail}
      aria-label={`${status().label}. ${status().detail}`}
      onClick={() => setSettingsOpen(true)}
    >
      <span class="dsm-keybadge-dot" aria-hidden="true" />
      <span class="dsm-keybadge-text">{status().label}</span>
    </button>
  )
}
