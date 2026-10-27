/**
 * mermaid/parse.ts — flowchart and sequence-diagram parsers for the in-house
 * Mermaid renderer.
 *
 * Turns mermaid source lines into the intermediate models the layout and
 * render stages consume. Split out of `lib/mermaid-lite.ts`.
 */

import {
  type EdgeSpec,
  type FlowShape,
  type HeadKind,
  type NodeRef,
  parseNodeExpr,
  splitAmp,
  tokenizeStatement,
  unquote,
} from "./lexer"

// ── Flowchart ───────────────────────────────────────────────────────────────

export interface FlowNode {
  id: string
  label: string
  shape: FlowShape
  rank: number
  order: number
  x: number
  y: number
  w: number
  h: number
}

export interface FlowEdge {
  from: string
  to: string
  label: string
  head: HeadKind
  tail: HeadKind
  dashed: boolean
  thick: boolean
}

export interface FlowGroup {
  /** Identifier edges can use to attach to the subgraph itself. */
  id: string
  title: string
  members: string[]
  /** Every node inside the subgraph, nested ones included (set by layout). */
  nodeIds: string[]
  /** Index of the enclosing subgraph, or -1 at the top level. */
  parent: number
  /** Box assigned by the layout pass (`w === 0` means nothing to draw). */
  x: number
  y: number
  w: number
  h: number
}

export interface FlowModel {
  direction: "TD" | "TB" | "BT" | "LR" | "RL"
  nodes: Map<string, FlowNode>
  edges: FlowEdge[]
  groups: FlowGroup[]
}

export function parseFlowchart(lines: string[]): FlowModel | null {
  const model: FlowModel = {
    direction: "TD",
    nodes: new Map(),
    edges: [],
    groups: [],
  }
  const groupStack: number[] = []
  let started = false

  const ensureNode = (id: string): FlowNode => {
    let node = model.nodes.get(id)
    if (!node) {
      node = { id, label: id, shape: "rect", rank: 0, order: 0, x: 0, y: 0, w: 0, h: 0 }
      model.nodes.set(id, node)
    }
    return node
  }

  const applyRef = (ref: NodeRef): string => {
    const node = ensureNode(ref.id)
    if (ref.label !== undefined) node.label = ref.label
    if (ref.shape !== undefined) node.shape = ref.shape
    return ref.id
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("%%")) continue
    if (!started) {
      const header = /^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/i.exec(line)
      if (header) {
        model.direction = header[1]!.toUpperCase() as FlowModel["direction"]
        started = true
        continue
      }
      // `flowchart` with no direction defaults to TD.
      if (/^(?:flowchart|graph)\s*$/i.test(line)) {
        started = true
        continue
      }
      continue
    }

    const sub = /^subgraph\s+(.+)$/i.exec(line)
    if (sub) {
      const title = unquote(sub[1]!.replace(/^[A-Za-z0-9_.-]+\s*\[([\s\S]+)\]$/, "$1"))
      const id = /^([A-Za-z0-9_.-]+)\s*\[/.exec(sub[1]!)?.[1] ?? title
      const parent = groupStack.length > 0 ? groupStack[groupStack.length - 1]! : -1
      const idx = model.groups.push({ id, title, members: [], nodeIds: [], parent, x: 0, y: 0, w: 0, h: 0 }) - 1
      groupStack.push(idx)
      continue
    }
    if (/^end\b/i.test(line)) {
      groupStack.pop()
      continue
    }
    if (/^(?:direction|style|classDef|class|click|linkStyle|link)\b/i.test(line)) continue

    const tokens = tokenizeStatement(line)
    let prev: string[] = []
    let pending: EdgeSpec | null = null
    for (const tok of tokens) {
      if (tok.kind === "edge") {
        pending = tok.spec
        continue
      }
      const refs: string[] = []
      for (const part of splitAmp(tok.expr)) {
        const ref = parseNodeExpr(part)
        if (!ref) continue
        const id = applyRef(ref)
        refs.push(id)
        if (groupStack.length > 0) {
          const g = model.groups[groupStack[groupStack.length - 1]!]!
          if (!g.members.includes(id)) g.members.push(id)
        }
      }
      if (pending && prev.length > 0 && refs.length > 0) {
        for (const from of prev) {
          for (const to of refs) {
            model.edges.push({
              from,
              to,
              label: pending.label,
              head: pending.head,
              tail: pending.tail,
              dashed: pending.dashed,
              thick: pending.thick,
            })
          }
        }
      }
      if (refs.length > 0) prev = refs
      pending = null
    }
  }

  // An edge may attach to a subgraph by its id (`BACKEND --> INDEX`). Those ids
  // were created as plain nodes on first mention; drop them so the edge is drawn
  // to the subgraph's box instead of to a stray one-node box.
  const groupIds = new Set(model.groups.map((g) => g.id))
  for (const id of groupIds) {
    const node = model.nodes.get(id)
    if (!node || node.label !== id || node.shape !== "rect") continue
    model.nodes.delete(id)
    for (const g of model.groups) g.members = g.members.filter((m) => m !== id)
  }

  return started && model.nodes.size > 0 ? model : null
}

// ── Sequence diagram ────────────────────────────────────────────────────────

export interface SeqParticipant {
  id: string
  label: string
  index: number
  x: number
  w: number
}

export interface SeqMessage {
  kind: "message"
  from: string
  to: string
  text: string
  dashed: boolean
  head: HeadKind
  start: boolean
}

export interface SeqNote {
  kind: "note"
  placement: "left" | "right" | "over"
  from: string
  to: string
  text: string
}

export interface SeqFrameStart {
  kind: "frame"
  type: string
  label: string
}

export interface SeqDivider {
  kind: "divider"
  label: string
}

export interface SeqFrameEnd {
  kind: "frameEnd"
}

export interface SeqActivation {
  kind: "activate" | "deactivate"
  who: string
}

export type SeqItem = SeqMessage | SeqNote | SeqFrameStart | SeqDivider | SeqFrameEnd | SeqActivation

export function parseSequence(lines: string[]): { participants: SeqParticipant[]; items: SeqItem[] } | null {
  const participants: SeqParticipant[] = []
  const byId = new Map<string, SeqParticipant>()
  const items: SeqItem[] = []

  const ensure = (id: string, label?: string): SeqParticipant => {
    let p = byId.get(id)
    if (!p) {
      p = { id, label: label ?? id, index: participants.length, x: 0, w: 0 }
      byId.set(id, p)
      participants.push(p)
    } else if (label !== undefined) {
      p.label = label
    }
    return p
  }

  let started = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("%%")) continue
    if (!started) {
      if (/^sequenceDiagram\b/i.test(line)) started = true
      continue
    }
    if (/^autonumber\b/i.test(line)) continue

    const decl = /^(?:participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/i.exec(line)
    if (decl) {
      ensure(decl[1]!, decl[2] ? unquote(decl[2]) : undefined)
      continue
    }

    const note = /^Note\s+(right of|left of|over)\s+([^:]+?)\s*:\s*(.*)$/i.exec(line)
    if (note) {
      const placement = note[1]!.toLowerCase().startsWith("right")
        ? "right"
        : note[1]!.toLowerCase().startsWith("left")
          ? "left"
          : "over"
      const ids = note[2]!.split(",").map((s) => s.trim()).filter(Boolean)
      for (const id of ids) ensure(id)
      items.push({ kind: "note", placement, from: ids[0]!, to: ids[ids.length - 1]!, text: note[3]!.trim() })
      continue
    }

    const act = /^(activate|deactivate)\s+(\S+)/i.exec(line)
    if (act) {
      ensure(act[2]!)
      items.push({ kind: act[1]!.toLowerCase() === "activate" ? "activate" : "deactivate", who: act[2]! })
      continue
    }

    if (/^end\b/i.test(line)) {
      items.push({ kind: "frameEnd" })
      continue
    }

    const frame = /^(loop|alt|opt|par|critical|break|rect|else|and)\b\s*(.*)$/i.exec(line)
    if (frame) {
      const type = frame[1]!.toLowerCase()
      const label = frame[2]!.trim()
      if (type === "else" || type === "and") items.push({ kind: "divider", label: `${type} ${label}`.trim() })
      else items.push({ kind: "frame", type, label })
      continue
    }

    const msg = /^([^\s:]+?)\s*(<<)?(-{1,2}|-\.|\.-)(>>|>|x|\)|<<)?\s*([^\s:]+?)\s*:\s*(.*)$/.exec(line)
    if (msg) {
      let from = msg[1]!
      let to = msg[5]!
      let activate = 0
      if (to.startsWith("+")) {
        activate = 1
        to = to.slice(1)
      } else if (to.startsWith("-")) {
        activate = -1
        to = to.slice(1)
      }
      if (from.endsWith("+") || from.endsWith("-")) from = from.slice(0, -1)
      ensure(from)
      ensure(to)
      const tail = msg[4] ?? ""
      const head: HeadKind = tail === ">>" || tail === ">" ? "arrow" : tail === "x" ? "cross" : tail === ")" ? "open" : "none"
      items.push({
        kind: "message",
        from,
        to,
        text: msg[6]!.trim(),
        dashed: msg[3]!.includes(".") || msg[3]!.startsWith("--"),
        head,
        start: Boolean(msg[2]) || tail === "<<",
      })
      if (activate === 1) items.push({ kind: "activate", who: to })
      else if (activate === -1) items.push({ kind: "deactivate", who: to })
      continue
    }
  }

  return started && participants.length > 0 ? { participants, items } : null
}
