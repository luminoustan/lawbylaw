/**
 * messages/TurnBubble.tsx — a user question + its reply.
 *
 * A "turn" begins at a user message and continues through every consecutive
 * assistant message until the next user message. The user input bubble is
 * sticky: it persists at the top of the scroll container while the assistant
 * reply streams or is scrolled through, until the next turn's user bubble
 * reaches the top and "pushes up" the previous one.

 */

import { createMemo, createSignal, ErrorBoundary, For, onCleanup, Show } from "solid-js"
import { useSession, type UiMessage } from "../../store/session"
import { copyText } from "../../lib/host-link"
import { formatDuration, relativeTimeAgo } from "../../lib/time"
import { PartRenderer } from "../parts"
import { ToolGroup } from "../tool-cards"
import { CheckIcon, ChevronDownIcon, CopyIcon, Edit3Icon } from "../icons"
import { groupParts, type RenderItem } from "./group-parts"
import { absoluteTime, messageText, now } from "./time-ticker"
import { TypingDots } from "./TypingDots"
import { PlanningStatus } from "./PlanningStatus"

export function TurnBubble(props: {
  messages: () => UiMessage[]
  busy: boolean
}) {
  const { beginEditMessage, editingMessageID, isSubagentSession, state } = useSession()

  // `messages` is an accessor, not a captured array: the turn rows are keyed by
  // their head message id, so the row survives an end-of-turn message
  // replacement and just reads the new object out of the live store array.
  const msgs = () => props.messages()
  const head = () => msgs()[0]!        // the user question
  const reply = () => msgs().slice(1)  // the assistant follow-up(s)
  const replyCount = () => reply().length

  // A subagent transcript is read-only: its prompt bubble must not offer
  // editing (there is no way to re-send).
  const readOnly = () => isSubagentSession(head()?.sessionID ?? "")

  // Editing is available on any user turn, including while the session is busy:
  // a turn can run for minutes, and hiding the affordance makes it look gone.
  // Only *sending* waits for the turn to close (the footer shows Stop until
  // then), so the text can be prepared while the agent works.
  const canEdit = () => head().role === "user" && !readOnly()
  const isEditing = () => editingMessageID() === head().id

  // The user bubble renders as a single-line pill by default; clicking it
  // expands the full prompt inline. Editing moves to the dedicated edit button
  // (and double-click) so a plain click can toggle expansion.
  const [expanded, setExpanded] = createSignal(false)
  const toggleExpanded = () => setExpanded((v) => !v)

  // The model is working on a step and nothing of it is visible yet (or the
  // finalization check is holding a draft back): show a "Planning next moves"
  // line so the turn never looks hung.
  const planning = () => props.busy && !!state.planning[head()?.sessionID ?? ""]

  // ── Finished-output footer: "Worked for <time>" + "<time> ago" + copy ──────
  const [copied, setCopied] = createSignal(false)
  const outputText = createMemo(() => reply().map(messageText).filter(Boolean).join("\n\n"))
  const lastReply = () => reply()[replyCount() - 1]
  const showActions = () => !props.busy && outputText().length > 0

  const stoppedByUser = () => lastReply()?.interrupted === true

  const workedFor = () => {
    const r = lastReply()
    if (!r) return ""
    // A stopped turn has no recorded end time — the footer shows
    // "Stopped by user" instead of a bogus near-zero duration.
    if (r.interrupted) return ""
    const t = r.time
    if (t?.completed && t.completed > t.created) return formatDuration(t.completed - t.created)
    // Fallback for turns persisted before turn timing was recorded.
    const start = Date.parse(head().createdAt)
    const end = Date.parse(r.createdAt)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return ""
    return formatDuration(end - start)
  }

  let copyResetTimer: number | undefined
  onCleanup(() => {
    if (copyResetTimer !== undefined) window.clearTimeout(copyResetTimer)
  })

  const onCopy = async () => {
    if (!(await copyText(outputText()))) return
    setCopied(true)
    if (copyResetTimer !== undefined) window.clearTimeout(copyResetTimer)
    copyResetTimer = window.setTimeout(() => setCopied(false), 1600)
  }

  const onBubbleClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null
    // Let links and buttons handle their own clicks, and don't hijack a text
    // selection drag.
    if (target?.closest("a, button")) return
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    toggleExpanded()
  }

  const onBubbleDoubleClick = (e: MouseEvent) => {
    if (!canEdit()) return
    const target = e.target as HTMLElement | null
    if (target?.closest("a, button")) return
    beginEditMessage(head().id)
  }

  const onEditClick = (e: MouseEvent) => {
    e.stopPropagation()
    if (!canEdit()) return
    beginEditMessage(head().id)
  }

  // The one part still receiving deltas: the last part of the last reply while
  // the turn is busy. Everything before it has settled and can render fully.
  const livePartID = (msg: UiMessage, isLast: boolean): string => {
    if (!isLast || !props.busy) return ""
    const parts = msg.parts
    return parts.length > 0 ? parts[parts.length - 1]!.id : ""
  }

  const renderItem = (item: RenderItem, msg: UiMessage, isLast: boolean, hardBreaks: boolean) => {
    if (item.kind === "group") {
      return <ToolGroup parts={item.parts()} />
    }
    return (
      <PartRenderer
        part={item.part()}
        busy={isLast && props.busy}
        streaming={livePartID(msg, isLast) === item.id}
        hardBreaks={hardBreaks}
      />
    )
  }

  const renderParts = (msg: UiMessage, isLast: boolean, hardBreaks = false) => (
    <For each={groupParts(msg.parts)}>
      {(item) => (
        <ErrorBoundary fallback={<span class="dsm-part-fallback">Part failed to render</span>}>
          {renderItem(item, msg, isLast, hardBreaks)}
        </ErrorBoundary>
      )}
    </For>
  )

  // User prompts render with hard breaks so the line breaks typed with
  // Shift+Enter stay visible instead of collapsing to spaces.
  const userContent = createMemo(() => renderParts(head(), false, true))

  return (
    <div class="dsm-turn">
      <div class="dsm-turn-main">
        <div class="dsm-turn-body">
          {/* User question — the sticky top of the turn bubble. Click to load
              it into the composer for editing and resending. */}
          <div class="dsm-turn-user-sticky">
            <div
              class="dsm-turn-user"
              classList={{
                "is-editable": canEdit(),
                "is-editing": isEditing(),
                "is-expanded": expanded(),
              }}
              onClick={onBubbleClick}
              onDblClick={onBubbleDoubleClick}
            >
              <div class="dsm-turn-user-content">
                {userContent()}
              </div>
              <div class="dsm-turn-user-actions">
                <Show when={canEdit()}>
                  <button
                    type="button"
                    class="dsm-turn-edit-btn"
                    title="Edit in the composer"
                    aria-label="Edit message in the composer"
                    onClick={onEditClick}
                  >
                    <Edit3Icon size={14} />
                  </button>
                </Show>
                <button
                  type="button"
                  class="dsm-turn-expand-btn"
                  aria-expanded={expanded()}
                  aria-label={expanded() ? "Collapse message" : "Expand message"}
                  title={expanded() ? "Collapse message" : "Expand message"}
                  onClick={toggleExpanded}
                >
                  <span class="dsm-turn-expand-chevron" aria-hidden="true">
                    <ChevronDownIcon size={14} />
                  </span>
                </button>
              </div>
            </div>
          </div>
          {/* Assistant reply — flows below, inside the same turn. */}
          <Show when={replyCount() > 0}>
            <div class="dsm-turn-reply">
              <For each={reply()}>
                {(m, i) => {
                  const isLastReply = i() === replyCount() - 1
                  const showDots = isLastReply && props.busy && m.parts.length === 0 && !planning()
                  return (
                    <div class="dsm-turn-assistant">
                      <Show when={m.parts.length > 0} fallback={showDots ? <TypingDots /> : null}>
                        {renderParts(m, isLastReply)}
                      </Show>
                      <Show when={isLastReply && planning()}>
                        <PlanningStatus />
                      </Show>
                    </div>
                  )
                }}
              </For>
              <Show when={showActions()}>
                <div class="dsm-turn-actions">
                  <Show when={stoppedByUser()}>
                    <span class="dsm-turn-stopped">Stopped by user</span>
                  </Show>
                  <Show when={workedFor()}>
                    <span class="dsm-turn-worked">Worked for {workedFor()}</span>
                  </Show>
                  <span class="dsm-turn-time" title={absoluteTime(lastReply()!.createdAt)}>
                    {relativeTimeAgo(lastReply()!.createdAt, now())}
                  </span>
                  <button
                    type="button"
                    class="dsm-turn-copy"
                    classList={{ "is-copied": copied() }}
                    title="Copy output"
                    aria-label="Copy output"
                    onClick={onCopy}
                  >
                    <Show when={copied()} fallback={<CopyIcon size={13} />}>
                      <CheckIcon size={13} />
                    </Show>
                  </button>
                </div>
              </Show>
            </div>
          </Show>

          {/* Active turn: a user question that's still awaiting its reply. */}
          <Show when={replyCount() === 0 && props.busy}>
            <div class="dsm-turn-reply">
              <div class="dsm-turn-assistant">
                {planning() ? <PlanningStatus /> : <TypingDots />}
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}
