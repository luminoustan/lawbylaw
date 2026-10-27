/**
 * tool-cards/shared.tsx — shared chrome for the tool cards.
 */

import { Show, type JSX } from "solid-js"
import {
  BookOpenIcon,
  BranchIcon,
  GavelIcon,
  GlobeIcon,
  HelpCircleIcon,
  ListChecksIcon,
  ScaleIcon,
  SearchIcon,
  WrenchIcon,
} from "../icons"

/** Pick a distinct icon per tool so cards are visually differentiable. */
export function toolIcon(name: string): (p: { size?: number; class?: string }) => JSX.Element {
  switch (name) {
    case "search_legislation":
    case "get_section":
      return SearchIcon
    case "search_judiciary":
    case "judiciary_agent":
    case "research_judiciary":
    case "get_judgment":
      return GavelIcon
    case "research_legislation":
    case "legislation_agent":
      return ScaleIcon
    case "research_subsidiary_legislation":
    case "research_sl":
      return BookOpenIcon
    case "classify_issue":
      return ListChecksIcon
    case "web_search_tavily":
    case "web_search_deepseek":
      return GlobeIcon
    case "task":
      return BranchIcon
    case "askquestion":
      return HelpCircleIcon
    default:
      return WrenchIcon
  }
}

/** Shared header row: icon + label (+ optional trailing meta). */
export function ToolHead(props: { icon: JSX.Element; label: string; meta?: string; running?: boolean }) {
  return (
    <div class="dsm-tool-head">
      <span class="dsm-tool-icon">{props.icon}</span>
      <span class="dsm-tool-name">
        <span class="dsm-tool-name-glow">{props.label}</span>
      </span>
      <Show when={props.meta}>
        <span class="dsm-tool-meta">{props.meta}</span>
      </Show>
    </div>
  )
}
