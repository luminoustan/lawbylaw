/**
 * bus.tsx — the host → UI message router.
 *
 * This module owns the `handleHostMessage` switch that normalises every host
 * event (ready, configLoaded, sessionsLoaded, partUpdated, …) into the
 * per-session caches in the store. It is a pure function factory: it receives
 * the store internals it needs (state, setters, helper actions and the message
 * bus) and returns the message handler. It holds NO reactivity of its own and
 * exports no components.
 *
 * The event groups live in `store/bus/` (`session-events`, `message-events`,
 * `context-events`, `interaction-events`) with the shared dependency contract
 * in `store/bus/shared`. The events themselves are emitted by `host/web-host.ts`.
 */

import { handleSessionEvent } from "./bus/session-events"
import { handleMessageEvent } from "./bus/message-events"
import { handleContextEvent } from "./bus/context-events"
import { handleInteractionEvent } from "./bus/interaction-events"
import type { RouterDeps } from "./bus/shared"

export type { RouterDeps } from "./bus/shared"

export function createHostMessageRouter(deps: RouterDeps): (m: Record<string, unknown>) => void {
  return function handleHostMessage(m: Record<string, unknown>): void {
    if (handleSessionEvent(deps, m)) return
    if (handleMessageEvent(deps, m)) return
    if (handleContextEvent(deps, m)) return
    if (handleInteractionEvent(deps, m)) return
    // Anything else is not part of this app's protocol and is ignored.
  }
}
