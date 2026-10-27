/**
 * ids.ts — collision-resistant local ids for UI-side entities.
 *
 * Shared by the store (messages, parts, notices) and the helpers around it so
 * every id has the same shape.
 */

let localSeq = 0

/** Collision-resistant local id (prefix + timestamp + monotonic sequence). */
export function cid(prefix: string): string {
  localSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${localSeq.toString(36)}`
}
