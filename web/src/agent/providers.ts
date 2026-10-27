/**
 * providers.ts: the LLM providers a user can bring their own key for.
 *
 * Presets are fixed in code on purpose. A key is only ever sent to the base URL of the
 * provider the user picked, and the picker offers these entries only: there is no free-text
 * URL or model, so a page (or anything that can write settings) cannot aim a key at a host
 * of its choosing. Mirrors `server/src/services/provider.rs`, which makes the same distinctions
 * for the server-side path.
 */

export type ProviderId = "deepseek" | "nebius"

export interface Provider {
  id: ProviderId
  label: string
  /** Chat-completions base URL. The key is sent here and nowhere else. */
  baseUrl: string
  /** The one model the app is tuned and tested against on this provider. */
  model: string
  /** Where the user creates a key. */
  keyUrl: string
}

export const PROVIDERS: Readonly<Record<ProviderId, Provider>> = Object.freeze({
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    // Same default as the server's DEEPSEEK_MODEL.
    model: "deepseek-flash",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  nebius: {
    id: "nebius",
    label: "Nebius",
    baseUrl: "https://api.tokenfactory.nebius.com/v1",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    keyUrl: "https://tokenfactory.nebius.com/",
  },
})

/** The order the Settings picker shows them in: Nebius on the left, DeepSeek on the right. */
export const PROVIDER_IDS: readonly ProviderId[] = ["nebius", "deepseek"]

export function isProviderId(x: unknown): x is ProviderId {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(PROVIDERS, x)
}

export function chatUrl(p: Provider): string {
  return `${p.baseUrl}/chat/completions`
}

/**
 * Turn the model's hidden reasoning off, using the switch the provider honours: DeepSeek's
 * `thinking` field is accepted but silently ignored by Nebius, which needs `reasoning_effort`.
 * The app always wants thinking off (deterministic tool arguments, tokens spent on the answer).
 */
export function disableThinking(p: Provider, payload: Record<string, unknown>): void {
  if (p.id === "nebius") payload.reasoning_effort = "none"
  else payload.thinking = { type: "disabled" }
}

/** Longest key accepted. Real keys are well under this. */
const MAX_KEY_CHARS = 512

/**
 * Normalise a pasted key, or explain why it cannot be one. Keys go into an HTTP header, so
 * anything outside printable ASCII (including whitespace inside the key) is refused rather
 * than sent: that closes header injection and catches a stray paste early.
 */
export function cleanApiKey(raw: string): { ok: true; key: string } | { ok: false; reason: string } {
  const key = raw.trim()
  if (!key) return { ok: false, reason: "Paste your API key." }
  if (key.length > MAX_KEY_CHARS) return { ok: false, reason: "That is too long to be an API key." }
  if (/[^\x21-\x7e]/.test(key)) return { ok: false, reason: "An API key has no spaces or special characters. Check what you pasted." }
  return { ok: true, key }
}
