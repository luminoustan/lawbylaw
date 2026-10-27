/**
 * web-host.ts — the in-page "host" behind the chat UI.
 *
 * The UI posts plain messages (`sendMessage`, `loadSessions`, ...) through
 * `lib/host-link`; this class answers them with events (`messageCreated`,
 * `partUpdated`, ...). It:
 *   - keeps chats in the visitor's browser (storage.ts),
 *   - runs the agent loop in the browser (`agent/runtime`) against the stateless
 *     server's tools and the visitor's own model key,
 *   - maps the loop's events onto the UI's message events.
 *
 * Nothing about a visitor is stored on the server.
 */

import { createGatedFetch, SessionError } from "../lib/session-gate"
import type { WireMessage, WirePart, WireSession, WireTokenUsage, ToolPart } from "../lib/types"
import { openStorage, MAX_CHATS, MAX_MESSAGES_PER_CHAT, type ChatStorage, type StoredChat, type StoredSubagent } from "./storage"
import { sanitizeCitations, enrichWithCitations, type Citation } from "../lib/citations"
import { computeContextBreakdown } from "../lib/context-breakdown"
import { clipToolOutput } from "../lib/tool-output"
import { readSse, StreamIdleError } from "./sse"
import { PROVIDERS, type ProviderId } from "../agent/providers"
import { clearByok, loadByok } from "../agent/key-store"
import { clearTavily, loadTavily } from "../agent/tavily-key"
import {
  buildApiMessages,
  displayTokens,
  estimateTokens,
  estimateToolsTokens,
  splitSystemPromptTokens,
  type HistoryItem,
} from "../agent/messages"
import { compactHistory, compactTarget } from "../agent/compact"
import { LlmError } from "../agent/llm"
import { runAgentTurn } from "../agent/runtime"
import { connectHost } from "../lib/host-link"
import { createServerTools, ServerToolError } from "../agent/server-tools"

export interface ServerLimits {
  body_bytes: number
  message_chars: number
  max_messages: number
  context_tokens: number
  rate_per_min: number
  rate_burst: number
  ip_concurrency: number
  repeat_max: number
  repeat_window_s: number
  tool_rounds: number
  request_timeout_s: number
}

export const DEFAULT_LIMITS: ServerLimits = {
  body_bytes: 1048576,
  message_chars: 200_000,
  max_messages: 200,
  context_tokens: 200000,
  rate_per_min: 8,
  rate_burst: 4,
  ip_concurrency: 1,
  repeat_max: 3,
  repeat_window_s: 60,
  tool_rounds: 10,
  request_timeout_s: 180,
}

/** The only answering mode the server has. */
const MODE = "legislation"
const ASSISTANT_CHARS = 16000
const IDLE_MS = 35_000
const CONNECT_MS = 30_000
/** Research tools that run as sub-agents (rendered as `task` rows with an openable transcript). */
const SUBAGENT_TOOLS = new Set(["research_legislation", "research_subsidiary_legislation", "research_judiciary", "legislation_agent", "judiciary_agent"])

type Msg = Record<string, unknown>

let seq = 0
const id = (p: string) => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}`

interface Turn {
  controller: AbortController
  userAborted: boolean
  timedOut: boolean
}

interface PendingQuestion {
  sessionID: string
  requestId: string
  questions: unknown[]
}

/** Render the user's form answers as the text of the next user turn. */
export function formatQuestionAnswers(questions: unknown[], answers: unknown[][]): string {
  const lines: string[] = []
  questions.forEach((q, i) => {
    const prompt =
      q && typeof q === "object" && typeof (q as { prompt?: unknown }).prompt === "string"
        ? String((q as { prompt: string }).prompt)
        : `Question ${i + 1}`
    const given = (answers[i] ?? []).map((a) => String(a)).filter((a) => a.trim() !== "")
    if (given.length > 0) lines.push(`- ${prompt}: ${given.join(", ")}`)
  })
  return lines.length === 0 ? "" : `[Answers to your questions]\n${lines.join("\n")}`
}

export interface HostOptions {
  /** Where the server lives (default same origin). */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /**
   * The user's own provider key, if they have set one. Read per turn, so removing the key takes
   * effect immediately. When present the model loop runs in this browser and the key goes only to
   * the provider; the server is used for tools alone. Absent (the default) means `/api/chat`.
   */
  getByok?: () => { provider: ProviderId; key: string } | null
  /** The visitor's own Tavily search key, if any. Read once per turn; never stored in app state. */
  getTavily?: () => string | null
}

export class WebHost {
  private storage!: ChatStorage
  private chats = new Map<string, StoredChat>()
  private turns = new Map<string, Turn>()
  private limits: ServerLimits = DEFAULT_LIMITS
  private storageWarning: string | null = null
  private pendingQuestion: PendingQuestion | null = null
  private queuedQuestion: { sessionID: string; text: string } | null = null
  private ready: Promise<void>
  private baseUrl: string
  private fetchImpl: typeof fetch
  private getByok: () => { provider: ProviderId; key: string } | null
  private getTavily: () => string | null

  constructor(
    private emit: (m: Msg) => void,
    opts: HostOptions = {},
  ) {
    this.getByok = opts.getByok ?? (() => null)
    this.getTavily = opts.getTavily ?? (() => null)
    this.baseUrl = opts.baseUrl ?? ""
    this.fetchImpl = opts.fetchImpl ?? createGatedFetch({ baseUrl: this.baseUrl })
    this.ready = this.init()
  }

  private async init(): Promise<void> {
    this.storage = await openStorage((reason) => {
      this.storageWarning = reason
      this.emit({ type: "sendMessageFailed", error: reason })
    })
    for (const c of await this.storage.loadAll()) this.chats.set(c.id, c)
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 5000)
      const r = await this.fetchImpl(`${this.baseUrl}/api/limits`, { signal: ctrl.signal })
      clearTimeout(t)
      if (r.ok) this.limits = { ...DEFAULT_LIMITS, ...(await r.json()) }
    } catch {
      /* defaults are fine */
    }
  }

  // ── inbound (UI → host) ─────────────────────────────────────────────
  async handle(m: Msg): Promise<void> {
    await this.ready
    switch (m.type) {
      case "uiReady":
        this.emit({ type: "ready" })
        return
      case "requestConfig":
        this.emit({ type: "configLoaded", config: { limits: this.limits, storageWarning: this.storageWarning } })
        return
      case "loadSessions":
        this.emit({ type: "sessionsLoaded", sessions: [...this.chats.values()].map(toSession) })
        return
      case "createSession":
        await this.createChat()
        return
      case "deleteSession": {
        const sid = String(m.sessionID)
        // Deleting a session is deliberate, not a failure: mark its turn as
        // user-stopped so it closes quietly instead of raising an error banner.
        const turn = this.turns.get(sid)
        if (turn) {
          turn.userAborted = true
          turn.controller.abort()
        }
        this.chats.delete(sid)
        await this.storage.remove(sid)
        this.emit({ type: "sessionDeleted", sessionID: sid })
        return
      }
      case "renameSession": {
        const c = this.chats.get(String(m.sessionID))
        if (!c) return
        c.title = String(m.title ?? "").slice(0, 120)
        c.updatedAt = new Date().toISOString()
        await this.storage.save(c)
        this.emit({ type: "sessionUpdated", session: { id: c.id, title: c.title, updatedAt: c.updatedAt } })
        return
      }
      case "loadMessages": {
        const sid = String(m.sessionID)
        const c = this.chats.get(sid)
        this.emit({ type: "messagesLoaded", sessionID: sid, messages: c?.messages ?? [], subagents: liveSubagents(c) })
        if (c?.compaction) this.emit({ type: "contextCompressed", sessionID: sid, method: "llm-summary" })
        return
      }
      case "sendMessage": {
        let sid = m.sessionID ? String(m.sessionID) : ""
        if (!sid || !this.chats.has(sid)) sid = (await this.createChat()).id
        await this.runUserTurn(sid, String(m.text ?? ""), String(m.messageID ?? id("msg")))
        return
      }
      case "compactContext":
        await this.compactChat(String(m.sessionID ?? ""))
        return
      case "editMessage": {
        const sid = String(m.sessionID)
        const chat = this.chats.get(sid)
        if (!chat) return
        const idx = chat.messages.findIndex((x) => x.id === m.messageID && x.role === "user")
        if (idx < 0) {
          this.emit({ type: "sendMessageFailed", sessionID: sid, edit: true, error: "That message can no longer be edited." })
          return
        }
        chat.messages.splice(idx)
        if (chat.compaction && !chat.messages.some((x) => x.id === chat.compaction!.afterId)) delete chat.compaction
        await this.runUserTurn(sid, String(m.text ?? ""), String(m.messageID))
        return
      }
      case "abort": {
        const t = this.turns.get(String(m.sessionID))
        if (t) {
          t.userAborted = true
          t.controller.abort()
        }
        return
      }
      case "requestSessionModelUsage": {
        const sid = String(m.sessionID)
        const last = [...(this.chats.get(sid)?.messages ?? [])].reverse().find((x) => x.role === "assistant" && x.tokens)
        const input = last?.tokens?.input ?? 0
        const output = last?.tokens?.output ?? 0
        this.emit({
          type: "sessionModelUsageLoaded",
          sessionID: sid,
          requestID: m.requestID,
          data: {
            sessionIDs: [sid],
            totals: { steps: 1, cost: 0, tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } } },
            models: [],
          },
        })
        return
      }
      case "exportSessionTranscript": {
        const c = this.chats.get(String(m.sessionID))
        if (c) this.emit({ type: "transcriptExported", filename: fileName(c), markdown: toMarkdown(c) })
        return
      }
      case "openExternal": {
        try {
          const u = new URL(String(m.url))
          if (u.protocol === "https:" || u.protocol === "http:") window.open(u.href, "_blank", "noopener,noreferrer")
        } catch {
          /* ignore */
        }
        return
      }
      case "clearAllData":
        for (const t of this.turns.values()) t.controller.abort()
        await this.storage.clear()
        this.chats.clear()
        clearByok() // "delete all my data" includes the API keys, wherever they are kept
        clearTavily()
        try {
          localStorage.clear()
        } catch {
          /* ignore */
        }
        location.reload()
        return
      case "questionReply": {
        // The askquestion dock answered (or dismissed) the form. Send the
        // answers as the next user turn so the stateless server can continue.
        const q = this.pendingQuestion
        if (!q || q.requestId !== String(m.requestId ?? "")) return
        this.pendingQuestion = null
        if (m.dismissed) return
        const answers = (Array.isArray(m.answers) ? m.answers : []) as unknown[][]
        const text = formatQuestionAnswers(q.questions, answers)
        if (!text) return
        if (this.turns.has(q.sessionID)) {
          // The asking turn may still be streaming. Queue the answer instead of
          // dropping it: runUserTurn refuses to start while a turn is active.
          this.queuedQuestion = { sessionID: q.sessionID, text }
          return
        }
        await this.runUserTurn(q.sessionID, text, id("msg"))
        return
      }
      default:
        return // Anything else is not part of this app's protocol.
    }
  }

  // ── chats ────────────────────────────────────────────────────────────────
  private async createChat(): Promise<StoredChat> {
    const now = new Date().toISOString()
    const chat: StoredChat = { id: id("chat"), createdAt: now, updatedAt: now, messages: [] }
    // Hard cap: evict the oldest chat.
    while (this.chats.size >= MAX_CHATS) {
      const oldest = [...this.chats.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0]!
      this.chats.delete(oldest.id)
      await this.storage.remove(oldest.id)
      this.emit({ type: "sessionDeleted", sessionID: oldest.id })
    }
    this.chats.set(chat.id, chat)
    await this.storage.save(chat)
    this.emit({ type: "sessionCreated", session: toSession(chat) })
    return chat
  }

  // ── turns ────────────────────────────────────────────────────────────────
  private fail(sid: string, error: string): void {
    this.emit({ type: "sendMessageFailed", sessionID: sid, error })
    this.emit({ type: "sessionTurnClosed", sessionID: sid, reason: "error" })
  }

  /** Close a sub-agent transcript: final answer text, closed tool rows, persisted with the chat. */
  private finishSub(chat: StoredChat, run: SubRun, isError: boolean, output: string): void {
    if (run.done) return
    run.done = true
    const parts: WirePart[] = run.parts.map((p) =>
      p.type === "tool" && (p as ToolPart).state.status === "running"
        ? ({ ...p, state: { status: "error", input: (p as ToolPart).state.input, error: "Stopped" } } as ToolPart)
        : p,
    )
    if (output.trim() && !isError) {
      // Stored whole: the server already bounds the findings (rag_context_budget),
      // and a client-side slice silently cut long reports off mid-sentence.
      const part: WirePart = { id: id("text"), type: "text", messageID: run.assistantId, text: output }
      parts.push(part)
      this.emit({ type: "partUpdated", sessionID: run.taskId, messageID: run.assistantId, part, delta: { type: "text-delta", textDelta: output } })
    }
    const message: WireMessage = {
      id: run.assistantId,
      sessionID: run.taskId,
      role: "assistant",
      createdAt: new Date().toISOString(),
      time: { created: run.startedAt, completed: Date.now() },
      parts,
      finish: isError ? "error" : "end_turn",
    }
    this.emit({ type: "messageCreated", message })
    this.emit({ type: "subagentEnded", sessionID: run.taskId, isError, output: output.slice(0, 200) })
    const list = (chat.subagents ??= [])
    const entry: StoredSubagent = {
      taskId: run.taskId,
      callId: run.callId,
      title: run.title,
      subagentType: run.subagentType,
      messages: [run.userMsg, message],
    }
    const at = list.findIndex((x) => x.taskId === run.taskId)
    if (at >= 0) list[at] = entry
    else list.push(entry)
  }

  private async runUserTurn(sid: string, text: string, messageID: string): Promise<void> {
    const chat = this.chats.get(sid)
    if (!chat) return
    if (this.turns.has(sid)) return
    const L = this.limits
    const trimmed = text.replace(/^\s+/, "")

    // Client-side checks (the server enforces the same limits independently).
    if (!trimmed.trim()) return this.fail(sid, "Please enter a message.")
    if (trimmed.length > L.message_chars) {
      return this.fail(sid, `That message is too long (${trimmed.length} characters). The limit is ${L.message_chars}.`)
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return this.fail(sid, "You appear to be offline. Check your connection and try again.")
    }

    const now = new Date().toISOString()
    const userMsg: WireMessage = {
      id: messageID,
      sessionID: sid,
      role: "user",
      createdAt: now,
      parts: [{ id: id("part"), type: "text", messageID, text: trimmed }],
    }
    chat.messages.push(userMsg)
    if (!chat.title) {
      chat.title = trimmed.replace(/\s+/g, " ").slice(0, 48)
      this.emit({ type: "sessionUpdated", session: { id: sid, title: chat.title, updatedAt: now } })
    }
    // Register the turn before anything is awaited: a Stop that arrives while the prompt is being
    // saved must find it, or the reply would run on as if the user had not pressed it. (An
    // already-stopped turn then ends through the normal "interrupted" path below.)
    const turn: Turn = { controller: new AbortController(), userAborted: false, timedOut: false }
    this.turns.set(sid, turn)
    try {
      // Persist the prompt before the (slow) reply starts: a reload mid-turn must
      // not lose what the user typed.
      await this.storage.save(chat)
    } catch (e) {
      this.turns.delete(sid)
      throw e
    }

    const assistantId = id("msg")
    const created = Date.now()
    const parts: WirePart[] = []
    const citations: Citation[] = []
    let textPartId: string | null = null
    // Newest text part, kept across tool calls so a later `answer_reset` can still
    // retract it (a draft followed by verification tool calls, then a revision).
    let lastTextPartId: string | null = null
    let textLen = 0
    let ctxUsed = 0
    let convChars = 0
    let ctxBreakdown: WireTokenUsage["breakdown"] | undefined
    let streamError: string | null = null
    const subs = new Map<string, SubRun>()

    this.emit({ type: "sessionStatus", sessionID: sid, status: "busy" })
    this.emit({
      type: "messageCreated",
      message: { id: assistantId, sessionID: sid, role: "assistant", createdAt: now, time: { created } },
    })

    const pushPart = (part: WirePart, delta?: { type: string; textDelta: string }) => {
      this.emit({ type: "partUpdated", sessionID: sid, messageID: assistantId, part, ...(delta ? { delta } : {}) })
    }
    const toolPart = (callID: string, tool: string, state: ToolPart["state"], metadata?: Record<string, unknown>): ToolPart => ({
      id: `tool-${callID}`,
      type: "tool",
      messageID: assistantId,
      tool,
      callID,
      state,
      ...(metadata ? { metadata } : {}),
    })
    let planningOn = false
    const setPlanning = (on: boolean) => {
      if (planningOn === on) return
      planningOn = on
      this.emit({ type: "sessionPlanning", sessionID: sid, active: on })
    }
    let est = { system: 0, tools: 0, summary: 0, subagent: 0 }
    const upsert = (part: WirePart) => {
      const i = parts.findIndex((p) => p.id === part.id)
      if (i >= 0) parts[i] = part
      else parts.push(part)
    }

    const handle = (ev: Msg) => {
      switch (ev.type) {
        case "phase":
          setPlanning(true)
          return
        case "breakdown":
          est = {
            system: Number(ev.system) || 0,
            tools: Number(ev.tools) || 0,
            summary: Number(ev.summary) || 0,
            subagent: Number(ev.subagent) || 0,
          }
          return
        case "answer_reset": {
          // The text streamed so far is being replaced (a corrected answer) or was
          // narration before a tool call: retract that part.
          if (!lastTextPartId) return
          const gone = lastTextPartId
          const at = parts.findIndex((p) => p.id === gone)
          if (at >= 0) {
            textLen -= ((parts[at] as { text?: string }).text ?? "").length
            parts.splice(at, 1)
          }
          this.emit({ type: "partRemoved", sessionID: sid, messageID: assistantId, partID: gone })
          lastTextPartId = null
          if (textPartId === gone) textPartId = null
          return
        }
        case "token": {
          const chunk = String(ev.content ?? "")
          if (!chunk) return
          setPlanning(false)
          if (!textPartId) textPartId = id("text")
          lastTextPartId = textPartId
          textLen += chunk.length
          const existing = parts.find((p) => p.id === textPartId) as { text: string } | undefined
          if (existing) existing.text += chunk
          else parts.push({ id: textPartId, type: "text", messageID: assistantId, text: chunk })
          pushPart({ id: textPartId, type: "text", messageID: assistantId, text: chunk }, { type: "text-delta", textDelta: chunk })
          return
        }
        case "tool_call": {
          setPlanning(false)
          textPartId = null // later text starts a new part, preserving order
          const callID = String(ev.id ?? id("call"))
          const name = String(ev.name ?? "search")
          const input = (ev.arguments && typeof ev.arguments === "object" ? ev.arguments : {}) as Record<string, unknown>
          const isSub = SUBAGENT_TOOLS.has(name)
          const p = isSub
            ? toolPart(
                callID,
                "task",
                {
                  status: "running",
                  input: { description: subagentLabel(name), subagentType: subagentKind(name), prompt: String(input.prompt ?? "") },
                  title: subagentLabel(name),
                },
                { startedAt: Date.now(), realTool: name },
              )
            : toolPart(callID, name, { status: "running", input, title: toolTitle(name, input) }, { startedAt: Date.now() })
          upsert(p)
          pushPart(p)
          return
        }
        case "tool_progress": {
          const name = String(ev.name ?? "")
          const running = [...parts].reverse().find((p) => p.type === "tool" && realName(p as ToolPart) === name && (p as ToolPart).state.status === "running") as ToolPart | undefined
          if (running && running.state.status === "running") {
            const next = toolPart(
              running.callID ?? "",
              running.tool,
              { ...running.state, ...(running.tool === "task" ? {} : { title: `${toolTitle(name, running.state.input)} (${String(ev.searches ?? 0)})` }) },
              { ...(running.metadata ?? {}), phase: String(ev.phase ?? ""), searches: Number(ev.searches) || 0 },
            )
            upsert(next)
            pushPart(next)
          }
          return
        }
        case "queue":
        case "db_slow": {
          // A research task's search is waiting for the reranker, or the database missed its
          // deadline: say so on its row.
          const taskId = String(ev.task_id ?? "")
          const row = parts.find((p) => p.type === "tool" && (p as ToolPart).callID === taskId && (p as ToolPart).state.status === "running") as ToolPart | undefined
          if (!row || row.state.status !== "running") return
          const label = String(row.state.input.description ?? subagentLabel(realName(row)))
          const next = toolPart(
            row.callID ?? "",
            row.tool,
            {
              ...row.state,
              title:
                ev.type === "db_slow"
                  ? dbSlowTitle(label, Number(ev.timeout_s) || 0)
                  : queueTitle(label, Number(ev.waiting) || 0, Number(ev.eta_s) || 0),
            },
            row.metadata,
          )
          upsert(next)
          pushPart(next)
          return
        }
        case "tool_result": {
          const name = String(ev.name ?? "")
          const evId = typeof ev.id === "string" ? ev.id : ""
          // Pair by call id (parallel calls of one tool finish in any order); fall back to name.
          const isRunning = (p: WirePart) => p.type === "tool" && (p as ToolPart).state.status === "running"
          const running = ((evId && (parts.find((p) => isRunning(p) && (p as ToolPart).callID === evId) as ToolPart | undefined)) ||
            [...parts].reverse().find((p) => isRunning(p) && realName(p as ToolPart) === name)) as ToolPart | undefined
          if (!running) return
          const raw = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result ?? "")
          const failed = raw.startsWith("[ERROR]")
          const taskId = subs.get(running.callID ?? "")?.taskId
          const done = toolPart(
            running.callID ?? "",
            running.tool,
            failed
              ? { status: "error", input: running.state.input, error: raw.replace(/^\[ERROR\]\s*/, "") }
              : {
                  status: "completed",
                  input: running.state.input,
                  output: clipToolOutput(raw, running.tool),
                  title: running.tool === "task" ? String(running.state.input.description ?? "") : toolTitle(name, running.state.input),
                  ...(taskId ? { metadata: { taskId } } : {}),
                },
            running.metadata,
          )
          upsert(done)
          pushPart(done)
          return
        }
        case "subagent_start": {
          const callId = String(ev.task_id ?? "")
          if (!callId || subs.has(callId)) return
          const taskId = `task-${assistantId}-${callId}`
          const startedAt = Date.now()
          const prompt = String(ev.prompt ?? "")
          const run: SubRun = {
            taskId,
            callId,
            title: String(ev.description ?? "Research"),
            subagentType: String(ev.subagent_type ?? ""),
            startedAt,
            userMsg: { id: id("msg"), sessionID: taskId, role: "user", createdAt: new Date().toISOString(), parts: [{ id: id("part"), type: "text", messageID: "", text: prompt }] },
            assistantId: id("msg"),
            parts: [],
          }
          subs.set(callId, run)
          this.emit({ type: "messageCreated", message: run.userMsg })
          this.emit({
            type: "messageCreated",
            message: { id: run.assistantId, sessionID: taskId, role: "assistant", createdAt: new Date().toISOString(), time: { created: startedAt } },
          })
          this.emit({ type: "subagentStarted", outerSessionID: sid, callId, taskId, title: run.title, subagentType: run.subagentType })
          return
        }
        case "subagent_tool_call": {
          const run = subs.get(String(ev.task_id ?? ""))
          if (!run) return
          const name = String(ev.name ?? "search")
          const input = (ev.arguments && typeof ev.arguments === "object" ? ev.arguments : {}) as Record<string, unknown>
          const part: ToolPart = {
            id: `tool-${String(ev.id)}`,
            type: "tool",
            messageID: run.assistantId,
            tool: name,
            callID: String(ev.id),
            state: { status: "running", input, title: toolTitle(name, input) },
            metadata: { startedAt: Date.now() },
          }
          run.parts.push(part)
          this.emit({ type: "partUpdated", sessionID: run.taskId, messageID: run.assistantId, part })
          return
        }
        case "subagent_tool_result": {
          const run = subs.get(String(ev.task_id ?? ""))
          const i = run ? run.parts.findIndex((p) => p.type === "tool" && (p as ToolPart).callID === String(ev.id)) : -1
          if (!run || i < 0) return
          const prev = run.parts[i] as ToolPart
          const raw = String(ev.result ?? "")
          const part: ToolPart = {
            ...prev,
            state: ev.is_error
              ? { status: "error", input: prev.state.input, error: raw.replace(/^\[ERROR\]\s*/, "") }
              : { status: "completed", input: prev.state.input, output: clipToolOutput(raw, prev.tool), title: toolTitle(prev.tool, prev.state.input) },
          }
          run.parts[i] = part
          this.emit({ type: "partUpdated", sessionID: run.taskId, messageID: run.assistantId, part })
          return
        }
        case "subagent_end": {
          const run = subs.get(String(ev.task_id ?? ""))
          if (run) this.finishSub(chat, run, Boolean(ev.is_error), String(ev.output ?? ""))
          return
        }
        case "legislation_citations": {
          for (const c of sanitizeCitations(ev.citations)) {
            if (!citations.some((x) => x.url === c.url)) citations.push(c)
          }
          return
        }
        case "context_usage": {
          ctxUsed = Number(ev.used ?? 0)
          // Keep the breakdown so it can be persisted on the final message and
          // re-read after a reload (the live contextRingUpdate is ephemeral).
          // The math (total prompt, not miss-only; conversation clamped at 0)
          // lives in lib/context-breakdown.ts and is unit-tested there.
          ctxBreakdown = computeContextBreakdown({
            est,
            used: ctxUsed,
            max: typeof ev.max === "number" ? ev.max : undefined,
            transcriptChars: convChars + textLen,
            fallbackBudget: L.context_tokens,
          })
          this.emit({ type: "contextRingUpdate", sessionID: sid, breakdown: ctxBreakdown })
          return
        }
        case "notice":
          this.emit({ type: "contextCompressed", sessionID: sid, method: "trim", message: String(ev.message ?? "") })
          return
        case "error":
          streamError = String(ev.error ?? "The assistant ran into a problem.")
          return
        case "questionRequest": {
          const requestId = String(ev.requestId ?? "")
          const questions = Array.isArray(ev.questions) ? ev.questions : []
          if (!requestId || questions.length === 0) return
          this.pendingQuestion = { sessionID: sid, requestId, questions }
          this.emit({
            type: "questionRequest",
            sessionID: sid,
            requestId,
            questions,
            ...(typeof ev.title === "string" ? { title: ev.title } : {}),
          })
          return
        }
        default:
          return // heartbeat, done
      }
    }

    // Safety net: never let a turn outlive the server's own wall clock by much.
    const hardStop = setTimeout(() => {
      turn.timedOut = true
      turn.controller.abort()
    }, (L.request_timeout_s + 20) * 1000)

    try {
      const base = chat.compaction ? chat.messages.findIndex((x) => x.id === chat.compaction!.afterId) : -1
      const sendable = base >= 0 ? chat.messages.slice(base) : chat.messages
      const items = buildHistoryItems(sendable, L, chat.compaction && base >= 0 ? chat.compaction.summary.length : 0)
      const history = items.map(({ role, content }) => ({ role, content }))
      convChars = history.reduce((a, m) => a + m.content.length, 0)
      const byok = this.getByok()
      if (byok) {
        // Bring your own key: the loop runs here and emits the same events `/api/chat` streams.
        // Failures arrive as `error` events, so `handle` records them like any other turn.
        await runAgentTurn({
          provider: PROVIDERS[byok.provider],
          apiKey: byok.key,
          mode: MODE,
          history: history as HistoryItem[],
          summary: chat.compaction && base >= 0 ? chat.compaction.summary : null,
          signal: turn.controller.signal,
          emit: (e) => handle(e as Msg),
          server: createServerTools({ baseUrl: this.baseUrl, fetchImpl: this.fetchImpl }),
          fetchImpl: this.fetchImpl,
          tavilyKey: this.getTavily(),
        })
      } else {
        const connectTimer = setTimeout(() => {
          turn.timedOut = true
          turn.controller.abort()
        }, CONNECT_MS)
        let resp: Response
        try {
          resp = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: history,
              mode: MODE,
              ...(chat.compaction && base >= 0 ? { summary: chat.compaction.summary } : {}),
            }),
            signal: turn.controller.signal,
            cache: "no-store",
          })
        } finally {
          clearTimeout(connectTimer)
        }
        if (!resp.ok || !resp.body) {
          streamError = await errorMessage(resp)
        } else {
          await readSse(resp.body, (e) => handle(e as Msg), IDLE_MS, turn.controller.signal)
        }
      }
    } catch (e) {
      if (turn.userAborted) {
        // A user-initiated stop is not a failure: drop any error event that
        // raced the abort instead of surfacing a banner for it.
        streamError = null
      } else if (e instanceof SessionError) {
        // The human verification could not be completed: say so instead of "couldn't reach the server".
        streamError = e.message
      } else if (turn.timedOut || e instanceof StreamIdleError) {
        streamError = "The connection stalled and the reply was stopped. Please try again."
      } else if (typeof navigator !== "undefined" && navigator.onLine === false) {
        streamError = "You went offline. Check your connection and try again."
      } else {
        streamError = "Couldn't reach the server. Please try again in a moment."
      }
    } finally {
      clearTimeout(hardStop)
      this.turns.delete(sid)
    }

    // The session may have been deleted while the turn was in flight. Bail out
    // before persisting, or the finished transcript would resurrect it.
    if (!this.chats.has(sid)) {
      if (this.queuedQuestion?.sessionID === sid) this.queuedQuestion = null
      return
    }

    // Link cited sections inline ([SSO](url)) in the answer text. Citations that
    // the answer does not mention are not listed anywhere. A stopped or failed turn
    // keeps its partial answer, so it is linked too (minus a reference cut off at the end).
    if (citations.length > 0) {
      const cutShort = turn.userAborted || !!streamError
      // Only the last text part can have been cut mid-reference.
      let lastText = -1
      for (let i = 0; i < parts.length; i++) if (parts[i]!.type === "text") lastText = i
      for (let i = 0; i < parts.length; i++) {
        const tp = parts[i]!
        if (tp.type !== "text") continue
        const text = (tp as { text: string }).text
        const linked = enrichWithCitations(text, citations, { partial: cutShort && i === lastText })
        if (linked !== text) {
          const next = { ...tp, text: linked } as WirePart
          parts[i] = next
          pushPart(next) // full replacement, no delta
        }
      }
    }
    // A sub-agent cut short by a stop/error still gets a closed transcript.
    for (const run of subs.values()) if (!run.done) this.finishSub(chat, run, true, "Stopped")
    // Close any tool still marked running.
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!
      if (p.type === "tool" && (p as ToolPart).state.status === "running") {
        const tp = p as ToolPart
        parts[i] = toolPart(tp.callID ?? "", tp.tool, { status: "error", input: tp.state.input, error: "Stopped" })
        pushPart(parts[i]!)
      }
    }

    const hasContent = parts.some((p) => p.type === "text" && (p as { text: string }).text.trim())
    if (hasContent || parts.length > 0) {
      const finalMsg: WireMessage = {
        id: assistantId,
        sessionID: sid,
        role: "assistant",
        createdAt: now,
        time: { created, completed: Date.now() },
        parts,
        finish: turn.userAborted ? "aborted" : streamError ? "error" : "stop",
        tokens: { input: ctxUsed, output: Math.ceil(textLen / 4), ...(ctxBreakdown ? { breakdown: ctxBreakdown } : {}) },
      }
      chat.messages.push(finalMsg)
      this.emit({ type: "messageCreated", message: finalMsg })
    }
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT)
    if (chat.compaction && !chat.messages.some((x) => x.id === chat.compaction!.afterId)) delete chat.compaction
    if (chat.subagents) chat.subagents = liveSubagents(chat)
    chat.updatedAt = new Date().toISOString()
    await this.storage.save(chat)

    if (streamError && !turn.userAborted) {
      this.fail(sid, streamError)
    } else {
      this.emit({ type: "sessionTurnClosed", sessionID: sid, reason: turn.userAborted ? "interrupted" : "completed" })
    }
    await this.drainQueuedQuestion(sid)
  }

  /**
   * `/compact`: summarise the older part of a chat now (see `agent/compact.ts` for which model writes
   * it: the server's on the shared key, the provider's own on a user's key). It adds nothing to the
   * transcript. The result is a notice, the "Summarised conversation" divider and a smaller context
   * ring; the summary is stored with the chat and replaces the older messages when the next question is sent.
   *
   * The UI marks the chat busy before posting this, so every path below must end the busy state.
   */
  private async compactChat(sid: string): Promise<void> {
    const done = () => this.emit({ type: "sessionTurnClosed", sessionID: sid, reason: "completed" })
    const say = (message: string) => this.emit({ type: "contextCompressed", sessionID: sid, method: "notice", message })

    const chat = this.chats.get(sid)
    if (!chat) return done()
    if (this.turns.has(sid)) return // a reply is streaming: its own busy state is still in force

    // The shared key has no key of its own to spend: the server's model writes the summary.
    const byok = this.getByok()
    const target = byok ? compactTarget(PROVIDERS[byok.provider]) : null
    const writer = target?.label ?? "The model"

    // Registered before anything is awaited, so a Stop that arrives while the prompt bundle loads is seen.
    const turn: Turn = { controller: new AbortController(), userAborted: false, timedOut: false }
    this.turns.set(sid, turn)
    this.emit({ type: "sessionStatus", sessionID: sid, status: "busy" })
    const hardStop = setTimeout(() => {
      turn.timedOut = true
      turn.controller.abort()
    }, 120_000)

    let failure: string | null = null
    try {
      const L = this.limits
      const base = chat.compaction ? chat.messages.findIndex((x) => x.id === chat.compaction!.afterId) : -1
      const prior = chat.compaction && base >= 0 ? chat.compaction.summary : null
      const items = buildHistoryItems(base >= 0 ? chat.messages.slice(base) : chat.messages, L, prior ? prior.length : 0)
      const history = items.map(({ role, content }) => ({ role, content })) as HistoryItem[]

      // Same prompt bundle a normal turn uses: the summary prompts, and the sizes for the context ring.
      const server = createServerTools({ baseUrl: this.baseUrl, fetchImpl: this.fetchImpl })
      const bundle = await server.agent(MODE, turn.controller.signal)
      const sized = (summary: string | null, h: HistoryItem[]) =>
        estimateTokens(buildApiMessages({ systemPrompt: bundle.system_prompt, actsContext: bundle.acts_context, summary, history: h }))

      const r = await compactHistory({
        provider: byok ? PROVIDERS[byok.provider] : null,
        apiKey: byok?.key ?? "",
        history,
        summary: prior,
        texts: bundle.texts,
        server,
        signal: turn.controller.signal,
        fetchImpl: this.fetchImpl,
      })

      if (!r) {
        say("There isn't enough conversation to summarise yet. The latest messages are always kept as they are.")
      } else if (this.chats.get(sid) !== chat) {
        // The chat was deleted while the summary was being written: nothing to attach it to.
      } else if (sized(r.summary, history.slice(history.length - r.kept)) >= sized(prior, history)) {
        // A short chat can summarise to more than it replaces; storing that would make the context bigger.
        say("Summarising wouldn't make this conversation any shorter yet, so nothing was changed.")
      } else {
        const boundary = items[items.length - r.kept]?.id
        if (!boundary) throw new Error("no compaction boundary")
        const kept = history.slice(history.length - r.kept)
        const before = sized(prior, history)
        const after = sized(r.summary, kept)
        chat.compaction = { summary: r.summary, afterId: boundary }
        chat.updatedAt = new Date().toISOString()
        await this.storage.save(chat)

        const [system, subagent] = splitSystemPromptTokens(bundle.system_prompt, bundle.texts.subagent_definitions)
        this.emit({
          type: "contextRingUpdate",
          sessionID: sid,
          breakdown: computeContextBreakdown({
            est: { system, tools: estimateToolsTokens(bundle.tools), summary: displayTokens(r.summary), subagent },
            used: after,
            max: bundle.params.model_window,
            transcriptChars: kept.reduce((n, x) => n + x.content.length, 0),
            fallbackBudget: L.context_tokens,
          }),
        })
        const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
        this.emit({
          type: "contextCompressed",
          sessionID: sid,
          method: "llm-summary",
          message: `Summarised the earlier ${r.summarised} messages${target?.label ? ` with ${target.label}` : ""}; the latest ${r.kept} are kept as they are. Context: about ${k(before)} → ${k(after)} tokens.`,
        })
      }
    } catch (e) {
      if (turn.userAborted) say("Compaction stopped. Nothing was changed.")
      else if (turn.timedOut) failure = "Summarising took too long, so it was stopped. Please try again."
      else if (e instanceof LlmError || e instanceof ServerToolError) failure = e.message
      else if (e instanceof Error && e.message === "empty summary") failure = `${writer} returned an empty summary. Please try again.`
      else failure = "The conversation could not be summarised. Please try again."
    } finally {
      clearTimeout(hardStop)
      this.turns.delete(sid)
    }

    if (failure) this.fail(sid, failure)
    else done()
  }

  /** Start an answer that arrived while the asking turn was still streaming. */
  private async drainQueuedQuestion(sid: string): Promise<void> {
    const q = this.queuedQuestion
    if (!q || q.sessionID !== sid) return
    this.queuedQuestion = null
    await this.runUserTurn(sid, q.text, id("msg"))
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

interface SubRun {
  taskId: string
  callId: string
  title: string
  subagentType: string
  startedAt: number
  userMsg: WireMessage
  assistantId: string
  parts: WirePart[]
  done?: boolean
}

function subagentLabel(tool: string): string {
  switch (tool) {
    case "research_legislation":
      return "Legislation research"
    case "research_subsidiary_legislation":
      return "Subsidiary legislation research"
    case "legislation_agent":
      return "Legislation agent"
    case "judiciary_agent":
      return "Judiciary agent"
    case "research_judiciary":
      return "Judiciary research"
    default:
      return "Research"
  }
}

/** Row title while searches wait for the reranker; the plain label once the queue clears. */
export function queueTitle(label: string, waiting: number, etaS: number): string {
  if (waiting <= 0) return label
  return `${label} — busy, ${waiting} search${waiting === 1 ? "" : "es"} waiting (~${Math.max(1, etaS)}s)`
}

/** Row title after a search hit the database deadline; the plain label once one goes through. */
export function dbSlowTitle(label: string, timeoutS: number): string {
  if (timeoutS <= 0) return label
  return `${label} — database busy, no answer within ${timeoutS}s; retrying`
}

function subagentKind(tool: string): string {
  return tool === "research_subsidiary_legislation" ? "subsidiary-legislation" : tool === "judiciary_agent" || tool === "research_judiciary" ? "judiciary" : "legislation"
}

/** The tool a part stands for (task rows remember the research tool that spawned them). */
function realName(p: ToolPart): string {
  const r = p.metadata?.realTool
  return typeof r === "string" ? r : p.tool
}

/** Sub-agent transcripts whose launching task row still exists in the chat. */
function liveSubagents(c: StoredChat | undefined): StoredSubagent[] {
  if (!c?.subagents?.length) return []
  const calls = new Set<string>()
  for (const m of c.messages) for (const p of m.parts ?? []) if (p.type === "tool" && (p as ToolPart).callID) calls.add((p as ToolPart).callID!)
  return c.subagents.filter((s) => calls.has(s.callId))
}

function toSession(c: StoredChat): WireSession {
  return { id: c.id, title: c.title ?? "", createdAt: c.createdAt, updatedAt: c.updatedAt }
}

function messageText(m: WireMessage): string {
  return (m.parts ?? [])
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("")
}

/**
 * Build the request history: drop failed/empty turns, then keep only as much
 * recent history as the server will accept (message count and body size).
 */
export function buildHistory(messages: WireMessage[], L: ServerLimits): Array<{ role: string; content: string }> {
  return buildHistoryItems(messages, L, 0).map(({ role, content }) => ({ role, content }))
}

/** Like buildHistory but keeps each item's source message id (used to place compaction boundaries). */
export function buildHistoryItems(
  messages: WireMessage[],
  L: ServerLimits,
  reservedBytes = 0,
): Array<{ role: string; content: string; id: string }> {
  const out: Array<{ role: string; content: string; id: string }> = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    const text = messageText(m).trim()
    if (!text) continue
    if (m.role === "user") {
      // A user message with no answer before the next user message, or answered by an error, was a failed turn.
      const next = messages[i + 1]
      if (next && (next.role === "user" || (next.role === "assistant" && next.finish === "error"))) continue
      out.push({ role: "user", content: text.slice(0, L.message_chars), id: m.id })
    } else if (m.finish !== "error") {
      out.push({ role: "assistant", content: text.slice(0, ASSISTANT_CHARS), id: m.id })
    }
  }
  const budget = L.body_bytes * 0.8 - reservedBytes
  while (out.length > Math.max(1, L.max_messages - 1) || (out.length > 1 && JSON.stringify(out).length > budget)) {
    out.shift()
  }
  while (out.length > 1 && out[0]!.role !== "user") out.shift()
  return out
}

async function errorMessage(resp: Response): Promise<string> {
  let msg = ""
  try {
    const j = (await resp.json()) as { error?: { message?: string } }
    msg = j?.error?.message ?? ""
  } catch {
    /* non-JSON body */
  }
  if (msg) return msg
  if (resp.status === 429) return "You're sending messages too quickly. Please wait a moment."
  if (resp.status === 413) return "That message is too large to send. Please shorten it."
  if (resp.status >= 500) return "The service is having trouble right now. Please try again shortly."
  return "The message could not be sent."
}

const TOOL_LABEL: Record<string, string> = {
  search_legislation: "Searched legislation",
  search_judiciary: "Searched judgments",
  research_legislation: "Researched Acts",
  research_sl: "Researched subsidiary legislation",
  get_section: "Looked up a section",
  web_search_tavily: "Searched the web (Tavily)",
  web_search_deepseek: "Searched the web (DeepSeek)",
  classify_issue: "Classified the issue",
  legislation_agent: "Researching legislation",
  judiciary_agent: "Researching judgments",
}

export function toolTitle(name: string, input: Record<string, unknown>): string {
  const q = (input.query ?? input.summary ?? input.act_name ?? "") as string
  const base = TOOL_LABEL[name] ?? `Used ${name}`
  return q ? `${base}: ${String(q).slice(0, 80)}` : base
}

function fileName(c: StoredChat): string {
  const slug = (c.title || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "chat"
  return `lawbylaw-${slug}.md`
}

function toMarkdown(c: StoredChat): string {
  const lines = [`# ${c.title || "Chat"}`, "", `_Exported ${new Date().toISOString()}. General information only, not legal advice._`, ""]
  for (const m of c.messages) {
    const t = messageText(m).trim()
    if (t) lines.push(`## ${m.role === "user" ? "You" : "Assistant"}`, "", t, "")
  }
  return lines.join("\n")
}

// ── install ────────────────────────────────────────────────────────────────

export function installWebHost(opts: HostOptions = {}): WebHost {
  const emit = (m: Msg) => window.postMessage(m, window.location.origin)
  const host = new WebHost(emit, { getByok: loadByok, getTavily: loadTavily, ...opts })
  connectHost((m) => void host.handle(m as Msg).catch((e) => console.error("[host]", e)))
  return host
}
