/**
 * messages/group-parts.ts — fold runs of consecutive groupable tool parts.
 *
 * A run of consecutive web-search tool parts becomes a single ToolGroup ("Explored
 * N web searches"), while a run of one stays a plain row so a lone search is not
 * hidden behind a disclosure.
 *
 * The wrappers are cached by part id. `groupParts` runs inside the JSX, so it
 * re-runs whenever any part in the message changes — i.e. on every streamed
 * delta. Returning fresh wrapper objects each time made `<For>` dispose and
 * rebuild every row (and therefore every child renderer) per token; caching
 * means only the part that actually changed gets a new wrapper. The wrapper
 * reads the live part through an accessor, so content still updates.

 */

import { isToolPart, type ToolPart, type WirePart } from "../../lib/types"
import { isGroupable, toolCategory } from "../../lib/tool-display"

export type RenderItem =
  | { kind: "part"; id: string; part: () => WirePart }
  | { kind: "group"; id: string; parts: () => ToolPart[] }

const itemCache = new WeakMap<WirePart[], Map<string, RenderItem>>()

export function groupParts(parts: WirePart[]): RenderItem[] {
  let cache = itemCache.get(parts)
  if (!cache) {
    cache = new Map()
    itemCache.set(parts, cache)
  }
  const cached = cache
  const items: RenderItem[] = []
  let runStart = -1
  let runLength = 0

  const pushPart = (idx: number, p: WirePart) => {
    const key = `p:${p.id}`
    let item = cached.get(key)
    if (!item) {
      item = { kind: "part", id: p.id, part: () => parts[idx] ?? p }
      cached.set(key, item)
    }
    items.push(item)
  }

  const pushGroup = (start: number, length: number) => {
    const ids: string[] = []
    for (let k = start; k < start + length; k++) ids.push(parts[k]!.id)
    const key = `g:${ids.join(",")}`
    let item = cached.get(key)
    if (!item) {
      item = {
        kind: "group",
        id: key,
        parts: () => parts.slice(start, start + length).filter(isToolPart) as ToolPart[],
      }
      cached.set(key, item)
    }
    items.push(item)
  }

  const flush = () => {
    if (runLength === 0) return
    if (runLength === 1) pushPart(runStart, parts[runStart]!)
    else pushGroup(runStart, runLength)
    runStart = -1
    runLength = 0
  }

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (isToolPart(p) && isGroupable(toolCategory((p as ToolPart).tool))) {
      if (runLength === 0) runStart = i
      runLength++
    } else {
      flush()
      pushPart(i, p)
    }
  }
  flush()
  return items
}
