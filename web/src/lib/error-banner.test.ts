import { describe, expect, it } from "vitest"
import { visibleErrorBanner } from "./error-banner"

/**
 * Guards the "A reply is already being generated" banner leaking across
 * sessions. The server allows one stream per client, so a send from session B
 * while session A is still generating is rejected — and that rejection must
 * stay with B instead of reappearing when the user navigates back to A.
 */
describe("visibleErrorBanner", () => {
  it("hides a banner raised by another session", () => {
    expect(visibleErrorBanner({ sessionID: "b", message: "busy" }, "a")).toBeNull()
  })

  it("shows a banner raised by the session being viewed", () => {
    const banner = { sessionID: "a", message: "busy" }
    expect(visibleErrorBanner(banner, "a")).toBe(banner)
  })

  it("shows a session-less banner everywhere", () => {
    const banner = { message: "storage unavailable" }
    expect(visibleErrorBanner(banner, "a")).toBe(banner)
    expect(visibleErrorBanner(banner, null)).toBe(banner)
  })

  it("hides a session banner when no session is selected", () => {
    expect(visibleErrorBanner({ sessionID: "a", message: "busy" }, null)).toBeNull()
  })

  it("returns null when there is no banner", () => {
    expect(visibleErrorBanner(null, "a")).toBeNull()
    expect(visibleErrorBanner(undefined, "a")).toBeNull()
  })
})
