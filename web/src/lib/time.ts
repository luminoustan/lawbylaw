/**
 * time.ts — relative-time formatting shared by the session rail and the
 * message list.
 *
 * Both surfaces show the same seconds → minutes → hours → days ladder but with
 * different wording: the rail is compact ("5m"), message headers say "5m ago".
 * The ladder itself lives here once.
 */

interface Elapsed {
  /** Elapsed whole seconds, floored or rounded depending on the caller. */
  s: number
  m: number
  h: number
  d: number
  date: Date
}

function elapsed(iso: string, at: number, roundSeconds: boolean): Elapsed | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const s = Math.max(0, roundSeconds ? Math.round((at - t) / 1000) : Math.floor((at - t) / 1000))
  return { s, m: Math.floor(s / 60), h: Math.floor(s / 3600), d: Math.floor(s / 86400), date: new Date(t) }
}

/** Compact relative time for the session rail: "now", "5m", "3h", "2d", then a date. */
export function timeAgo(iso: string, at = Date.now()): string {
  const e = elapsed(iso, at, false)
  if (!e) return ""
  if (e.s < 45) return "now"
  if (e.m < 60) return `${e.m}m`
  if (e.h < 24) return `${e.h}h`
  if (e.d < 7) return `${e.d}d`
  return e.date.toLocaleDateString()
}

/** Verbose relative time for message headers: "8s ago", "5m ago", "2d ago", then a date. */
export function relativeTimeAgo(iso: string, at = Date.now()): string {
  const e = elapsed(iso, at, true)
  if (!e) return ""
  if (e.s < 60) return `${e.s}s ago`
  if (e.m < 60) return `${e.m}m ago`
  if (e.h < 24) return `${e.h}h ago`
  if (e.d < 30) return `${e.d}d ago`
  return e.date.toLocaleDateString()
}

/** Compact elapsed duration for worked-for footers: "8s", "1m 12s", "2h 5m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 1) return "<1s"
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}
