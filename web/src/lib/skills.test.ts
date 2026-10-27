import { describe, expect, it } from "vitest"
import { skillFor, SKILLS } from "./skills"

describe("skills", () => {
  it("offers /compact as a skill", () => {
    expect(SKILLS.map((s) => s.name)).toEqual(["compact"])
    expect(SKILLS.every((s) => s.source === "skill")).toBe(true)
  })

  it("recognises a skill by name, ignoring case and trailing text", () => {
    expect(skillFor("/compact")?.name).toBe("compact")
    expect(skillFor("/Compact ")?.name).toBe("compact")
    expect(skillFor("/compact the older messages please")?.name).toBe("compact")
  })

  it("leaves ordinary text and unknown commands alone", () => {
    expect(skillFor("compact my thoughts")).toBeUndefined()
    expect(skillFor("/unknown")).toBeUndefined()
    expect(skillFor("what does /compact do?")).toBeUndefined()
    expect(skillFor("")).toBeUndefined()
  })
})
