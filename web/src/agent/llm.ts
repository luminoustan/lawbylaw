/**
 * llm.ts: calls an OpenAI-compatible chat-completions endpoint straight from the browser, with
 * the user's own key.
 *
 * What this module guarantees about the key:
 * - it goes only into the `Authorization` header of a request to the chosen provider's fixed base URL;
 * - requests carry no cookies and no referrer;
 * - it never appears in an error message, a log, or anything returned to the caller.
 *
 * When the provider rejects a request, what it said is shown to the user (they own the key and the
 * account, and "insufficient balance" or "model not found" is exactly what they need to read). That
 * text is untrusted: it is read with a size and time cap, reduced to one plain line, has the key
 * removed if the provider echoed it, and is only ever rendered as text.
 *
 * Only `delta.content` is read. Reasoning fields are never read, shown or sent back.
 */

import { readSse, StreamIdleError } from "../host/sse"
import type { ApiMessage } from "./messages"
import { chatUrl, disableThinking, type Provider } from "./providers"

export type LlmErrorKind = "auth" | "billing" | "rate" | "context" | "server" | "network" | "rejected" | "idle" | "aborted"

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    readonly provider: Provider,
    readonly status?: number,
    /** What the provider said, already cleaned by `cleanDetail`. */
    readonly detail?: string,
  ) {
    super(messageFor(kind, provider, status, detail))
    this.name = "LlmError"
  }
}

/** What the provider said, as a suffix; empty when it said nothing usable. */
export const saidSuffix = (p: Provider, detail?: string): string => (detail ? ` ${p.label} said: "${detail}"` : "")

/** A user-facing message: our explanation first, then the provider's own words if it gave any. */
function messageFor(kind: LlmErrorKind, p: Provider, status?: number, detail?: string): string {
  return base(kind, p, status) + (kind === "network" || kind === "idle" || kind === "aborted" ? "" : saidSuffix(p, detail))
}

function base(kind: LlmErrorKind, p: Provider, status?: number): string {
  switch (kind) {
    case "auth":
      return `${p.label} rejected your API key. Check it in Settings.`
    case "billing":
      return `Your ${p.label} account has no remaining balance.`
    case "rate":
      return `${p.label} is limiting how fast your key can be used. Wait a moment and try again.`
    case "context":
      return `${p.label} could not accept the request (HTTP ${status ?? 400}); the conversation may be too long. Starting a new chat can help.`
    case "server":
      return `${p.label} had a problem (HTTP ${status ?? "5xx"}). Please try again in a moment.`
    case "network":
      return `Couldn't reach ${p.label} from your browser. Check your connection and try again.`
    case "idle":
      return "The connection stalled and the reply was stopped. Please try again."
    case "aborted":
      return "Stopped."
    case "rejected":
      return `${p.label} rejected the request (HTTP ${status ?? "4xx"}).`
  }
}

function kindForStatus(status: number): LlmErrorKind {
  if (status === 401 || status === 403) return "auth"
  if (status === 402) return "billing"
  if (status === 429) return "rate"
  if (status === 400 || status === 413) return "context"
  if (status >= 500) return "server"
  return "rejected"
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface Usage {
  prompt: number
  completion: number
}

export interface CallOptions {
  provider: Provider
  apiKey: string
  /** The request body without `model` and the thinking switch, which are added here. */
  payload: Record<string, unknown>
  /**
   * The request fields that turn thinking off for a model that does not use the provider's usual
   * switch. Merged in place of it, never alongside: Nemotron on Nebius answers `reasoning_effort:
   * "none"` with an empty `content` and the whole reply in a separate `reasoning` field.
   */
  thinkingOff?: Record<string, unknown>
  signal: AbortSignal
  fetchImpl?: typeof fetch
}

async function post(o: CallOptions): Promise<Response> {
  const payload = { model: o.provider.model, ...o.payload }
  if (o.thinkingOff) Object.assign(payload, o.thinkingOff)
  else disableThinking(o.provider, payload)
  const f = o.fetchImpl ?? fetch
  let resp: Response
  try {
    resp = await f(chatUrl(o.provider), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify(payload),
      signal: o.signal,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    })
  } catch {
    // A failed fetch (offline, blocked, CORS) says nothing useful and must not leak details.
    throw new LlmError(o.signal.aborted ? "aborted" : "network", o.provider)
  }
  if (!resp.ok) {
    const detail = await readErrorDetail(resp, o.apiKey)
    throw new LlmError(o.signal.aborted ? "aborted" : kindForStatus(resp.status), o.provider, resp.status, detail)
  }
  return resp
}

const MAX_ERROR_BODY_BYTES = 8 * 1024
const ERROR_BODY_MS = 5_000
const MAX_DETAIL_CHARS = 400
/** Real keys are far longer; redacting a very short string would mangle ordinary words. */
const MIN_REDACT_KEY_CHARS = 8

/** Read at most a few KB of an error body, giving up after a few seconds. Never throws. */
async function readCapped(resp: Response): Promise<string> {
  const reader = resp.body?.getReader()
  if (!reader) return ""
  const decoder = new TextDecoder()
  const timer = setTimeout(() => void reader.cancel().catch(() => {}), ERROR_BODY_MS)
  let text = ""
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      text += decoder.decode(value, { stream: true })
      if (bytes >= MAX_ERROR_BODY_BYTES) {
        void reader.cancel().catch(() => {})
        break
      }
    }
  } catch {
    /* use what arrived */
  } finally {
    clearTimeout(timer)
  }
  return text
}

/**
 * The human-readable part of a provider's error body, as one plain line, or undefined. Accepts the
 * shapes the two providers use (`{error:{message}}`, `{detail}`, `{message}`) and plain text; refuses
 * HTML and structured JSON it does not recognise rather than dumping it on the user.
 */
export function cleanDetail(raw: string, apiKey: string): string | undefined {
  const body = raw.trim()
  if (!body) return undefined
  let text: unknown = body
  try {
    const j = JSON.parse(body) as Record<string, unknown> | null
    const err = j && typeof j === "object" ? j.error : undefined
    text = [
      err && typeof err === "object" ? (err as Record<string, unknown>).message : undefined,
      typeof err === "string" ? err : undefined,
      j?.detail,
      j?.message,
    ].find((v) => typeof v === "string" && v.trim())
  } catch {
    if (body.startsWith("<")) return undefined // an HTML error page from a proxy
  }
  if (typeof text !== "string") return undefined
  let out = text
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim()
  // The provider may echo the credential back; the user must never see it on screen or in a screenshot.
  if (apiKey.length >= MIN_REDACT_KEY_CHARS) out = out.split(apiKey).join("[your key]")
  out = out.replace(/\b(?:sk|tf|nb|key)[-_][A-Za-z0-9_-]{12,}/gi, "[redacted]")
  if (!out) return undefined
  return [...out].length > MAX_DETAIL_CHARS ? `${[...out].slice(0, MAX_DETAIL_CHARS).join("")}…` : out
}

async function readErrorDetail(resp: Response, apiKey: string): Promise<string | undefined> {
  return cleanDetail(await readCapped(resp), apiKey)
}

function usageOf(u: unknown): Usage | null {
  if (!u || typeof u !== "object") return null
  const o = u as Record<string, unknown>
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  return { prompt: n(o.prompt_tokens), completion: n(o.completion_tokens) }
}

export interface StreamResult {
  content: string
  toolCalls: ToolCall[]
  usage: Usage
}

const IDLE_MS = 60_000

/** One streaming round. `onContent` receives each text delta as it arrives. */
export async function streamChat(
  o: CallOptions & { onContent: (text: string) => void; idleMs?: number },
): Promise<StreamResult> {
  const resp = await post({ ...o, payload: { ...o.payload, stream: true, stream_options: { include_usage: true } } })
  if (!resp.body) throw new LlmError("network", o.provider)

  let content = ""
  let usage: Usage = { prompt: 0, completion: 0 }
  const calls = new Map<number, ToolCall>()

  try {
    await readSse(
      resp.body,
      (data) => {
        const chunk = data as { usage?: unknown; choices?: { delta?: Record<string, unknown> }[] }
        usage = usageOf(chunk.usage) ?? usage
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta
          if (!delta) continue
          // `reasoning_content` and friends are deliberately never read.
          if (typeof delta.content === "string" && delta.content) {
            content += delta.content
            o.onContent(delta.content)
          }
          const fragments = delta.tool_calls
          if (Array.isArray(fragments)) {
            for (const f of fragments as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
              const idx = typeof f.index === "number" ? f.index : 0
              let entry = calls.get(idx)
              if (!entry) calls.set(idx, (entry = { id: "", name: "", arguments: "" }))
              if (typeof f.id === "string") entry.id = f.id
              if (typeof f.function?.name === "string") entry.name += f.function.name
              if (typeof f.function?.arguments === "string") entry.arguments += f.function.arguments
            }
          }
        }
      },
      o.idleMs ?? IDLE_MS,
      o.signal,
    )
  } catch (e) {
    if (o.signal.aborted) throw new LlmError("aborted", o.provider)
    if (e instanceof StreamIdleError) throw new LlmError("idle", o.provider)
    throw new LlmError("network", o.provider)
  }
  if (o.signal.aborted) throw new LlmError("aborted", o.provider)

  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc], i) => ({ ...tc, id: tc.id || `call_${i}` }))
  return { content, toolCalls, usage }
}

export interface ChatResult {
  content: string
  toolCalls: ToolCall[]
  finishReason: string
  usage: Usage
  /** Text of the assistant message exactly as the API returned it, for replaying in history. */
  tool_calls_raw: ApiMessage["tool_calls"]
}

/** One non-streaming round (sub-agents and summaries). */
export async function chat(o: CallOptions): Promise<ChatResult> {
  const resp = await post({ ...o, payload: { ...o.payload, stream: false } })
  let body: { choices?: { message?: Record<string, unknown>; finish_reason?: string }[]; usage?: unknown }
  try {
    body = await resp.json()
  } catch {
    throw new LlmError(o.signal.aborted ? "aborted" : "network", o.provider)
  }
  const choice = body.choices?.[0]
  const message = choice?.message ?? {}
  const raw = Array.isArray(message.tool_calls) ? (message.tool_calls as NonNullable<ApiMessage["tool_calls"]>) : undefined
  const toolCalls = (raw ?? []).map((tc, i) => ({
    id: typeof tc.id === "string" && tc.id ? tc.id : `call_${i}`,
    name: String(tc.function?.name ?? ""),
    arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : "{}",
  }))
  return {
    content: typeof message.content === "string" ? message.content : "",
    toolCalls,
    finishReason: choice?.finish_reason ?? "unknown",
    usage: usageOf(body.usage) ?? { prompt: 0, completion: 0 },
    tool_calls_raw: raw,
  }
}
