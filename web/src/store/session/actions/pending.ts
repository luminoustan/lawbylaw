/**
 * session/actions/pending.ts — replies to host-initiated prompts.
 *
 * Owns the question dock (answer/dismiss).
 */

import type { SessionCore } from "../core"

export interface PendingActions {
  answerQuestion: (answers: string[][]) => void
  dismissQuestion: () => void
}

export function createPendingActions(core: SessionCore): PendingActions {
  const { state, setState, bus } = core

  /** Reply to the active question (or dismiss it) and clear it. */
  function replyQuestion(answers: string[][], dismissed: boolean): void {
    const q = state.activeQuestion
    if (!q) return
    bus.post({ type: "questionReply", requestId: q.requestId, answers, dismissed })
    setState("activeQuestion", null)
  }

  function answerQuestion(answers: string[][]): void {
    replyQuestion(answers, false)
  }

  function dismissQuestion(): void {
    replyQuestion([], true)
  }

  return { answerQuestion, dismissQuestion }
}
