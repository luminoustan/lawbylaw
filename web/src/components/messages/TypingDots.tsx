/**
 * messages/TypingDots.tsx — the three-dot "working" indicator.
 *
 * Split out of `components/messages.tsx`; behaviour is unchanged.
 */

export function TypingDots() {
  return (
    <span class="dsm-typing-dots" aria-label="Working">
      <i />
      <i />
      <i />
    </span>
  )
}
