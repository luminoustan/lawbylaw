/**
 * tool-display.ts — concise, human-readable presentation for tool cards.
 *
 * Pure/presentational helpers: they classify a tool call into a coarse
 * category (which card renders it, and whether consecutive calls fold into one
 * "Explored" row) and build the one-line summary shown for it. They also render
 * already-persisted chats identically.
 */

/**
 * Coarse category used to pick a card and to group consecutive tool calls in
 * the transcript (a run of web searches collapses into one summary row).
 */
export type ToolCategory = "web" | "task" | "ask" | "legal" | "other"

const LEGAL_TOOLS = new Set([
  "search_legislation",
  "search_judiciary",
  "research_legislation",
  "research_subsidiary_legislation",
  "research_judiciary",
  "research_sl",
  "get_section",
  "get_judgment",
  "classify_issue",
  "legislation_agent",
  "judiciary_agent",
])

export const isLegalTool = (tool: string): boolean => LEGAL_TOOLS.has(tool)

export function toolCategory(tool: string): ToolCategory {
  if (isLegalTool(tool)) return "legal"
  switch (tool) {
    case "web_search_tavily":
    case "web_search_deepseek":
      return "web"
    case "task":
      return "task"
    case "askquestion":
      return "ask"
    default:
      return "other"
  }
}

/** Categories folded into a single collapsible summary row. */
export function isGroupable(cat: ToolCategory): boolean {
  return cat === "web"
}

/** A short one-line label for a tool call, used inside grouped summaries and as the compact row text. */
export function summaryLine(tool: string, input: Record<string, unknown>): string {
  const query = typeof input.query === "string" ? input.query : ""
  switch (tool) {
    case "web_search_tavily":
      return `Searched web (Tavily) ${query}`.trim()
    case "web_search_deepseek":
      return `Searched web (DeepSeek) ${query}`.trim()
    case "task":
      return `Task: ${(input.description as string) ?? (input.subagentType as string) ?? "sub-agent"}`
    case "askquestion":
      return "Ask user"
    default:
      return isLegalTool(tool) ? tool.replace(/_/g, " ") : tool
  }
}

// ── Tool state helpers ───────────────────────────────────────────────────────

/** A tool state is "running" while it is pending or actively executing. */
export function isRunningToolStatus(status: string | undefined): boolean {
  return status === "running" || status === "pending"
}

/** Human label for a tool card's state. */
export function toolStatusLabel(status: string | undefined): string {
  if (status === "completed") return "Completed"
  if (status === "error") return "Failed"
  return "Running"
}
