/**
 * error-banner.ts — which failure banner a session is allowed to show.
 *
 * `sendMessageFailed` sets one global `errorBanner`, but the failure always
 * belongs to the session whose turn raised it. Sending in session B while a
 * turn in session A is still generating is rejected by the server (one stream
 * per client), and that rejection must not follow the user into session A when
 * they navigate back. A banner with no session (host/storage errors) stays
 * visible everywhere.
 */

export interface SessionScopedBanner {
  sessionID?: string
  message: string
}

export function visibleErrorBanner<T extends SessionScopedBanner>(
  banner: T | null | undefined,
  currentSessionID: string | null,
): T | null {
  if (!banner) return null
  if (banner.sessionID && banner.sessionID !== currentSessionID) return null
  return banner
}
