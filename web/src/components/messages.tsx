/**
 * messages.tsx — message list & bubble renderers.
 *
 * Renders the part types the host actually produces by delegating to the
 * per-part renderers in components/parts.tsx (text, reasoning, tool, unknown).
 * This module owns the list/scroll/streaming concerns: the message bubble,
 * the auto-scrolling list, the typing dots, the session-scoped notices and
 * the empty/intro state. The extracted part cards in parts.tsx are purely
 * presentational.
 *
 * This file is a thin facade: the implementation lives in `components/messages/`
 * (`TurnBubble`, `MessageList`, `NoticeRow`, `CompactionDivider`, `TypingDots`,
 * `group-parts`, `time-ticker`). The public exports are unchanged so existing
 * importers keep working.
 */

export { TurnBubble } from "./messages/TurnBubble"
export { MessageList } from "./messages/MessageList"
export { NoticeRow } from "./messages/NoticeRow"
export { CompactionDivider } from "./messages/CompactionDivider"
export { TypingDots } from "./messages/TypingDots"
