/**
 * mermaid/layout.ts — flowchart layout for the in-house Mermaid renderer.
 *
 * Sizes nodes from their labels and assigns ranks/positions with a
 * longest-path ranking plus a couple of barycenter passes. Subgraphs are laid
 * out hierarchically: each one is arranged on its own, then placed as a single
 * block in its parent, so a subgraph box always encloses exactly its members
 * (and its nested subgraphs) and never overlaps an unrelated node. Split out of
 * `lib/mermaid-lite.ts`.
 */

import { LINE_H, labelLines, round, textWidth } from "./lexer"
import type { FlowGroup, FlowModel, FlowNode } from "./parse"

/** Wrap width (characters) for node labels; diamonds get less as they widen. */
const NODE_WRAP = 30
const DIAMOND_WRAP = 18
/** Wrap width (characters) for edge labels. */
export const EDGE_WRAP = 26

/** Size of an edge label's box: its wrapped text plus a little padding. */
export function edgeLabelSize(label: string): { w: number; h: number } {
  if (!label) return { w: 0, h: 0 }
  const lines = labelLines(label, EDGE_WRAP)
  return { w: textWidth(lines) + 10, h: lines.length * LINE_H + 4 }
}

/** Display lines of a node label, wrapped for its shape. */
export function nodeLabelLines(node: FlowNode): string[] {
  return labelLines(node.label, node.shape === "diamond" ? DIAMOND_WRAP : NODE_WRAP)
}

/** Size a node from its label and shape. */
export function sizeFlowNode(node: FlowNode): void {
  const lines = nodeLabelLines(node)
  const tw = textWidth(lines)
  const th = lines.length * LINE_H
  const px = 16
  const py = 11
  let w = Math.max(46, tw + px * 2)
  let h = Math.max(34, th + py * 2)
  switch (node.shape) {
    case "diamond":
      w = Math.max(64, tw * 1.9 + px * 2)
      h = Math.max(46, th * 1.8 + py * 2)
      break
    case "circle": {
      const d = Math.max(46, tw * 1.3 + 20, th + 24)
      w = d
      h = d
      break
    }
    case "hexagon":
      w = Math.max(56, tw + px * 2 + 22)
      break
    case "cylinder":
      h = Math.max(40, th + py * 2 + 12)
      break
    default:
      break
  }
  node.w = round(w)
  node.h = round(h)
}

/** Outer padding of the whole diagram. */
const PAD = 20
/** Gap between consecutive ranks (leaves room for edge labels). */
const RANK_GAP = 58
/** Gap between siblings within a rank. */
const NODE_GAP = 34
/** Widest a top-down rank may be before it wraps into stacked rows. */
const MAX_ROW = 780
/** Gap between the wrapped rows of one rank. */
const ROW_GAP = 34
/** Clear space kept on each side of an edge label within a rank gap. */
const LABEL_MARGIN = 14
/** Subgraph padding: sides, title band on top, bottom. */
const GROUP_PAD_X = 18
const GROUP_PAD_TOP = 36
const GROUP_PAD_BOTTOM = 18
/** Room reserved at the right for a self-loop drawn outside its node. */
export const SELF_LOOP_W = 30

/** An edge between two blocks, with the size of its label (0 when unlabelled). */
interface UnitEdge {
  a: number
  b: number
  lw: number
  lh: number
}

/** A block placed by `placeUnits`: a node, or a laid-out subgraph. */
interface Unit {
  w: number
  h: number
  x: number
  y: number
  rank: number
  order: number
}

/**
 * Rank and position `units` connected by `edges` (index pairs). Positions are
 * relative to the scope origin and include `pad` on every side. Returns the
 * size of the placed area.
 */
function placeUnits(
  units: Unit[],
  edges: readonly UnitEdge[],
  vertical: boolean,
  reversed: boolean,
  pad: number,
): { w: number; h: number } {
  const n = units.length
  if (n === 0) return { w: 0, h: 0 }

  const preds: number[][] = units.map(() => [])
  const succs: number[][] = units.map(() => [])
  const backEdges = new Set<number>()
  const adjacency: Array<Array<{ to: number; edge: number }>> = units.map(() => [])

  edges.forEach(({ a, b }, ei) => {
    if (a === b) return
    adjacency[a]!.push({ to: b, edge: ei })
    preds[b]!.push(a)
    succs[a]!.push(b)
  })

  // Mark back edges (edges to a unit still on the DFS stack) so ranking sees a DAG.
  const color = new Array<number>(n).fill(0)
  for (let root = 0; root < n; root++) {
    if (color[root] !== 0) continue
    const stack: Array<{ u: number; i: number }> = [{ u: root, i: 0 }]
    color[root] = 1
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const outs = adjacency[frame.u]!
      if (frame.i >= outs.length) {
        color[frame.u] = 2
        stack.pop()
        continue
      }
      const { to, edge } = outs[frame.i]!
      frame.i++
      if (color[to] === 1) {
        backEdges.add(edge)
      } else if (color[to] === 0) {
        color[to] = 1
        stack.push({ u: to, i: 0 })
      }
    }
  }

  // Longest-path ranking over the forward (non-back) edges.
  const rank = new Array<number>(n).fill(0)
  const forward = edges
    .map(({ a, b }, ei) => ({ a, b, ei }))
    .filter(({ a, b, ei }) => a !== b && !backEdges.has(ei))
  for (let iter = 0; iter < n; iter++) {
    let changed = false
    for (const { a, b } of forward) {
      if (rank[b]! < rank[a]! + 1) {
        rank[b] = rank[a]! + 1
        changed = true
      }
    }
    if (!changed) break
  }

  const ranks: number[][] = []
  for (let i = 0; i < n; i++) {
    const r = rank[i]!
    if (!ranks[r]) ranks[r] = []
    ranks[r]!.push(i)
  }

  // A couple of barycenter passes to cut obvious crossings.
  const bary = (list: number[], neighbors: number[][], pos: Map<number, number>): number[] =>
    list
      .map((u) => {
        const ns = neighbors[u]!
        let key = pos.get(u) ?? 0
        if (ns.length > 0) {
          let sum = 0
          for (const v of ns) sum += pos.get(v) ?? 0
          key = sum / ns.length
        }
        return { u, key }
      })
      .sort((a, b) => a.key - b.key)
      .map((o) => o.u)
  for (let pass = 0; pass < 4; pass++) {
    if (pass % 2 === 0) {
      for (let r = 1; r < ranks.length; r++) {
        const pos = new Map(ranks[r - 1]!.map((u, i) => [u, i] as const))
        ranks[r] = bary(ranks[r]!, preds, pos)
      }
    } else {
      for (let r = ranks.length - 2; r >= 0; r--) {
        const pos = new Map(ranks[r + 1]!.map((u, i) => [u, i] as const))
        ranks[r] = bary(ranks[r]!, succs, pos)
      }
    }
  }

  const placedRanks = reversed ? [...ranks.keys()].reverse() : [...ranks.keys()]
  const unitMain = (u: number): number => (vertical ? units[u]!.h : units[u]!.w)
  const unitCross = (u: number): number => (vertical ? units[u]!.w : units[u]!.h)

  // A top-down rank with many blocks would make the whole diagram wide, and a
  // wide diagram is shrunk until its text is unreadable. Blocks with no edge in
  // this scope (nothing to route to them) are wrapped into stacked rows no wider
  // than MAX_ROW. Blocks that are connected are never split off: putting a
  // fan-out's children on a second row would force their edges through the
  // first row. (Left-to-right ranks run along the height, which the column does
  // not constrain, so they stay whole.)
  const linked = new Set<number>()
  for (const { a, b } of edges) {
    if (a === b) continue
    linked.add(a)
    linked.add(b)
  }
  const rowsOf = (list: number[]): number[][] => {
    if (!vertical) return [list]
    const rows: number[][] = [list.filter((u) => linked.has(u))]
    let width = rows[0]!.reduce((sum, u, i) => sum + unitCross(u) + (i > 0 ? NODE_GAP : 0), 0)
    for (const u of list) {
      if (linked.has(u)) continue
      const last = rows[rows.length - 1]!
      const add = unitCross(u) + (last.length > 0 ? NODE_GAP : 0)
      if (last.length > 0 && width + add > MAX_ROW) {
        rows.push([u])
        width = unitCross(u)
      } else {
        last.push(u)
        width += add
      }
    }
    return rows.filter((row) => row.length > 0)
  }
  const rowMain = (row: number[]): number => Math.max(...row.map(unitMain))
  const rowCross = (row: number[]): number =>
    row.reduce((sum, u) => sum + unitCross(u), 0) + NODE_GAP * Math.max(0, row.length - 1)

  // Each gap between ranks is at least RANK_GAP, and wide enough for the
  // labels of the edges that cross it along the flow axis (their width in a
  // left-to-right diagram, their height in a top-down one).
  const gapAfter = new Array<number>(ranks.length).fill(RANK_GAP)
  for (const { a, b, lw, lh } of edges) {
    if (a === b || (lw === 0 && lh === 0)) continue
    const lo = Math.min(rank[a]!, rank[b]!)
    if (Math.abs(rank[a]! - rank[b]!) !== 1) continue
    gapAfter[lo] = Math.max(gapAfter[lo]!, (vertical ? lh : lw) + 2 * LABEL_MARGIN)
  }
  const gapBetween = (r1: number, r2: number): number => gapAfter[Math.min(r1, r2)]!

  const rankRows = ranks.map((list) => rowsOf(list!))
  const rankMain = (r: number): number => {
    const rows = rankRows[r]!
    return rows.reduce((sum, row) => sum + rowMain(row), 0) + ROW_GAP * (rows.length - 1)
  }

  let maxCross = 0
  for (const rows of rankRows) for (const row of rows) maxCross = Math.max(maxCross, rowCross(row))

  let main = pad
  placedRanks.forEach((r, i) => {
    if (i > 0) main += gapBetween(placedRanks[i - 1]!, r)
    let rowStart = main
    let order = 0
    for (const row of rankRows[r]!) {
      const thick = rowMain(row)
      let cross = pad + (maxCross - rowCross(row)) / 2
      for (const u of row) {
        const unit = units[u]!
        unit.rank = r
        unit.order = order++
        if (vertical) {
          unit.x = round(cross)
          unit.y = round(rowStart + (thick - unit.h) / 2)
          cross += unit.w + NODE_GAP
        } else {
          unit.y = round(cross)
          unit.x = round(rowStart + (thick - unit.w) / 2)
          cross += unit.h + NODE_GAP
        }
      }
      rowStart += thick + ROW_GAP
    }
    main += rankMain(r)
  })
  const totalMain = main + pad
  const totalCross = maxCross + pad * 2
  return vertical ? { w: totalCross, h: totalMain } : { w: totalMain, h: totalCross }
}

/** Width needed for a subgraph title (11.5px label) plus its side margins. */
function groupTitleWidth(group: FlowGroup): number {
  return textWidth([group.title]) * 0.9 + 24
}

/** What one scope (the top level, or one subgraph) laid out. */
interface ScopeLayout {
  w: number
  h: number
  /** Every node placed in this scope, including nested subgraphs' nodes. */
  nodeIds: string[]
  /** Every subgraph placed in this scope, including nested ones. */
  groupIds: number[]
}

/**
 * Lay out the flowchart. Node `x`/`y` and subgraph boxes are written onto the
 * model in diagram coordinates; the returned size is the full canvas.
 */
export function layoutFlowchart(model: FlowModel): { w: number; h: number } {
  const nodes = [...model.nodes.values()]
  if (nodes.length === 0) return { w: 0, h: 0 }
  for (const node of nodes) sizeFlowNode(node)

  const vertical = model.direction !== "LR" && model.direction !== "RL"
  const reversed = model.direction === "BT" || model.direction === "RL"
  const groups = model.groups

  // A node belongs to the first subgraph that lists it.
  const owner = new Map<string, number>()
  groups.forEach((g, gi) => {
    for (const id of g.members) if (!owner.has(id)) owner.set(id, gi)
  })

  // A subgraph with no nodes anywhere beneath it is never drawn.
  const hasContent = new Array<boolean>(groups.length).fill(false)
  for (const [, gi] of owner) {
    for (let g = gi; g !== -1 && !hasContent[g]; g = groups[g]!.parent) hasContent[g] = true
  }

  const layoutScope = (scope: number, pad: number): ScopeLayout => {
    const units: Unit[] = []
    const unitOfNode = new Map<string, number>()
    const direct: FlowNode[] = []
    const childGroups: Array<{ gi: number; inner: ScopeLayout; unit: number }> = []

    const newUnit = (w: number, h: number): number =>
      units.push({ w, h, x: 0, y: 0, rank: 0, order: 0 }) - 1

    for (const node of nodes) {
      const o = owner.get(node.id)
      if ((o ?? -1) !== scope) continue
      direct.push(node)
      unitOfNode.set(node.id, newUnit(node.w, node.h))
    }
    groups.forEach((g, gi) => {
      if (g.parent !== scope || !hasContent[gi]) return
      const inner = layoutScope(gi, 0)
      const w = Math.max(inner.w + GROUP_PAD_X * 2, groupTitleWidth(g))
      const h = inner.h + GROUP_PAD_TOP + GROUP_PAD_BOTTOM
      const unit = newUnit(w, h)
      for (const id of inner.nodeIds) unitOfNode.set(id, unit)
      // Edges may name a subgraph itself; it resolves to this block.
      for (const id of [gi, ...inner.groupIds]) {
        const groupId = groups[id]!.id
        if (!model.nodes.has(groupId) && !unitOfNode.has(groupId)) unitOfNode.set(groupId, unit)
      }
      childGroups.push({ gi, inner, unit })
    })

    // Edges between this scope's blocks. An edge inside one block is that
    // block's own business; one that leaves the scope is handled above.
    const pairs: UnitEdge[] = []
    const seen = new Map<string, UnitEdge>()
    for (const edge of model.edges) {
      const a = unitOfNode.get(edge.from)
      const b = unitOfNode.get(edge.to)
      if (a === undefined || b === undefined || a === b) continue
      const { w, h } = edgeLabelSize(edge.label)
      const key = `${a}>${b}`
      const prior = seen.get(key)
      if (prior) {
        prior.lw = Math.max(prior.lw, w)
        prior.lh = Math.max(prior.lh, h)
        continue
      }
      const pair = { a, b, lw: w, lh: h }
      seen.set(key, pair)
      pairs.push(pair)
    }

    const box = placeUnits(units, pairs, vertical, reversed, pad)

    for (const node of direct) {
      const unit = units[unitOfNode.get(node.id)!]!
      node.x = unit.x
      node.y = unit.y
      node.rank = unit.rank
      node.order = unit.order
    }

    const nodeIds = direct.map((n) => n.id)
    const groupIds: number[] = []
    for (const { gi, inner, unit: ui } of childGroups) {
      const unit = units[ui]!
      const g = groups[gi]!
      g.x = unit.x
      g.y = unit.y
      g.w = unit.w
      g.h = unit.h
      // Centre the block in its box (the title can make the box wider).
      const dx = unit.x + (unit.w - inner.w) / 2
      const dy = unit.y + GROUP_PAD_TOP
      for (const id of inner.nodeIds) {
        const node = model.nodes.get(id)!
        node.x = round(node.x + dx)
        node.y = round(node.y + dy)
      }
      for (const id of inner.groupIds) {
        const nested = groups[id]!
        nested.x = round(nested.x + dx)
        nested.y = round(nested.y + dy)
      }
      g.nodeIds = inner.nodeIds
      nodeIds.push(...inner.nodeIds)
      groupIds.push(gi, ...inner.groupIds)
    }
    return { w: box.w, h: box.h, nodeIds, groupIds }
  }

  const root = layoutScope(-1, PAD)
  const hasSelfLoop = model.edges.some((e) => e.from === e.to)
  return { w: root.w + (hasSelfLoop ? SELF_LOOP_W : 0), h: root.h }
}
