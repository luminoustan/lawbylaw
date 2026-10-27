import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { KEY_ENTRY, saveByok } from "./key-store"
import { TAVILY_ENTRY, clearTavily, loadTavily, onTavilyChange, saveTavily, tavilySummary } from "./tavily-key"

const KEY = "tvly-canary-0123456789abcdef"

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  clearTavily()
})
afterEach(() => clearTavily())

describe("tavily key store", () => {
  it("keeps a remembered key on the device, under its own entry, apart from the model key", () => {
    saveByok("nebius", "sk-canary-store-0123456789abcd", "device")
    expect(saveTavily(` ${KEY} `, "device")).toEqual({ ok: true, keptIn: "device" })
    expect(loadTavily()).toBe(KEY)
    expect(localStorage.getItem(TAVILY_ENTRY)).toBe(KEY)
    expect(localStorage.getItem(KEY_ENTRY)).not.toContain(KEY)
  })

  it("keeps a session-only key out of persistent storage", () => {
    saveTavily(KEY, "session")
    expect(sessionStorage.getItem(TAVILY_ENTRY)).toBe(KEY)
    expect(localStorage.getItem(TAVILY_ENTRY)).toBeNull()
    expect(tavilySummary()?.remember).toBe("session")
  })

  it("shows at most the last four characters", () => {
    saveTavily(KEY, "device")
    const s = tavilySummary()!
    expect(s.hint).toBe(KEY.slice(-4))
    expect(JSON.stringify(s)).not.toContain(KEY)
    clearTavily()
    saveTavily("tvly-short", "device")
    expect(tavilySummary()!.hint).toBe("")
  })

  it("rejects bad input and keeps the earlier key", () => {
    saveTavily(KEY, "device")
    expect(saveTavily("   ", "device").ok).toBe(false)
    expect(saveTavily("has a space", "device").ok).toBe(false)
    expect(loadTavily()).toBe(KEY)
  })

  it("falls back to memory when storage is blocked", () => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error("blocked")
    }
    try {
      expect(saveTavily(KEY, "device")).toEqual({ ok: true, keptIn: "memory" })
      expect(loadTavily()).toBe(KEY)
    } finally {
      Storage.prototype.setItem = orig
    }
  })

  it("removes the key from every place and tells listeners", () => {
    let n = 0
    const stop = onTavilyChange(() => n++)
    saveTavily(KEY, "device")
    clearTavily()
    stop()
    saveTavily(KEY, "session")
    expect(n).toBe(2)
    clearTavily()
    expect(loadTavily()).toBeNull()
    expect(localStorage.getItem(TAVILY_ENTRY)).toBeNull()
    expect(sessionStorage.getItem(TAVILY_ENTRY)).toBeNull()
    expect(tavilySummary()).toBeNull()
  })
})
