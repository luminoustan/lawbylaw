/**
 * messages/PlanningStatus.tsx — the "Synthesizing" indicator.
 *
 * Shown at the end of the live reply from the moment each model step starts
 * until that step's first reasoning, text or tool call appears (and again while
 * the finalization check holds a draft answer back), so the transcript never
 * sits still and looks hung. The label breathes like a running tool name;
 * reduced-motion users get it static.
 */

export function PlanningStatus() {
  return (
    <div class="dsm-planning">
      <span class="dsm-planning-label">Synthesizing</span>
    </div>
  )
}
