/**
 * skills.ts — the skills offered by the composer's "/" menu.
 *
 * A skill is a named action the user can invoke by typing `/<name>`. Picking one
 * from the menu inserts `/<name> ` into the composer; sending it runs the skill
 * instead of sending a message to the model.
 */

import type { SlashItem } from "./types"

export const SKILLS: SlashItem[] = [
  {
    name: "compact",
    description: "Summarise the older messages to free up context",
    source: "skill",
  },
]

/** The skill named by a message like `/compact` or `/Compact  now`, or undefined for ordinary text. */
export function skillFor(text: string): SlashItem | undefined {
  const m = text.match(/^\/([^\s]+)(?:\s+[\s\S]*)?$/)
  if (!m) return undefined
  const name = m[1]!.toLowerCase()
  return SKILLS.find((s) => s.name === name)
}
