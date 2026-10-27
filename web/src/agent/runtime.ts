/**
 * runtime.ts: the model loop, run in the browser with the user's own key.
 *
 * This is a port of the server-side loop (`stream_inner`, `non_streaming_with_tools` and the tool
 * executor in `server/src/`), emitting the same events the server streams, so the UI cannot tell
 * the two paths apart. Everything that is tuning or wording (prompts, tool definitions, limits,
 * nudge texts, sub-agent specs, routing) comes from `GET /api/agent`; nothing here is a second
 * copy that could drift. Corpus search, reads, web search, citation text and links go through the
 * server's stateless tool endpoints, which never see the key.
 *
 * Deliberately not ported: the gatekeeper and the daily token budget. Both exist to protect the
 * owner's spend, and here the user is spending their own.
 */

import { LlmError, chat, saidSuffix, streamChat, type CallOptions, type ToolCall } from "./llm"
import {
  type ApiMessage,
  type HistoryItem,
  attachToolNudge,
  buildApiMessages,
  displayTokens,
  estimateTokens,
  estimateToolsTokens,
  isOkReply,
  shouldCheck,
  splitSystemPromptTokens,
  trimToCap,
  truncateMessagesToFit,
  utf8Len,
} from "./messages"
import type { Provider } from "./providers"
import { TOOL_TAVILY, searchTavily } from "./tavily"
import {
  type AgentBundle,
  type AgentRoute,
  type Citation,
  type Section,
  type ServerTools,
  ServerToolError,
} from "./server-tools"

/** One event of the stream the UI consumes (see `handle` in `host/web-host.ts`). */
export type AgentEvent = { type: string; [key: string]: unknown }

export interface RunOptions {
  provider: Provider
  apiKey: string
  mode: string
  history: readonly HistoryItem[]
  /** Summary of earlier turns the client already holds, if any. */
  summary?: string | null
  signal: AbortSignal
  emit: (event: AgentEvent) => void
  server: ServerTools
  fetchImpl?: typeof fetch
  /**
   * The visitor's own Tavily key. When set, `web_search_tavily` is offered to the model even if the site
   * has no key, and each search goes from this browser straight to Tavily; this site never sees the key.
   */
  tavilyKey?: string | null
  /** Injectable for tests. */
  randomId?: () => string
}

/** How the UI labels each tool that starts a sub-agent (mirrors the server's `execute_tool`). */
const SUBAGENT_LABELS: Record<string, { description: string; type: string }> = {
  research_legislation: { description: "Legislation research", type: "legislation" },
  research_subsidiary_legislation: { description: "Subsidiary legislation research", type: "subsidiary-legislation" },
  research_judiciary: { description: "Judiciary research", type: "judiciary" },
  legislation_agent: { description: "Legislation agent", type: "legislation" },
  judiciary_agent: { description: "Judiciary agent", type: "judiciary" },
}

const TOOL_FAILED = "[ERROR] This search is unavailable right now."
const NO_RESPONSE = "The agent could not produce a response."
const CONTEXT_EXCEEDED = "Context window exceeded — conversation was too long. Please start a new chat session."
/** Link scanning cadence while the answer streams (the server scans every ~300 bytes). */
const LINK_SCAN_BYTES = 300
const LINK_SCAN_MIN_INTERVAL_MS = 1500

class Stopped extends Error {}

interface Outcome {
  text: string
  isError: boolean
}

const fill = (template: string, n: number) => template.replace("{n}", String(n))
const percent = (used: number, max: number) => Math.min(100, Math.floor((used * 100) / Math.max(1, max)))

export async function runAgentTurn(o: RunOptions): Promise<void> {
  try {
    await new Turn(o).run()
  } catch (e) {
    if (e instanceof Stopped || o.signal.aborted || (e instanceof LlmError && e.kind === "aborted")) return
    const message =
      e instanceof LlmError || e instanceof ServerToolError ? e.message : "The assistant ran into a problem. Please try again."
    o.emit({ type: "error", error: message })
  }
}

class Turn {
  private bundle!: AgentBundle
  private readonly id: () => string
  private readonly reads = { n: 0 }
  private readonly webs = { n: 0 }

  // Answer text as the user currently sees it, for link scanning.
  private answer = ""
  private sinceScan = 0
  private readonly sentLinks = new Set<string>()
  private scanning: Promise<void> | null = null
  private lastScanAt = 0

  constructor(private readonly o: RunOptions) {
    this.id = o.randomId ?? (() => crypto.randomUUID())
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  private emit(ev: AgentEvent) {
    if (this.o.signal.aborted) return
    if (ev.type === "token") {
      const text = String(ev.content ?? "")
      this.answer += text
      this.sinceScan += text.length
      if (this.sinceScan >= LINK_SCAN_BYTES || text.includes("\n")) void this.scanLinks(false)
    } else if (ev.type === "answer_reset") {
      this.answer = ""
      this.sinceScan = 0
    }
    this.o.emit(ev)
  }

  private readonly noticed = new Set<string>()

  /**
   * Tell the user about a problem that did not end the turn: the provider failing a step, or the
   * legal database staying busy after retries (the answer may then be less complete). Once per message.
   */
  private providerNotice(e: unknown) {
    const speak = (e instanceof LlmError && e.kind !== "aborted") || (e instanceof ServerToolError && (e.status === 429 || e.status === 503))
    if (!speak || this.noticed.has((e as Error).message)) return
    this.noticed.add((e as Error).message)
    this.emit({ type: "notice", message: (e as Error).message })
  }

  private ensureRunning() {
    if (this.o.signal.aborted) throw new Stopped()
  }

  private call(): Pick<CallOptions, "provider" | "apiKey" | "signal" | "fetchImpl"> {
    return { provider: this.o.provider, apiKey: this.o.apiKey, signal: this.o.signal, fetchImpl: this.o.fetchImpl }
  }

  /** Links for the Acts the answer names, sent as it grows. Best effort: a failure only costs links. */
  private scanLinks(finished: boolean): Promise<void> {
    if (!finished) {
      if (this.scanning || Date.now() - this.lastScanAt < LINK_SCAN_MIN_INTERVAL_MS) return Promise.resolve()
    }
    const run = async () => {
      if (finished && this.scanning) await this.scanning.catch(() => {})
      this.sinceScan = 0
      this.lastScanAt = Date.now()
      // Mid-stream, leave out a word that may still be arriving.
      let text = this.answer
      if (!finished && text && !/\s$/.test(text)) {
        const cut = text.search(/\s\S*$/)
        text = cut < 0 ? "" : text.slice(0, cut)
      }
      if (!text.trim()) return
      try {
        const found = await this.o.server.links(text, this.o.signal)
        const fresh = found.filter((c) => c.url && !this.sentLinks.has(c.url))
        fresh.forEach((c) => this.sentLinks.add(c.url))
        if (fresh.length > 0) this.emit({ type: "legislation_citations", citations: fresh })
      } catch {
        /* no links this time */
      }
    }
    const p = run().finally(() => {
      if (this.scanning === p) this.scanning = null
    })
    if (!finished) this.scanning = p
    return p
  }

  private async finish() {
    await this.scanLinks(true)
    this.emit({ type: "done" })
  }

  // ── turn setup ────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    const { o } = this
    this.bundle = await o.server.agent(o.mode, o.signal)
    if (o.tavilyKey && this.bundle.tavily_tool && !this.bundle.tools.some((t) => t.function.name === TOOL_TAVILY)) {
      this.bundle = { ...this.bundle, tools: [...this.bundle.tools, this.bundle.tavily_tool] }
    }
    const b = this.bundle
    const P = b.params
    const prior = o.summary && o.summary.trim() ? o.summary : null

    let messages = buildApiMessages({
      systemPrompt: b.system_prompt,
      actsContext: b.acts_context,
      summary: prior,
      history: o.history,
    })
    // Nothing summarises a chat on its own: the user does it with `/compact`. Past the hard input cap the
    // oldest turns are dropped instead, and the user is told.
    const t = trimToCap(messages, P.context_tokens)
    messages = t.messages

    const toolsEst = estimateToolsTokens(b.tools)
    const [sysEst, subEst] = splitSystemPromptTokens(b.system_prompt, b.texts.subagent_definitions)
    const baseCtx = estimateTokens(messages)
    this.emit({ type: "breakdown", system: sysEst, tools: toolsEst, summary: prior ? displayTokens(prior) : 0, subagent: subEst })
    this.emit({ type: "context_usage", used: baseCtx, max: P.model_window, percent: percent(baseCtx, P.model_window) })
    if (t.notice) this.emit({ type: "notice", message: t.notice })

    await this.mainLoop(messages)
  }

  // ── main loop (port of `stream_inner`) ────────────────────────────────────

  private async mainLoop(initial: ApiMessage[]): Promise<void> {
    const { bundle: b } = this
    const P = b.params
    const T = b.texts
    let working = initial
    const hardCap = P.rag_search_hard_cap
    const budget = P.context_window_size - P.output_reserve_tokens
    const maxSearchTokens = Math.floor(budget * P.rag_context_fill_ratio)
    const hardInputLimit = Math.floor(budget * 0.75)

    let searchCount = 0
    let lastCtx = 0
    let nudgesUsed = 0
    let toolSteps = 0
    let pendingDraft: string | null = null
    let draftOnScreen = false // the pending draft already streamed to the user as it was written

    // Settle a draft whose check cannot complete: it is the answer, shown if it is not already.
    const flushDraft = () => {
      if (pendingDraft !== null && !draftOnScreen) this.emit({ type: "token", content: pendingDraft })
      pendingDraft = null
    }

    search: while (searchCount < hardCap) {
      this.ensureRunning()
      if (estimateTokens(working) >= maxSearchTokens) break

      const wasPending = pendingDraft !== null
      const hold = shouldCheck({
        enabled: P.finalization_check,
        nudgesUsed,
        toolSteps,
        wasPending,
        maxNudges: P.max_nudges,
        skipAfterToolSteps: P.skip_check_after_tool_steps,
      })
      // The first answer streams live; only the verification reply is buffered (usually just `OK`).
      const verifying = wasPending
      let held = ""
      let liveStreamed = false // text of a round that may turn out to be narration
      let revisionStreamed = false
      if (hold) this.emit({ type: "phase", phase: "synthesizing" })

      let round
      try {
        round = await streamChat({
          ...this.call(),
          payload: {
            messages: working,
            tools: b.tools,
            tool_choice: "auto",
            temperature: P.temperature,
            top_p: P.top_p,
            max_tokens: P.max_output_tokens,
          },
          onContent: (content) => {
            if (!verifying) {
              liveStreamed = true
              this.emit({ type: "token", content })
            } else if (revisionStreamed) {
              this.emit({ type: "token", content })
            } else {
              held += content
              // Clearly a rewritten answer rather than `OK`: swap it in for the draft, stream the rest live.
              if ([...held.trim()].length > P.revision_min_chars && !isOkReply(held, T.finalization_ok)) {
                if (draftOnScreen) {
                  this.emit({ type: "answer_reset" })
                  draftOnScreen = false
                }
                revisionStreamed = true
                this.emit({ type: "token", content: held })
              }
            }
          },
        })
      } catch (e) {
        if (e instanceof LlmError && e.kind === "context") {
          working = truncateMessagesToFit(working, maxSearchTokens)
          break search // too long: truncate and force the final answer
        }
        flushDraft()
        throw e
      }

      lastCtx = round.usage.prompt + round.usage.completion
      const hadToolCalls = round.toolCalls.length > 0
      const accumulated = round.content

      if (hadToolCalls) {
        // Text alongside a tool call is pre-tool narration, not the answer: retract what streamed.
        // A pending draft is kept: the model may be investigating during the check.
        if (liveStreamed || revisionStreamed) {
          this.emit({ type: "answer_reset" })
          if (revisionStreamed) draftOnScreen = false // the partial revision replaced the draft
        }
      } else if (hold) {
        if (pendingDraft !== null) {
          const draft: string = pendingDraft
          pendingDraft = null
          if (revisionStreamed) {
            /* revised answer already streamed */
          } else if (!held.trim() || isOkReply(held, T.finalization_ok)) {
            if (!draftOnScreen) this.emit({ type: "token", content: draft }) // confirmed
          } else {
            if (draftOnScreen) this.emit({ type: "answer_reset" })
            this.emit({ type: "token", content: held }) // revised
          }
          draftOnScreen = false
        } else if (accumulated.trim()) {
          // First final answer: already streamed. Keep it as the draft and ask for one check behind it.
          working.push({ role: "assistant", content: accumulated })
          working.push({ role: "user", content: T.finalization_nudge })
          nudgesUsed++
          pendingDraft = accumulated
          draftOnScreen = true
          continue search
        }
      }

      if (!hadToolCalls) {
        this.emit({ type: "context_usage", used: lastCtx, max: P.context_window_size, percent: percent(lastCtx, P.context_window_size) })
        await this.finish()
        return
      }

      // Replay the assistant message with its tool calls, then run them all in parallel.
      const calls = round.toolCalls
      working.push({
        role: "assistant",
        content: accumulated || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      })
      const results = await Promise.all(calls.map((c) => this.runOrchestratorCall(c)))
      this.ensureRunning()

      searchCount += calls.length
      toolSteps++

      if (results.every((r) => r.isError)) {
        // Nothing worked: stop searching and tell the model to answer without it.
        const why = results[0]!.text.replace(/^\[ERROR\]\s*/, "") || "search unavailable"
        calls.forEach((c) =>
          working.push({
            role: "tool",
            tool_call_id: c.id,
            content: `[Search unavailable: ${why}. Answer from general knowledge, clearly stating you could not verify against the database.]`,
          }),
        )
        break search
      }

      // Cap each result so one large sub-agent answer cannot swamp the context.
      const maxChars = P.rag_context_budget * 2
      calls.forEach((c, i) => {
        const raw = results[i]!.text
        const content = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n\n[... trimmed to fit context budget]` : raw
        working.push({ role: "tool", tool_call_id: c.id, content })
      })
      if (P.tool_nudge) attachToolNudge(working, T.tool_nudge)

      if (estimateTokens(working) >= maxSearchTokens) break
    }

    // A draft still waiting for its check when the loop ended is the answer.
    if (pendingDraft !== null) {
      flushDraft()
      this.emit({ type: "context_usage", used: lastCtx, max: P.context_window_size, percent: percent(lastCtx, P.context_window_size) })
      await this.finish()
      return
    }

    // ── forced final answer ─────────────────────────────────────────────────
    this.emit({ type: "phase", phase: "synthesizing" })
    working.push({ role: "user", content: fill(T.forced_final, searchCount) })
    if (estimateTokens(working) >= hardInputLimit) working = truncateMessagesToFit(working, hardInputLimit)

    const finalCall = (messages: ApiMessage[]) =>
      streamChat({
        ...this.call(),
        payload: { messages, temperature: P.temperature, top_p: P.top_p, max_tokens: P.max_output_tokens },
        onContent: (content) => this.emit({ type: "token", content }),
      })
    let last
    try {
      last = await finalCall(working)
    } catch (e) {
      if (!(e instanceof LlmError && e.kind === "context")) throw e
      // The estimate was still too low: keep only the system prompt and the last message and retry once.
      const minimal = working.length >= 2 ? [working[0]!, working[working.length - 1]!] : working
      try {
        last = await finalCall(minimal)
      } catch (e2) {
        if (!(e2 instanceof LlmError && e2.kind === "context")) throw e2
        this.emit({ type: "error", error: CONTEXT_EXCEEDED + saidSuffix(e2.provider, e2.detail) })
        return
      }
    }
    lastCtx = last.usage.prompt + last.usage.completion
    this.emit({ type: "context_usage", used: lastCtx, max: P.context_window_size, percent: percent(lastCtx, P.context_window_size) })
    await this.finish()
  }

  // ── tools ─────────────────────────────────────────────────────────────────

  private parseArgs(raw: string): Record<string, unknown> {
    try {
      const v = JSON.parse(raw)
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  /** One orchestrator tool call, with its events. Never throws except when the turn is stopped or the key is bad. */
  private async runOrchestratorCall(c: ToolCall): Promise<Outcome> {
    const args = this.parseArgs(c.arguments)
    this.emit({ type: "tool_call", name: c.name, arguments: args, id: c.id })
    this.emit({ type: "tool_progress", name: c.name, searches: 1, phase: "searching" })

    const label = SUBAGENT_LABELS[c.name]
    if (label) {
      this.emit({
        type: "subagent_start",
        task_id: c.id,
        tool: c.name,
        description: label.description,
        subagent_type: label.type,
        prompt: String(args.prompt ?? ""),
      })
    }

    let out: Outcome
    try {
      out = await this.executeTool(c.name, args, c.id)
    } catch (e) {
      // A bad key or a stop ends the turn; any other failure is just a failed tool.
      if (e instanceof Stopped || (e instanceof LlmError && ["auth", "billing", "aborted"].includes(e.kind))) throw e
      this.providerNotice(e)
      out = { text: e instanceof ServerToolError && (e.status === 429 || e.status === 503) ? `[ERROR] ${e.message}` : TOOL_FAILED, isError: true }
    }
    this.ensureRunning()
    if (label) this.emit({ type: "subagent_end", task_id: c.id, is_error: out.isError || out.text.startsWith("[ERROR]"), output: out.text })
    this.emit({ type: "tool_result", name: c.name, result: out.text, id: c.id })
    return out
  }

  private async executeTool(name: string, args: Record<string, unknown>, callId: string): Promise<Outcome> {
    const P = this.bundle.params
    if ((name === "web_search_tavily" || name === "web_search_deepseek") && this.webs.n++ >= P.max_web_searches) {
      return {
        text: `No more web searches are available this turn (${P.max_web_searches} used). Write your answer now from what you already have.`,
        isError: false,
      }
    }
    if ((name === "get_section" || name === "get_judgment") && this.reads.n++ >= P.max_orchestrator_reads) {
      return {
        text: `No more reads are available this turn (${P.max_orchestrator_reads} used). Write your answer now from the findings and text you already have.`,
        isError: false,
      }
    }

    if (name === TOOL_TAVILY && this.o.tavilyKey) {
      const r = await searchTavily(this.o.tavilyKey, args, { signal: this.o.signal, fetchImpl: this.o.fetchImpl })
      return { text: r.text, isError: !r.ok }
    }

    const route = this.bundle.agent_tools[name]
    if (route) return this.runSubAgent(name, route, args, callId)
    if (name === "classify_issue") return { text: classifyIssue(args), isError: false }
    if (name === "askquestion") return this.askQuestion(args)

    const r = await this.o.server.tool({ tool: name, args, context: "orchestrator" }, this.o.signal)
    this.emitCitations(r.citations)
    return { text: r.result, isError: r.is_error }
  }

  private emitCitations(citations: Citation[]) {
    if (citations.length > 0) this.emit({ type: "legislation_citations", citations })
  }

  private askQuestion(args: Record<string, unknown>): Outcome {
    const questions = args.questions
    const count = Array.isArray(questions) ? questions.length : 0
    if (count === 0) return { text: "No questions were provided, so nothing was shown to the user.", isError: false }
    this.emit({
      type: "questionRequest",
      requestId: this.id(),
      questions,
      ...(typeof args.title === "string" ? { title: args.title } : {}),
    })
    return {
      text:
        `Asked the user ${count} question(s); they are shown in the UI as an interactive form. ` +
        "End your turn now with a one-line note and wait for the user's answers.",
      isError: false,
    }
  }

  // ── sub-agents (port of `run_sub_agent` and `non_streaming_with_tools`) ──

  private async runSubAgent(name: string, route: AgentRoute, args: Record<string, unknown>, callId: string): Promise<Outcome> {
    const spec = this.bundle.subagents[route.agent]
    if (!spec) return { text: TOOL_FAILED, isError: true }

    let prompt = String(args.prompt ?? "")
    if (name === "research_subsidiary_legislation") {
      const parents = Array.isArray(args.parent_act_names) ? args.parent_act_names.filter((v): v is string => typeof v === "string") : []
      if (parents.length > 0) prompt = `${prompt}\n\nParent Act(s) to research: ${parents.join(", ")}`
    }

    // Everything the agent retrieves, in call order; the server merges it when resolving references.
    const sections: Section[] = []
    let n = 0
    const tool = async (tname: string, targs: Record<string, unknown>): Promise<string> => {
      const id = `s${n++}`
      this.emit({ type: "subagent_tool_call", task_id: callId, id, name: tname, arguments: targs })
      let text: string
      let isError: boolean
      try {
        const r = await this.o.server.tool({ tool: tname, args: targs, context: route.context }, this.o.signal)
        sections.push(...r.sections)
        this.emitCitations(r.citations)
        text = r.result
        isError = r.is_error || text.startsWith("[ERROR]")
      } catch (e) {
        this.ensureRunning()
        this.providerNotice(e)
        text = e instanceof ServerToolError && (e.status === 429 || e.status === 503) ? `[ERROR] ${e.message}` : TOOL_FAILED
        isError = true
      }
      this.emit({ type: "subagent_tool_result", task_id: callId, id, name: tname, result: text, is_error: isError })
      return text
    }

    const content = (await this.agentLoop(name, spec.system_prompt, prompt, spec.tools, spec.final_message, tool)) || NO_RESPONSE
    if (!route.cite) return { text: content, isError: false }
    const cited = await this.o.server.cite({ kind: route.cite, output: content, sections }, this.o.signal)
    return { text: cited.result, isError: cited.is_error }
  }

  private async agentLoop(
    toolName: string,
    systemPrompt: string,
    prompt: string,
    tools: unknown[],
    finalOverride: string | null,
    runTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  ): Promise<string> {
    const P = this.bundle.params
    const T = this.bundle.texts
    const hardCap = P.rag_search_hard_cap
    const maxSearchTokens = P.sub_agent_context_budget
    let working: ApiMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ]
    let searchCount = 0

    while (searchCount < hardCap) {
      this.ensureRunning()
      if (estimateTokens(working) >= maxSearchTokens) break
      let r
      try {
        r = await chat({
          ...this.call(),
          payload: { messages: working, tools, tool_choice: "auto", temperature: 0, max_tokens: P.subagent_max_output_tokens },
        })
      } catch (e) {
        if (e instanceof LlmError && e.kind === "context") {
          working = truncateMessagesToFit(working, maxSearchTokens)
          break
        }
        throw e
      }
      if (r.finishReason !== "tool_calls") return r.content

      searchCount += r.toolCalls.length
      working.push({ role: "assistant", content: r.content || null, tool_calls: r.tool_calls_raw })
      for (const tc of r.toolCalls) {
        const text = await runTool(tc.name, this.parseArgs(tc.arguments))
        working.push({ role: "tool", tool_call_id: tc.id, content: text })
      }
      this.emit({ type: "tool_progress", name: toolName, searches: searchCount, phase: "searching" })
      if (estimateTokens(working) >= maxSearchTokens) break
    }

    this.emit({ type: "tool_progress", name: toolName, searches: searchCount, phase: "synthesising" })
    working.push({
      role: "user",
      content: finalOverride ? finalOverride + fill(T.sub_forced_final_suffix, searchCount) : fill(T.sub_forced_final, searchCount),
    })
    const hardInputLimit = Math.floor((P.context_window_size - P.output_reserve_tokens) * 0.75)
    if (estimateTokens(working) >= hardInputLimit) working = truncateMessagesToFit(working, hardInputLimit)

    const last = await chat({
      ...this.call(),
      payload: { messages: working, temperature: 0, max_tokens: P.subagent_max_output_tokens },
    })
    return last.content
  }
}

/** Local tool: echoes the model's classification back so it is part of the conversation. */
export function classifyIssue(args: Record<string, unknown>): string {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
  const parts = [`Classification: ${strings(args.categories).join(", ")}`]
  const summary = typeof args.summary === "string" ? args.summary : ""
  if (summary) parts.push(`Summary: ${summary}`)
  const missing = strings(args.missing_details)
  if (missing.length > 0) parts.push(`Still needed: ${missing.join("; ")}`)
  return parts.join("\n")
}

export { utf8Len }
