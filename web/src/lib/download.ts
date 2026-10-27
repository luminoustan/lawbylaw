/**
 * download.ts — browser file-download helper.
 *
 * Used for the chat transcript export.
 */

/** Trigger a browser download of a text payload. No-op outside a DOM. */
export function downloadTextFile(filename: string, text: string, mime = "text/markdown;charset=utf-8"): void {
  if (typeof document === "undefined" || typeof window === "undefined") return
  try {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  } catch (e) {
    console.error("Failed to download file in browser", e)
  }
}
