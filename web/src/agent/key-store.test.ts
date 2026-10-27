import "fake-indexeddb/auto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openStorage } from "../host/storage"
import { KEY_ENTRY, byokSummary, clearByok, keyStatus, loadByok, onKeyChange, saveByok } from "./key-store"

const KEY = "sk-canary-store-0123456789abcd"

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  clearByok()
})
afterEach(() => clearByok())

describe("key store", () => {
  it("keeps a remembered key on the device only, under its own entry", () => {
    expect(saveByok("nebius", `  ${KEY} `, "device")).toEqual({ ok: true, keptIn: "device" })
    expect(loadByok()).toEqual({ provider: "nebius", key: KEY })
    expect(localStorage.getItem(KEY_ENTRY)).toContain(KEY)
    expect(sessionStorage.getItem(KEY_ENTRY)).toBeNull()
  })

  it("keeps a session-only key out of persistent storage", () => {
    saveByok("deepseek", KEY, "session")
    expect(sessionStorage.getItem(KEY_ENTRY)).toContain(KEY)
    expect(localStorage.length).toBe(0)
    expect(byokSummary()?.remember).toBe("session")
  })

  it("replaces an earlier key everywhere when saved with a different choice", () => {
    saveByok("nebius", KEY, "device")
    saveByok("deepseek", "another-key-0123456789", "session")
    expect(localStorage.getItem(KEY_ENTRY)).toBeNull()
    expect(loadByok()).toEqual({ provider: "deepseek", key: "another-key-0123456789" })
  })

  it("never hands the full key to the settings screen after saving", () => {
    saveByok("nebius", KEY, "device")
    const summary = byokSummary()!
    expect(summary).toEqual({ provider: "nebius", hint: KEY.slice(-4), remember: "device" })
    expect(JSON.stringify(summary)).not.toContain(KEY)
  })

  it("shows no hint for a short key, since four characters would be much of it", () => {
    saveByok("nebius", "short-key-123", "device")
    expect(byokSummary()?.hint).toBe("")
  })

  it("refuses a key that is not safe to put in a header, and stores nothing", () => {
    for (const bad of ["", "has space", "line\nbreak", "é".repeat(20), "k".repeat(600)]) {
      expect(saveByok("nebius", bad, "device").ok).toBe(false)
    }
    expect(loadByok()).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it("refuses an unknown provider", () => {
    expect(saveByok("https://evil.test" as never, KEY, "device").ok).toBe(false)
  })

  it("ignores a tampered entry instead of using it", () => {
    localStorage.setItem(KEY_ENTRY, JSON.stringify({ provider: "https://evil.test", key: KEY }))
    expect(loadByok()).toBeNull()
    localStorage.setItem(KEY_ENTRY, JSON.stringify({ provider: "nebius", key: "bad key\r\nX: y" }))
    expect(loadByok()).toBeNull()
    localStorage.setItem(KEY_ENTRY, "{not json")
    expect(loadByok()).toBeNull()
  })

  it("removes the key from every place at once", () => {
    saveByok("nebius", KEY, "device")
    sessionStorage.setItem(KEY_ENTRY, localStorage.getItem(KEY_ENTRY)!)
    clearByok()
    expect(loadByok()).toBeNull()
    expect(localStorage.getItem(KEY_ENTRY)).toBeNull()
    expect(sessionStorage.getItem(KEY_ENTRY)).toBeNull()
    expect(byokSummary()).toBeNull()
  })

  it("holds the key in memory for the page when the browser blocks storage", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError")
      },
    })
    try {
      expect(saveByok("nebius", KEY, "device")).toEqual({ ok: true, keptIn: "memory" })
      expect(loadByok()).toEqual({ provider: "nebius", key: KEY })
      expect(byokSummary()?.remember).toBe("memory")
    } finally {
      Object.defineProperty(window, "localStorage", original)
    }
  })

  it("is never part of the chat database", async () => {
    saveByok("nebius", KEY, "device")
    const db = await openStorage()
    await db.save({
      id: "c1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      messages: [{ id: "m1" } as never],
    })
    expect(JSON.stringify(await db.loadAll())).not.toContain(KEY)
    await db.clear()
  })
})

describe("which key is in use", () => {
  it("says the shared free key is in use when nothing is saved", () => {
    const s = keyStatus(byokSummary())
    expect(s.own).toBe(false)
    expect(s.label).toBe("Free shared key")
    expect(s.detail).toMatch(/owner's shared key/)
  })

  it("says it is the visitor's own key, with the provider and where it is kept", () => {
    saveByok("nebius", KEY, "device")
    const s = keyStatus(byokSummary())
    expect(s).toMatchObject({ own: true, label: "Your own key · Nebius" })
    expect(s.detail).toContain("kept on this device")
    expect(s.detail).toContain(`ends ${KEY.slice(-4)}`)
    saveByok("deepseek", KEY, "session")
    expect(keyStatus(byokSummary())).toMatchObject({ own: true, label: "Your own key · DeepSeek" })
    expect(keyStatus(byokSummary()).detail).toContain("until you close this tab")
  })

  it("never puts the key itself on screen", () => {
    saveByok("nebius", KEY, "device")
    const s = keyStatus(byokSummary())
    expect(JSON.stringify(s)).not.toContain(KEY)
    expect(JSON.stringify(s)).not.toContain(KEY.slice(0, -4))
    saveByok("nebius", "short-key-123", "device")
    expect(keyStatus(byokSummary()).detail).not.toContain("ends")
  })

  it("agrees with what the host will do: a key is saved exactly when the badge says own", () => {
    for (const act of [() => saveByok("nebius", KEY, "device"), () => clearByok(), () => saveByok("deepseek", KEY, "session"), () => clearByok()]) {
      act()
      expect(keyStatus(byokSummary()).own).toBe(loadByok() !== null)
    }
  })
})

describe("hearing about key changes", () => {
  it("is told once per change, and never sees the key half-way through a replace", () => {
    const seen: Array<string | null> = []
    const stop = onKeyChange(() => seen.push(byokSummary()?.provider ?? null))
    saveByok("nebius", KEY, "device")
    saveByok("deepseek", KEY, "device") // replace: wipes then writes, but only the end state is announced
    clearByok()
    stop()
    saveByok("nebius", KEY, "device")
    expect(seen).toEqual(["nebius", "deepseek", null])
  })

  it("is told when another tab changes or clears the key", () => {
    let n = 0
    const stop = onKeyChange(() => n++)
    window.dispatchEvent(new StorageEvent("storage", { key: KEY_ENTRY }))
    window.dispatchEvent(new StorageEvent("storage", { key: null })) // localStorage.clear() elsewhere
    window.dispatchEvent(new StorageEvent("storage", { key: "something-else" }))
    stop()
    expect(n).toBe(2)
  })

  it("keeps going when one listener throws", () => {
    let ok = false
    const a = onKeyChange(() => {
      throw new Error("boom")
    })
    const b = onKeyChange(() => (ok = true))
    saveByok("nebius", KEY, "device")
    a()
    b()
    expect(ok).toBe(true)
  })
})
