import { describe, expect, it } from "vitest"
import { clipToolOutput, SECTION_OUTPUT_CHARS, TOOL_OUTPUT_CHARS } from "./tool-output"

describe("clipToolOutput", () => {
  it("leaves short output untouched", () => {
    expect(clipToolOutput("short", "search_legislation")).toBe("short")
  })

  it("marks truncation past the default cap", () => {
    const raw = "a".repeat(TOOL_OUTPUT_CHARS + 500)
    const out = clipToolOutput(raw, "search_legislation")
    expect(out.startsWith("a".repeat(TOOL_OUTPUT_CHARS))).toBe(true)
    expect(out).toContain(`[truncated for display: showing the first ${TOOL_OUTPUT_CHARS} of ${raw.length} characters]`)
  })

  it("gives get_section a much larger cap, so a multi-part section is not cut at one chunk", () => {
    const raw = "b".repeat(TOOL_OUTPUT_CHARS * 5)
    expect(clipToolOutput(raw, "get_section")).toBe(raw)
    const huge = "c".repeat(SECTION_OUTPUT_CHARS + 1)
    expect(clipToolOutput(huge, "get_section")).toContain("[truncated for display:")
  })

  it("gives get_judgment the same large cap", () => {
    const raw = "d".repeat(TOOL_OUTPUT_CHARS * 5)
    expect(clipToolOutput(raw, "get_judgment")).toBe(raw)
  })
})
