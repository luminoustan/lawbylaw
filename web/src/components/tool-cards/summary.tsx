/**
 * tool-cards/summary.tsx — the compact one-line row (web search / misc), also
 * used inside a grouped "Explored" summary.
 */

import { isLegalTool, summaryLine } from "../../lib/tool-display"
import type { ToolPart } from "../../lib/types"
import { toolIcon } from "./shared"

/** A compact one-line row for web-search/misc tools (also used when grouped). */
export function SummaryRow(props: { part: ToolPart }) {
  const state = () => props.part.state
  const tool = () => props.part.tool
  // Legal search tools carry a ready-made title from the host ("Searched legislation: ...").
  const label = () => {
    const title = (state() as { title?: string }).title
    return title && isLegalTool(tool()) ? title : summaryLine(tool(), state().input)
  }
  const Icon = toolIcon(tool())
  return (
    <div class="dsm-tool-row" data-status={state().status}>
      <span class="dsm-tool-row-icon">
        <Icon size={12} />
      </span>
      <span class="dsm-tool-row-label">{label()}</span>
    </div>
  )
}
