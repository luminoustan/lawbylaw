/**
 * session-gate.ts — Cloudflare Turnstile session for the expensive /api routes.
 *
 * When the server enforces Turnstile (`GET /api/session` -> enforce), the first call to a
 * protected route solves an (almost always invisible) Turnstile challenge, exchanges it at
 * `POST /api/session` for a short-lived signed token, and sends that token in the
 * `x-lbl-session` header. It is kept in memory only: no cookies, no storage. Requests to any
 * other origin (the model providers, Tavily) are never touched.
 */

export const SESSION_HEADER = "x-lbl-session"
const PROTECTED = ["/api/chat", "/api/compact", "/api/tool", "/api/cite", "/api/links", "/api/agent"]
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
const REFRESH_MARGIN_S = 60

export interface SessionConfig {
  enforce: boolean
  site_key: string
}

export interface GateOptions {
  base?: typeof fetch
  baseUrl?: string
  /** Solves a Turnstile challenge and returns the widget token. Injectable for tests. */
  solve?: (siteKey: string) => Promise<string>
  now?: () => number
}

export class SessionError extends Error {}

function isProtected(url: string, baseUrl: string): boolean {
  let path = url
  if (baseUrl && url.startsWith(baseUrl)) path = url.slice(baseUrl.length)
  else if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return false
  const p = path.split("?")[0]!
  return PROTECTED.includes(p)
}

export function createGatedFetch(opts: GateOptions = {}): typeof fetch {
  const base = opts.base ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const baseUrl = opts.baseUrl ?? ""
  const solve = opts.solve ?? solveTurnstile
  const now = opts.now ?? (() => Date.now() / 1000)

  let config: Promise<SessionConfig> | null = null
  let token: { value: string; exp: number } | null = null
  let inflight: Promise<string | null> | null = null

  const loadConfig = (): Promise<SessionConfig> => {
    config ??= base(`${baseUrl}/api/session`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<SessionConfig>) : { enforce: false, site_key: "" }))
      .catch(() => {
        config = null
        return { enforce: false, site_key: "" }
      })
    return config
  }

  const mint = async (): Promise<string | null> => {
    const cfg = await loadConfig()
    if (!cfg.enforce) return null
    const widget = await solve(cfg.site_key)
    const r = await base(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: widget }),
      cache: "no-store",
    })
    if (!r.ok) {
      let msg = "Verification failed. Please reload the page and try again."
      try {
        const j = (await r.json()) as { error?: { message?: string } }
        if (j.error?.message) msg = j.error.message
      } catch {
        /* keep the default message */
      }
      throw new SessionError(msg)
    }
    const j = (await r.json()) as { session: string; expires_at: number }
    token = { value: j.session, exp: j.expires_at }
    return j.session
  }

  const session = async (force = false): Promise<string | null> => {
    if (!force && token && token.exp - REFRESH_MARGIN_S > now()) return token.value
    if (force) token = null
    inflight ??= mint().finally(() => {
      inflight = null
    })
    return inflight
  }

  const withToken = (init: RequestInit | undefined, t: string | null): RequestInit | undefined => {
    if (!t) return init
    const h = new Headers(init?.headers)
    h.set(SESSION_HEADER, t)
    return { ...init, headers: h }
  }

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!isProtected(url, baseUrl)) return base(input, init)
    let t: string | null
    try {
      t = await session()
    } catch (e) {
      // Surface as a network-style failure; callers already turn those into a readable error.
      throw e instanceof Error ? e : new SessionError("Verification failed.")
    }
    let resp = await base(input, withToken(init, t))
    if (resp.status === 403 && t) {
      // Expired or rejected token: mint a fresh one once and retry.
      const again = await session(true)
      resp = await base(input, withToken(init, again))
    }
    return resp
  }) as typeof fetch
}

interface TurnstileApi {
  render(el: HTMLElement, o: Record<string, unknown>): string
  remove(id: string): void
}

let scriptPromise: Promise<TurnstileApi> | null = null

function loadScript(): Promise<TurnstileApi> {
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const w = window as unknown as { turnstile?: TurnstileApi }
    if (w.turnstile) return resolve(w.turnstile)
    const s = document.createElement("script")
    s.src = TURNSTILE_SRC
    s.async = true
    s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new SessionError("Verification failed to load.")))
    s.onerror = () => {
      scriptPromise = null
      reject(new SessionError("Couldn't load the verification check. Check your connection and reload."))
    }
    document.head.appendChild(s)
  })
  return scriptPromise
}

/** Runs Turnstile in a corner container that is only visible if the visitor must interact. */
export async function solveTurnstile(siteKey: string): Promise<string> {
  const api = await loadScript()
  const box = document.createElement("div")
  box.setAttribute("data-turnstile-box", "")
  box.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000"
  document.body.appendChild(box)
  return new Promise<string>((resolve, reject) => {
    let id = ""
    const done = () => {
      try {
        if (id) api.remove(id)
      } catch {
        /* widget already gone */
      }
      box.remove()
    }
    id = api.render(box, {
      sitekey: siteKey,
      appearance: "interaction-only",
      callback: (t: string) => {
        done()
        resolve(t)
      },
      "error-callback": () => {
        done()
        reject(new SessionError("Verification failed. Please reload the page and try again."))
      },
      "timeout-callback": () => {
        done()
        reject(new SessionError("Verification timed out. Please try again."))
      },
    })
  })
}

/** The fetch the app uses for its own server: Turnstile-gated when the server asks for it. */
export const gatedFetch: typeof fetch = createGatedFetch()
