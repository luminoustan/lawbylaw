/**
 * tool-cards/task.tsx — the subagent (task) row card.
 */

import { Show } from "solid-js"
import type { ToolPart } from "../../lib/types"
import { toolStatusLabel } from "../../lib/tool-display"
import { useSession } from "../../store/session"

/** task: a bulleted subagent row (name + type + status). */
export function TaskCard(props: { part: ToolPart }) {
  const { state, openSubagentSession } = useSession()
  const state_ = () => props.part.state
  const input = () => state_().input
  const description = () => (input().description as string) ?? "Sub-agent"
  const type = () => (input().subagentType as string) ?? ""
  const status = () => state_().status
  const statusLabel = () => {
    const meta = props.part.metadata
    const n = Number(meta?.searches) || 0
    if (status() === "running" && meta?.phase) {
      const phase = meta.phase === "synthesising" ? "Synthesizing" : "Searching"
      return n > 0 ? `${phase} · ${n} ${n === 1 ? "search" : "searches"}` : phase
    }
    return toolStatusLabel(status())
  }

  // Resolve the subagent session id: prefer the live callID → taskId mapping
  // (available while the subagent runs), fall back to the completed part's
  // metadata (persisted in the task result).
  const taskId = (): string => {
    const callId = props.part.callID
    const mapped = callId ? state.subagentByCallID[callId] : undefined
    if (mapped) return mapped
    const s = state_()
    if (s.status === "completed") {
      const id = s.metadata?.taskId
      if (typeof id === "string") return id
    }
    return ""
  }

  // Openable once the subagent session exists — either streamed live during the
  // run, or replayed from the persisted transcript after a reload.
  const openable = () => !!state.subagents[taskId()]

  const Row = () => (
    <>
      <span class="dsm-task-bullet" aria-hidden="true" />
      <span class="dsm-task-name">{description()}</span>
      <Show when={type()}>
        <span class="dsm-task-type">{type()}</span>
      </Show>
    </>
  )

  return (
    <div class="dsm-tool dsm-tool--task" data-status={status()}>
      <Show
        when={openable()}
        fallback={
          <div class="dsm-task-row">
            <Row />
          </div>
        }
      >
        <button
          type="button"
          class="dsm-task-row"
          title="Open subagent transcript"
          aria-label={`Open subagent transcript: ${description()}`}
          onClick={() => openSubagentSession(taskId())}
        >
          <Row />
        </button>
      </Show>
      <div class="dsm-task-status">{statusLabel()}</div>
    </div>
  )
}
