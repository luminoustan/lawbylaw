import { describe, expect, it } from "vitest"
import { isGroupable, summaryLine, toolCategory } from "./tool-display"

describe("web search tools", () => {
  it("are web tools, grouped with the other searches", () => {
    for (const t of ["web_search_tavily", "web_search_deepseek"]) {
      expect(toolCategory(t)).toBe("web")
      expect(isGroupable(toolCategory(t))).toBe(true)
    }
  })

  it("name the engine and the query in the one-line summary", () => {
    expect(summaryLine("web_search_tavily", { query: "MOM work pass fee" })).toBe("Searched web (Tavily) MOM work pass fee")
    expect(summaryLine("web_search_deepseek", { query: "CPF rates site:gov.sg" })).toBe("Searched web (DeepSeek) CPF rates site:gov.sg")
  })
})

describe("tool categories", () => {
  it("send legal tools to the legal card, sub-agent rows to the task card and forms to the answer card", () => {
    expect(toolCategory("search_legislation")).toBe("legal")
    expect(toolCategory("get_section")).toBe("legal")
    expect(toolCategory("judiciary_agent")).toBe("legal")
    expect(toolCategory("task")).toBe("task")
    expect(toolCategory("askquestion")).toBe("ask")
  })

  it("never groups legal tools and falls back to a plain row for unknown ones", () => {
    expect(isGroupable(toolCategory("search_legislation"))).toBe(false)
    expect(toolCategory("made_up_tool")).toBe("other")
    expect(summaryLine("made_up_tool", {})).toBe("made_up_tool")
  })
})
