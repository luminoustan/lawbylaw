import { beforeEach, describe, expect, it } from "vitest"
import { markWelcomeSeen, resetWelcomeForTests, welcomeSeen, WELCOME_ENTRY, WELCOME_POINTS } from "./welcome"

beforeEach(() => {
  localStorage.clear()
  resetWelcomeForTests()
})

describe("first-visit notice", () => {
  it("is unseen on a first visit and seen once dismissed, across reloads", () => {
    expect(welcomeSeen()).toBe(false)
    markWelcomeSeen()
    expect(welcomeSeen()).toBe(true)
    resetWelcomeForTests() // a reload forgets memory, not storage
    expect(welcomeSeen()).toBe(true)
    expect(localStorage.getItem(WELCOME_ENTRY)).not.toBeNull()
  })

  it("is shown again to someone who dismissed the old v1 notice", () => {
    localStorage.setItem("lawbylaw.welcome.v1", new Date().toISOString())
    expect(welcomeSeen()).toBe(false)
  })

  it("is shown again after the browser's data is cleared", () => {
    markWelcomeSeen()
    localStorage.clear()
    resetWelcomeForTests()
    expect(welcomeSeen()).toBe(false)
  })

  it("is shown once per page when storage is blocked", () => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error("blocked")
    }
    try {
      markWelcomeSeen()
      expect(welcomeSeen()).toBe(true)
    } finally {
      Storage.prototype.setItem = orig
    }
  })

  it("carries the six points, with the dates, the hackathon and the privacy warning", () => {
    expect(WELCOME_ENTRY).toBe("lawbylaw.welcome.v3")
    expect(WELCOME_POINTS).toHaveLength(6)
    const all = WELCOME_POINTS.join("\n")
    for (const needle of ["Nebius x NVIDIA Global AI Hackathon", "homelab", "Singapore", "Nvidia RTX 3060", "AGC", "Singapore Statutes Online (SSO)", "December 2 to December 16, 2026", "DeepSeek", "Nebius Token Factory", "retention and training terms", "sensitive personal information"]) {
      expect(all).toContain(needle)
    }
  })
})
