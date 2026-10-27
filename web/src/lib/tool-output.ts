/** Display cap for a tool result card, in characters. */
export const TOOL_OUTPUT_CHARS = 4000

/**
 * `get_section` is already bounded by the server in Qwen3 tokens (at most
 * ~20,000 tokens of statute text per call, with a footer saying which parts it
 * holds), and the browser has no tokenizer to cut on tokens itself. So the card
 * shows it whole; this character limit is only a safety net far above what the
 * server can send and is not expected to trigger.
 */
export const SECTION_OUTPUT_CHARS = 400_000

export function toolOutputCap(tool: string): number {
  return tool === "get_section" || tool === "get_judgment" ? SECTION_OUTPUT_CHARS : TOOL_OUTPUT_CHARS
}

/**
 * Clip a tool result for display. Past the cap the card says so, so a long
 * result is never mistaken for the whole text (the model still receives the
 * full string; only the card is cut).
 */
export function clipToolOutput(raw: string, tool: string): string {
  const cap = toolOutputCap(tool)
  if (raw.length <= cap) return raw
  return `${raw.slice(0, cap)}\n\n… [truncated for display: showing the first ${cap} of ${raw.length} characters]`
}
