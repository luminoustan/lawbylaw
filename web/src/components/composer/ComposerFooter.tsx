/**
 * composer/ComposerFooter.tsx — the footer row inside the composer box.
 *
 * Carries the key badge on the left and, on the right, the right-aligned
 * action cluster: the context ring (toggle → breakdown popover) and the
 * send/stop button.
 */

import { Show, type Accessor } from "solid-js"
import { ContextRing } from "../ContextRing"
import { SendIcon, StopIcon } from "../icons"
import { KeyBadge } from "./KeyBadge"

export interface ComposerFooterProps {
  ready: Accessor<boolean>
  busy: Accessor<boolean>
  editingTarget: Accessor<string | null>
  canSend: Accessor<boolean>
  submit: () => void
  stopTurn: () => void

  // Input size cap
  charCount?: Accessor<number>
  charMax?: Accessor<number>
  capNotice?: Accessor<string>
}

export function ComposerFooter(props: ComposerFooterProps) {
  return (
    <div class="dsm-composer-footer">
      {/* Its flex:1 keeps the action cluster right-aligned. Holds the badge that says whose key is in use. */}
      <div class="dsm-composer-selectors">
        <KeyBadge />
      </div>
      <Show when={!props.ready()}>
        <span class="dsm-composer-connecting">
          <span class="dsm-spinner" aria-hidden="true" />
          Connecting…
        </span>
      </Show>
      <div class="dsm-composer-actions">
        <Show when={props.charMax && props.charCount && (props.charCount() > props.charMax() * 0.7 || props.capNotice?.())}>
          <span
            class="dsm-composer-count"
            classList={{ "is-near": props.charCount!() >= props.charMax!() * 0.9 }}
            role="status"
            aria-live="polite"
            title={props.capNotice?.() || "Characters used"}
          >
            {props.capNotice?.() || `${props.charCount!()}/${props.charMax!()}`}
          </span>
        </Show>
        <ContextRing />
        <Show
          when={props.busy()}
          fallback={
            <button
              type="button"
              class="dsm-btn dsm-btn-icon dsm-send"
              disabled={!props.ready() || !props.canSend()}
              title={props.editingTarget() ? "Resend edited message" : "Send"}
              aria-label={props.editingTarget() ? "Resend edited message" : "Send"}
              onClick={props.submit}
            >
              <SendIcon size={13} />
            </button>
          }
        >
          <button
            type="button"
            class="dsm-btn dsm-btn-icon dsm-stop"
            title="Stop generation"
            aria-label="Stop generation"
            onClick={props.stopTurn}
          >
            <StopIcon size={12} />
          </button>
        </Show>
      </div>
    </div>
  )
}
