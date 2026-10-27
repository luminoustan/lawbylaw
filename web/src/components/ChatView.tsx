/**
 * ChatView.tsx — the single chat view: scrollable message list, and the
 * docked composer area (errors, questions, the input box).
 */

import { Show } from "solid-js"
import { MessageList } from "./messages"
import { Composer } from "./composer/Composer"
import { SelectionToolbar } from "./SelectionToolbar"
import { ErrorBanner, QuestionDock } from "./panels"
import { useSession } from "../store/session"

export function ChatView() {
  const { state, isSubagentSession } = useSession()
  const readOnly = () => isSubagentSession(state.currentSessionID)

  return (
    <main class="dsm-chat">
      <div class="dsm-chat-scroll">
        <MessageList />
      </div>

      <SelectionToolbar />

      <div class="dsm-docks">
        <ErrorBanner />
        <QuestionDock />
        <Show
          when={!readOnly()}
          fallback={
            <div class="dsm-subagent-notice" role="note">
              Subagent transcript — read-only
            </div>
          }
        >
          <Composer />
        </Show>
        <div class="dsm-disclaimer" role="note">
          General information only, not legal advice. Questions go to Nebius Token Factory (or DeepSeek if you add your own DeepSeek key); provider retention terms apply. Do not paste sensitive data.
        </div>
      </div>
    </main>
  )
}
