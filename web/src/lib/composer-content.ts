/**
 * composer-content.ts — pure content helpers for the composer.
 *
 * Serializes the contenteditable composer (text + quote pills) into the prompt
 * that is sent to the host. No DOM state beyond the editor subtree the caller
 * passes in.
 */

/** Format pasted chat text as a markdown blockquote for the prompt. */
function quoteBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")
}

export function serializeComposerContent(editor: HTMLElement) {
  let display = ""
  const promptParts: string[] = []
  const extraContext: string[] = []
  let pillCount = 0

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const val = node.nodeValue || ""
      display += val
      promptParts.push(val)
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.classList.contains("dsm-composer-pill")) {
        pillCount++
        const label = el.dataset.label || ""
        const marker = el.dataset.marker || label
        const fullContext = el.dataset.fullContext || ""

        // The transcript keeps the short chip label; the prompt gets the long
        // marker so a big paste can still be identified once it is in history.
        display += `[Quoted: ${label}]`
        promptParts.push(`[Quoted: ${marker}]`)
        if (fullContext) extraContext.push(quoteBlock(fullContext))
      } else if (el.tagName === "BR") {
        display += "\n"
        promptParts.push("\n")
      } else {
        for (const child of Array.from(el.childNodes)) {
          walk(child)
        }
        if (el.tagName === "DIV" || el.tagName === "P") {
          display += "\n"
          promptParts.push("\n")
        }
      }
    }
  }

  for (const child of Array.from(editor.childNodes)) {
    walk(child)
  }

  // Trim leading whitespace and trailing spaces/tabs, but keep intentional
  // trailing newlines: a user who presses Shift+Enter at the end of their text
  // means to send those blank lines, and `.trim()` would silently drop them.
  const trimEdges = (s: string) => s.replace(/^\s+/, "").replace(/[ \t]+$/, "")

  let finalPrompt = trimEdges(promptParts.join(""))
  if (extraContext.length > 0) {
    finalPrompt = `${extraContext.join("\n\n")}\n\n${finalPrompt}`
  }

  return {
    displayText: trimEdges(display),
    fullPrompt: trimEdges(finalPrompt),
    hasPills: pillCount > 0,
    pillCount,
  }
}
