/**
 * messages/CompactionDivider.tsx — "Summarised conversation" divider shown
 * above the remaining messages after a context compaction.
 *
 * Split out of `components/messages.tsx`; behaviour is unchanged.
 */

export function CompactionDivider() {
  return (
    <div class="dsm-compaction-divider" role="separator" aria-label="Summarised conversation">
      <span class="dsm-compaction-divider-line" />
      <span class="dsm-compaction-divider-text">Summarised conversation</span>
      <span class="dsm-compaction-divider-line" />
    </div>
  )
}
