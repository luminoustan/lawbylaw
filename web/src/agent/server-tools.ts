/**
 * server-tools.ts: the browser's client for the stateless server endpoints that make up the
 * server half of "bring your own key": `/api/agent`, `/api/tool`, `/api/cite`, `/api/links`.
 *
 * None of these take an LLM key and none of them are sent one.
 */

import { createGatedFetch, SessionError } from "../lib/session-gate"

export interface Citation {
  act_name: string
  section: string
  label: string
  url: string
  doc_type?: string
}

/** A retrieved section as the server returns it; sent back to `/api/cite` unchanged. */
export interface Section {
  text: string
  score: number
  section_id: string
  metadata: Record<string, unknown>
}

export type ToolContext =
  | "orchestrator"
  | "research_legislation"
  | "research_subsidiary"
  | "research_judiciary"
  | "agent_legislation"
  | "agent_judiciary"

export type CiteKind = "legislation" | "subsidiary_legislation" | "judiciary"

export interface ToolResult {
  result: string
  is_error: boolean
  citations: Citation[]
  sections: Section[]
}

export interface AgentRoute {
  agent: string
  context: ToolContext
  cite: CiteKind | null
}

export interface SubAgentSpec {
  system_prompt: string
  tools: unknown[]
  final_message: string | null
}

export interface ToolSchema {
  type: "function"
  function: { name: string; description?: string; parameters?: unknown }
}

export interface AgentBundle {
  mode: string
  system_prompt: string
  acts_context: string | null
  tools: ToolSchema[]
  /** The Tavily search tool, offered by the browser when the visitor has a Tavily key of their own. */
  tavily_tool?: ToolSchema
  agent_tools: Record<string, AgentRoute>
  subagents: Record<string, SubAgentSpec>
  params: {
    temperature: number
    top_p: number
    max_output_tokens: number
    subagent_max_output_tokens: number
    output_reserve_tokens: number
    context_window_size: number
    rag_context_fill_ratio: number
    rag_context_budget: number
    sub_agent_context_budget: number
    rag_search_hard_cap: number
    finalization_check: boolean
    tool_nudge: boolean
    max_nudges: number
    skip_check_after_tool_steps: number
    revision_min_chars: number
    max_web_searches: number
    max_orchestrator_reads: number
    context_tokens: number
    model_window: number
    message_chars: number
    max_messages: number
    request_timeout_s: number
  }
  texts: {
    tool_nudge: string
    finalization_nudge: string
    finalization_ok: string
    forced_final: string
    sub_forced_final: string
    sub_forced_final_suffix: string
    summariser_system: string
    summary_instruction: string
    summary_rules: string
    subagent_definitions: string
  }
}

/** The server could not be reached or refused the call. The message is safe to show. */
export class ServerToolError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = "ServerToolError"
    this.status = status
  }
}

/** A busy server answers 429 or 503 with `Retry-After`; those are worth waiting out. */
const RETRYABLE = new Set([429, 503])
/** Retries after the first attempt, for calls the answer depends on. */
const RETRIES = 3
/** The longest we will wait on one `Retry-After`; a longer ask (a restarting server) is given up on. */
const MAX_WAIT_MS = 4000
const BASE_BACKOFF_MS = 400

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new ServerToolError("Stopped."))
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new ServerToolError("Stopped."))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })

/** How long to wait before retrying, or null to give up. Honours `Retry-After` (seconds), with jitter. */
function waitFor(resp: Response, attempt: number, random: () => number): number | null {
  const header = Number(resp.headers.get("retry-after"))
  const asked = Number.isFinite(header) && header >= 0 && resp.headers.get("retry-after") !== null ? header * 1000 : BASE_BACKOFF_MS * 2 ** attempt
  if (asked > MAX_WAIT_MS) return null
  return Math.round(asked * (0.75 + random() * 0.5)) // spread out a herd that was refused together
}

export interface ServerTools {
  agent(mode: string, signal: AbortSignal): Promise<AgentBundle>
  tool(call: { tool: string; args: Record<string, unknown>; context: ToolContext }, signal: AbortSignal): Promise<ToolResult>
  cite(req: { kind: CiteKind; output: string; sections: Section[] }, signal: AbortSignal): Promise<{ result: string; is_error: boolean }>
  links(text: string, signal: AbortSignal): Promise<Citation[]>
  /** `/compact` on the shared key: the server's model summarises `history` (and folds in `summary`). */
  compact(history: readonly { role: string; content: string }[], summary: string | null, signal: AbortSignal): Promise<string>
}

export function createServerTools(
  opts: {
    baseUrl?: string
    fetchImpl?: typeof fetch
    /** Injectable for tests. */
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    random?: () => number
  } = {},
): ServerTools {
  const base = opts.baseUrl ?? ""
  const f = opts.fetchImpl ?? createGatedFetch({ baseUrl: base })
  const sleep = opts.sleep ?? abortableSleep
  const random = opts.random ?? Math.random

  async function call<T>(path: string, init: RequestInit, signal: AbortSignal, retries = RETRIES): Promise<T> {
    let resp: Response
    for (let attempt = 0; ; attempt++) {
      try {
        resp = await f(`${base}${path}`, { ...init, signal, cache: "no-store" })
      } catch (e) {
        if (e instanceof SessionError) throw new ServerToolError(e.message)
        throw new ServerToolError("Couldn't reach the server. Please try again in a moment.")
      }
      if (resp.ok || !RETRYABLE.has(resp.status) || attempt >= retries) break
      const wait = waitFor(resp, attempt, random)
      if (wait === null) break
      void resp.body?.cancel().catch(() => {})
      await sleep(wait, signal)
    }
    if (!resp.ok) {
      let message = "The server could not complete that request."
      try {
        const j = (await resp.json()) as { error?: { message?: unknown } }
        if (typeof j.error?.message === "string") message = j.error.message
      } catch {
        /* keep the generic message */
      }
      throw new ServerToolError(message, resp.status)
    }
    try {
      return (await resp.json()) as T
    } catch {
      throw new ServerToolError("The server sent an unreadable reply.")
    }
  }

  const post = (path: string, body: unknown, signal: AbortSignal, retries?: number) =>
    call<unknown>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, signal, retries)

  return {
    agent: (mode, signal) => call<AgentBundle>(`/api/agent?mode=${encodeURIComponent(mode)}`, { method: "GET" }, signal),
    async tool(c, signal) {
      const r = (await post("/api/tool", c, signal)) as Partial<ToolResult>
      return {
        result: typeof r.result === "string" ? r.result : "",
        is_error: r.is_error === true,
        citations: Array.isArray(r.citations) ? r.citations : [],
        sections: Array.isArray(r.sections) ? r.sections : [],
      }
    },
    async cite(req, signal) {
      const r = (await post("/api/cite", req, signal)) as { result?: unknown; is_error?: unknown }
      return { result: typeof r.result === "string" ? r.result : "", is_error: r.is_error === true }
    },
    async links(text, signal) {
      // Best effort while the answer streams: one retry at most, never hold the reply up for links.
      const r = (await post("/api/links", { text }, signal, 1)) as { citations?: unknown }
      return Array.isArray(r.citations) ? (r.citations as Citation[]) : []
    },
    async compact(history, summary, signal) {
      const body = { history: history.map(({ role, content }) => ({ role, content })), ...(summary ? { summary } : {}) }
      const r = (await post("/api/compact", body, signal, 1)) as { summary?: unknown }
      if (typeof r.summary !== "string") throw new ServerToolError("The server sent an unreadable reply.")
      return r.summary
    },
  }
}
