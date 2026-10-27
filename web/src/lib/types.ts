/**
 * types.ts — the message, part and session shapes passed between the chat UI
 * and the in-page host (`host/web-host.ts`).
 */

// ── Sessions ────────────────────────────────────────────────────────────────

export interface WireSession {
  id: string
  title?: string
  createdAt: string
  updatedAt: string
  /** UI-only: a synthetic session standing in for a subagent transcript. */
  synthetic?: boolean
  /** UI-only: the session that launched the subagent (for chip return). */
  parentSessionID?: string
  /** UI-only: the subagent type label shown on the chip. */
  subagentType?: string
}

// ── Message parts (as the host constructs/serialises them) ──────────────────

export type WireToolState =
  | { status: "pending"; input: Record<string, unknown> }
  | { status: "running"; input: Record<string, unknown>; title?: string }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title?: string
      metadata?: Record<string, unknown>
    }
  | { status: "error"; input: Record<string, unknown>; error: string }

export interface ToolPart {
  id: string
  type: "tool"
  messageID?: string
  tool: string
  callID?: string
  state: WireToolState
  metadata?: Record<string, unknown>
}

export interface TextPart {
  id: string
  type: "text"
  messageID?: string
  text: string
}

export interface ReasoningPart {
  id: string
  type: "reasoning"
  messageID?: string
  text: string
}

/** Fallback so a part type we have never seen still renders without crashing. */
export interface UnknownPart {
  id: string
  type: string
  messageID?: string
  [key: string]: unknown
}

export type WirePart = TextPart | ReasoningPart | ToolPart | UnknownPart

// ── Messages / usage ────────────────────────────────────────────────────────

export interface WireTokenUsage {
  input: number
  output: number
  reasoning?: number
  breakdown?: {
    systemPrompt: number
    toolDefinitions: number
    subagentDefinitions: number
    summarisedConversation: number
    conversation: number
    budget: number
  }
  cache?: { read: number; write: number }
}

export interface WireMessage {
  id: string
  sessionID: string
  role: "user" | "assistant"
  createdAt: string
  time?: { created: number; completed?: number }
  parts?: WirePart[]
  finish?: string
  tokens?: WireTokenUsage
}

export interface SessionUsageTotals {
  steps: number
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

export interface SessionUsageData {
  sessionIDs: string[]
  totals: SessionUsageTotals
  models: Array<{
    providerID: string
    modelID: string
    steps: number
    cost: number
    tokens: SessionUsageTotals["tokens"]
  }>
}

// ── Skills (the composer's "/" menu) ────────────────────────────────────────

export interface SlashItem {
  name: string
  description: string
  source: "skill"
}

// ── Questions (askquestion tool → questionReply) ────────────────────────────

export interface QuestionOption {
  id?: string
  label: string
}

export interface QuestionInfo {
  id: string
  prompt: string
  options: QuestionOption[]
  allow_multiple?: boolean
}

export interface QuestionRequestMsg {
  type: "questionRequest"
  /** The session whose turn asked; the dock is only shown inside that session. */
  sessionID?: string
  requestId: string
  questions: QuestionInfo[]
  title?: string
}

// ────────────────────────────────────────────────────────────────────────────

/** Parts type guard helpers. */
export function isToolPart(p: WirePart): p is ToolPart {
  return p.type === "tool" && (p as ToolPart).state !== undefined
}
