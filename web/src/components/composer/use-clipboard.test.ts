import { describe, expect, it, vi } from "vitest"

import { useClipboard } from "./use-clipboard"
import type { EditorCore } from "./editor-core"

/** A paste event whose clipboard carries `items` (and optionally plain text). */
function paste(items: Array<{ type: string; file?: File }>, text = "") {
  const e = new Event("paste", { cancelable: true }) as unknown as ClipboardEvent
  Object.defineProperty(e, "clipboardData", {
    value: {
      items: items.map((i) => ({ type: i.type, getAsFile: () => i.file ?? null })),
      getData: (t: string) => (t === "text/plain" ? text : ""),
    },
  })
  return e
}

describe("composer paste is text-only", () => {
  const setup = () => {
    const insertPlainText = vi.fn()
    const clip = useClipboard({ core: { insertPlainText } as unknown as EditorCore })
    return { insertPlainText, clip }
  }

  it("ignores a pasted image: nothing is inserted and the browser does not embed it", async () => {
    const { insertPlainText, clip } = setup()
    const e = paste([{ type: "image/png", file: new File(["x"], "shot.png", { type: "image/png" }) }])
    clip.onPaste(e)
    await Promise.resolve()
    expect(e.defaultPrevented).toBe(true)
    expect(insertPlainText).not.toHaveBeenCalled()
  })

  it("still pastes the text when the clipboard has both an image and text", () => {
    const { insertPlainText, clip } = setup()
    const e = paste([{ type: "image/png", file: new File(["x"], "a.png") }, { type: "text/plain" }], "hello")
    clip.onPaste(e)
    expect(insertPlainText).toHaveBeenCalledWith("hello")
  })
})
