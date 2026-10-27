/**
 * StarterQuestions.tsx — three suggested questions shown just above the chat box.
 *
 * Clicking one sends it like any typed message, so it goes through the same
 * Cloudflare Turnstile session as everything else. The row is only rendered while
 * the conversation is empty and the box is empty; typing or clicking hides it.
 */

import { For } from "solid-js"

export const STARTER_QUESTIONS = [
  "Tell me about the haze law in Singapore",
  "Is vape legal in Singapore?",
  "What does the Penal Code say about theft? Keep it very short.",
] as const

export function StarterQuestions(props: { onPick: (text: string) => void }) {
  return (
    <div class="dsm-starters" role="group" aria-label="Suggested questions">
      <For each={STARTER_QUESTIONS}>
        {(q) => (
          <button type="button" class="dsm-starter" onClick={() => props.onPick(q)}>
            {q}
          </button>
        )}
      </For>
    </div>
  )
}
