/**
 * mermaid/render.ts — SVG emission and the public entry point for the in-house
 * Mermaid renderer.
 *
 * Draws the flowchart and sequence models to inline SVG and exposes
 * `renderMermaid`, which parses, lays out, and renders a source block. Split
 * out of `lib/mermaid-lite.ts`.
 */

import { escapeHtml } from "../escape"
import {
  LINE_H,
  type MermaidRender,
  markerRef,
  nextSvgUid,
  labelLines,
  round,
  svgRoot,
  textWidth,
} from "./lexer"
import { EDGE_WRAP, SELF_LOOP_W, edgeLabelSize, layoutFlowchart, nodeLabelLines } from "./layout"
import {
  type FlowGroup,
  type FlowModel,
  type FlowNode,
  type SeqItem,
  type SeqParticipant,
  parseFlowchart,
  parseSequence,
} from "./parse"

// ── Flowchart rendering ─────────────────────────────────────────────────────

function flowNodeShape(node: FlowNode): string {
  const { x, y, w, h } = node
  const cx = x + w / 2
  const cy = y + h / 2
  switch (node.shape) {
    case "round":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" ry="5"/>`
    case "stadium":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ry="${h / 2}"/>`
    case "diamond":
      return `<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}"/>`
    case "circle":
      return `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}"/>`
    case "hexagon":
      return `<polygon points="${x + w * 0.16},${y} ${x + w * 0.84},${y} ${x + w},${cy} ${x + w * 0.84},${y + h} ${x + w * 0.16},${y + h} ${x},${cy}"/>`
    case "subroutine":
      return (
        `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>` +
        `<line class="dsm-mermaid-node-rule" x1="${x + 9}" y1="${y}" x2="${x + 9}" y2="${y + h}"/>` +
        `<line class="dsm-mermaid-node-rule" x1="${x + w - 9}" y1="${y}" x2="${x + w - 9}" y2="${y + h}"/>`
      )
    case "cylinder": {
      const r = Math.min(9, h / 3)
      return (
        `<path d="M${x},${y + r} a${w / 2},${r} 0 0 1 ${w},0 v${h - 2 * r} a${w / 2},${r} 0 0 1 ${-w},0 z"/>` +
        `<path class="dsm-mermaid-node-rule" d="M${x},${y + r} a${w / 2},${r} 0 0 0 ${w},0"/>`
      )
    }
    case "asymmetric":
      return `<polygon points="${x},${y} ${x + w * 0.84},${y} ${x + w},${cy} ${x + w * 0.84},${y + h} ${x},${y + h}"/>`
    default:
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`
  }
}

function flowNodeLabel(node: FlowNode): string {
  const lines = nodeLabelLines(node)
  const cx = node.x + node.w / 2
  const first = node.y + node.h / 2 - ((lines.length - 1) * LINE_H) / 2
  const tspans = lines
    .map((line, i) => `<tspan x="${round(cx)}" y="${round(first + i * LINE_H)}">${escapeHtml(line)}</tspan>`)
    .join("")
  return `<text class="dsm-mermaid-label" text-anchor="middle" dominant-baseline="middle">${tspans}</text>`
}

type Pt = readonly [number, number]

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A placed node or subgraph; `shape` lets a straight edge meet a slanted border. */
interface Box extends Rect {
  shape?: string
}

const rectsOverlap = (a: Rect, b: Rect, margin = 0): boolean =>
  a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin

/** An orthogonal edge: a polyline whose segments are all horizontal or vertical. */
type Poly = readonly Pt[]

function polyPath(p: Poly): string {
  return p.map((pt, i) => `${i === 0 ? "M" : "L"}${round(pt[0])},${round(pt[1])}`).join(" ")
}

function polyLength(p: Poly): number {
  let len = 0
  for (let i = 1; i < p.length; i++) len += Math.abs(p[i][0] - p[i - 1][0]) + Math.abs(p[i][1] - p[i - 1][1])
  return len
}

/** The point `dist` along the polyline. */
function polyAt(p: Poly, dist: number): Pt {
  let left = dist
  for (let i = 1; i < p.length; i++) {
    const seg = Math.abs(p[i][0] - p[i - 1][0]) + Math.abs(p[i][1] - p[i - 1][1])
    if (left <= seg && seg > 0) {
      const t = left / seg
      return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t]
    }
    left -= seg
  }
  return p[p.length - 1]
}

/** Drop repeated points and the middle point of any three in a line. */
function simplify(p: Poly): Poly {
  const out: Pt[] = []
  for (const pt of p) {
    const last = out[out.length - 1]
    if (last && Math.abs(last[0] - pt[0]) < 0.01 && Math.abs(last[1] - pt[1]) < 0.01) continue
    out.push(pt)
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1]
    const b = out[i]
    const c = out[i + 1]
    if ((Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - c[0]) < 0.01) || (Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - c[1]) < 0.01)) out.splice(i, 1)
  }
  return out
}

/** Does any axis-aligned segment of `p` (skipping the first `skip` and last `skipEnd`) enter `r`? */
function segmentsHit(p: Poly, r: Rect, margin: number, skip = 0, skipEnd = 0): boolean {
  for (let i = 1 + skip; i < p.length - skipEnd; i++) {
    const x0 = Math.min(p[i - 1][0], p[i][0])
    const x1 = Math.max(p[i - 1][0], p[i][0])
    const y0 = Math.min(p[i - 1][1], p[i][1])
    const y1 = Math.max(p[i - 1][1], p[i][1])
    if (x0 < r.x + r.w + margin && x1 > r.x - margin && y0 < r.y + r.h + margin && y1 > r.y - margin) return true
  }
  return false
}

/** How far a shape's border is inside its bounding box at `cross` (0 for boxes). */
function shapeInset(n: Box, flowV: boolean, cross: number): number {
  const H = flowV ? n.h / 2 : n.w / 2
  const W = flowV ? n.w / 2 : n.h / 2
  const centre = flowV ? n.x + n.w / 2 : n.y + n.h / 2
  const d = Math.min(Math.abs(cross - centre), W)
  switch (n.shape) {
    case "diamond":
      return (H * d) / W
    case "circle":
      return H * (1 - Math.sqrt(Math.max(0, 1 - (d / W) ** 2)))
    case "hexagon":
      return flowV ? (d > 0.68 * W ? (H * (d - 0.68 * W)) / (0.32 * W) : 0) : (0.32 * H * d) / W
    default:
      return 0
  }
}

/** Shortest overlap of two ranges before an edge between them may run straight. */
const STRAIGHT_MIN = 14
/** Gap kept between a routed edge and a node it passes. */
const EDGE_CLEAR = 10
const BEND_COST = 30
/** One node in the way outweighs any amount of extra length. */
const CROSS_COST = 100000

/**
 * Route an edge between two placed boxes using only horizontal and vertical
 * segments. An edge between boxes that overlap along the cross axis is a single
 * straight line. Otherwise it leaves the side facing its target, runs to the
 * middle of the gap, turns, and enters the target, with two right-angle bends.
 * When every such route would cut through an unrelated node, it runs in a lane
 * beside the obstacles instead. Boxes that share a rank (their flow-axis ranges
 * overlap) connect along the cross axis.
 */
function routeEdge(a: Box, b: Box, flowVertical: boolean, obstacles: readonly Rect[], canvas: { w: number; h: number }): Poly {
  if (a === b) {
    // Self-loop: a small square bracket off the right side (the canvas reserves room).
    const sx = a.x + a.w
    const sy = a.y + a.h * 0.3
    const ty = a.y + a.h * 0.7
    const out = SELF_LOOP_W - 10
    return [[sx, sy], [sx + out, sy], [sx + out, ty], [sx, ty]]
  }

  const sharesRank = flowVertical ? a.y < b.y + b.h && b.y < a.y + a.h : a.x < b.x + b.w && b.x < a.x + a.w
  const flowV = sharesRank ? !flowVertical : flowVertical
  // Work in (flow, cross) coordinates so one routine serves both directions.
  const fl = (r: Rect): [number, number] => (flowV ? [r.y, r.y + r.h] : [r.x, r.x + r.w])
  const cr = (r: Rect): [number, number] => (flowV ? [r.x, r.x + r.w] : [r.y, r.y + r.h])
  const pt = (f: number, c: number): Pt => (flowV ? [c, f] : [f, c])
  const [af0, af1] = fl(a)
  const [bf0, bf1] = fl(b)
  const [ac0, ac1] = cr(a)
  const [bc0, bc1] = cr(b)
  const forward = (bf0 + bf1) / 2 >= (af0 + af1) / 2
  const dir = forward ? 1 : -1
  const sf = forward ? af1 : af0
  const tf = forward ? bf0 : bf1
  const ca = (ac0 + ac1) / 2
  const cb = (bc0 + bc1) / 2
  const cw = flowV ? canvas.w : canvas.h

  const candidates: Poly[] = []

  // 1. Straight: boxes overlapping along the cross axis share one line.
  const lo = Math.max(ac0, bc0)
  const hi = Math.min(ac1, bc1)
  if (hi - lo >= STRAIGHT_MIN) {
    const inside = (c: number): boolean => c >= lo + 6 && c <= hi - 6
    const c = inside(ca) ? ca : inside(cb) ? cb : (lo + hi) / 2
    candidates.push([pt(sf + dir * shapeInset(a, flowV, c), c), pt(tf - dir * shapeInset(b, flowV, c), c)])
  }

  // 2. Two bends through the gap between the boxes; the turn may also sit beside an obstacle.
  const gap = Math.abs(tf - sf)
  const turns = new Set<number>([(sf + tf) / 2])
  for (const o of obstacles) {
    const [of0, of1] = fl(o)
    for (const f of [of0 - EDGE_CLEAR, of1 + EDGE_CLEAR]) if ((f - sf) * dir > 4 && (tf - f) * dir > 4) turns.add(f)
  }
  for (const f of turns) candidates.push([pt(sf, ca), pt(f, ca), pt(f, cb), pt(tf, cb)])

  // 3. Lanes beside the obstacles: out of the source, along a clear column, into the target.
  const stub = Math.max(6, Math.min(18, gap / 2))
  const f1 = sf + dir * stub
  const f2 = tf - dir * stub
  const lanes = new Set<number>([10, cw - 10])
  for (const o of [a, b, ...obstacles]) {
    const [oc0, oc1] = cr(o)
    lanes.add(oc0 - EDGE_CLEAR)
    lanes.add(oc1 + EDGE_CLEAR)
  }
  for (const lane of lanes) {
    if (lane < 4 || lane > cw - 4) continue
    candidates.push([pt(sf, ca), pt(f1, ca), pt(f1, lane), pt(f2, lane), pt(f2, cb), pt(tf, cb)])
  }

  const scored = candidates.map((c) => {
    const p = simplify(c)
    let cross = 0
    for (const o of obstacles) if (segmentsHit(p, o, 3)) cross++
    // The run beside the source and target must not slide over them either.
    for (const o of [a, b]) if (segmentsHit(p, o, 1, 1, 1)) cross++
    return { p, score: cross * CROSS_COST + polyLength(p) + (p.length - 2) * BEND_COST }
  })
  let best = scored[0]
  for (const s of scored) if (s.score < best.score) best = s
  return best.p
}

/**
 * Where an edge label goes: on the longest straight run, as near its middle as
 * the label box can sit clear of every node and every label already placed.
 */
function placeEdgeLabel(
  path: Poly,
  w: number,
  h: number,
  nodes: readonly Rect[],
  placed: readonly Rect[],
): { x: number; y: number } {
  const segs: { at: (t: number) => Pt; len: number }[] = []
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1]
    const q = path[i]
    segs.push({ len: Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]), at: (t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t] })
  }
  segs.sort((s, t) => t.len - s.len)
  for (const seg of segs) {
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88]) {
      const [x, y] = seg.at(t)
      const box = { x: x - w / 2, y: y - h / 2, w, h }
      if (nodes.some((n) => rectsOverlap(box, n, 2)) || placed.some((p) => rectsOverlap(box, p, 2))) continue
      return { x, y }
    }
  }
  const [x, y] = polyAt(path, polyLength(path) / 2)
  return { x, y }
}

function renderFlowchartSvg(model: FlowModel, box: { w: number; h: number }): string {
  const nodes = [...model.nodes.values()]
  const uid = nextSvgUid()
  const vertical = model.direction !== "LR" && model.direction !== "RL"

  const parts: string[] = []

  // Subgraph boxes sit behind everything. The layout pass sized each one to its
  // members plus a title band, and a parent is listed before its children, so
  // nested boxes draw on top of their parents.
  model.groups.forEach((group) => {
    if (group.w <= 0 || group.h <= 0) return
    parts.push(
      `<g class="dsm-mermaid-group"><rect x="${round(group.x)}" y="${round(group.y)}" width="${round(group.w)}" height="${round(group.h)}"/>` +
        `<text class="dsm-mermaid-group-label" x="${round(group.x + 12)}" y="${round(group.y + 22)}">${escapeHtml(group.title)}</text></g>`,
    )
  })

  const nodeRects: Rect[] = nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))
  // Labels also keep clear of subgraph titles.
  const labelObstacles: Rect[] = [...nodeRects]
  for (const g of model.groups) {
    if (g.w <= 0 || g.h <= 0) continue
    labelObstacles.push({ x: g.x + 8, y: g.y + 6, w: Math.min(g.w - 16, textWidth([g.title]) * 0.9 + 8), h: 22 })
  }
  const placedLabels: Rect[] = []
  // Detours and labels can leave the laid-out box; the canvas grows to hold them.
  const extent = { minX: 0, minY: 0, maxX: box.w, maxY: box.h }
  const grow = (x: number, y: number, m = 6): void => {
    extent.minX = Math.min(extent.minX, x - m)
    extent.minY = Math.min(extent.minY, y - m)
    extent.maxX = Math.max(extent.maxX, x + m)
    extent.maxY = Math.max(extent.maxY, y + m)
  }

  // An edge endpoint is a node, or a subgraph named by its id.
  const groupById = new Map<string, FlowGroup>()
  for (const g of model.groups) if (g.w > 0 && !groupById.has(g.id)) groupById.set(g.id, g)
  const endpoint = (id: string): { box: Box; inside: ReadonlySet<string> } | undefined => {
    const node = model.nodes.get(id)
    if (node) return { box: node, inside: new Set([id]) }
    const group = groupById.get(id)
    return group ? { box: group, inside: new Set(group.nodeIds) } : undefined
  }

  for (const edge of model.edges) {
    const from = endpoint(edge.from)
    const to = endpoint(edge.to)
    if (!from || !to) continue
    const a = from.box
    const b = to.box
    // The nodes inside a subgraph endpoint are not in the edge's way.
    const obstacles = nodes
      .filter((n) => !from.inside.has(n.id) && !to.inside.has(n.id))
      .map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))
    const path = routeEdge(a, b, vertical, obstacles, box)
    for (const [px, py] of path) grow(px, py)
    const cls = `dsm-mermaid-edge${edge.dashed ? " dsm-mermaid-edge--dashed" : ""}${edge.thick ? " dsm-mermaid-edge--thick" : ""}`
    parts.push(
      `<path class="${cls}" d="${polyPath(path)}"${markerRef(edge.tail, uid, "end")}${markerRef(edge.head, uid, "start")}/>`,
    )
    if (edge.label) {
      const lines = labelLines(edge.label, EDGE_WRAP)
      const { w, h } = edgeLabelSize(edge.label)
      const { x: mx, y: my } = placeEdgeLabel(path, w, h, labelObstacles, placedLabels)
      placedLabels.push({ x: mx - w / 2, y: my - h / 2, w, h })
      grow(mx - w / 2, my - h / 2, 2)
      grow(mx + w / 2, my + h / 2, 2)
      const tspans = lines
        .map((line, i) => `<tspan x="${round(mx)}" y="${round(my - ((lines.length - 1) * LINE_H) / 2 + i * LINE_H)}">${escapeHtml(line)}</tspan>`)
        .join("")
      parts.push(
        `<g class="dsm-mermaid-edge-label"><rect x="${round(mx - w / 2)}" y="${round(my - h / 2)}" width="${round(w)}" height="${round(h)}"/>` +
          `<text text-anchor="middle" dominant-baseline="middle">${tspans}</text></g>`,
      )
    }
  }

  for (const node of nodes) {
    parts.push(`<g class="dsm-mermaid-node dsm-mermaid-node--${node.shape}">${flowNodeShape(node)}${flowNodeLabel(node)}</g>`)
  }

  // Shift everything right/down when a detour went past the top or left edge.
  const dx = Math.ceil(-extent.minX)
  const dy = Math.ceil(-extent.minY)
  const body = dx > 0 || dy > 0 ? `<g transform="translate(${dx},${dy})">${parts.join("")}</g>` : parts.join("")
  return svgRoot(uid, Math.ceil(extent.maxX) + dx, Math.ceil(extent.maxY) + dy, "Mermaid flowchart", body)
}

// ── Sequence rendering ──────────────────────────────────────────────────────

function seqText(text: string, x: number, y: number, anchor: "start" | "middle", centreBlock = false): string {
  const lines = labelLines(text)
  const first = centreBlock ? y - ((lines.length - 1) * LINE_H) / 2 : y
  const tspans = lines
    .map((line, i) => `<tspan x="${round(x)}" y="${round(first + i * LINE_H)}">${escapeHtml(line)}</tspan>`)
    .join("")
  return `<text class="dsm-mermaid-label" text-anchor="${anchor}" dominant-baseline="middle">${tspans}</text>`
}

function renderSequenceSvg(src: { participants: SeqParticipant[]; items: SeqItem[] }): string {
  const { participants, items } = src
  const uid = nextSvgUid()
  const PAD = 18
  const BOX_H = 34
  const COL_GAP = 26
  const MSG_H = 40
  const NOTE_PAD = 10

  for (const p of participants) {
    const lines = labelLines(p.label)
    p.w = Math.max(90, textWidth(lines) + 28)
  }
  let cursor = PAD
  for (const p of participants) {
    p.x = cursor + p.w / 2
    cursor += p.w + COL_GAP
  }
  const totalW = cursor - COL_GAP + PAD

  const top = PAD
  let y = top + BOX_H + 26
  const parts: string[] = []
  const lifelineTop = top + BOX_H

  interface Frame {
    type: string
    label: string
    startY: number
    endY: number
    dividers: Array<{ y: number; label: string }>
  }
  const frames: Frame[] = []
  const stack: Frame[] = []
  const activations: Array<{ who: string; y1: number; y2: number }> = []
  const actStack = new Map<string, number[]>()
  const xOf = (id: string): number => participants.find((p) => p.id === id)?.x ?? 0

  const frameLabel = (type: string, label: string): string => (label ? `${type} ${label}` : type)

  for (const item of items) {
    switch (item.kind) {
      case "message": {
        const x1 = xOf(item.from)
        const x2 = xOf(item.to)
        const self = item.from === item.to
        const rowH = self ? MSG_H + 22 : MSG_H
        const lineY = y + rowH / 2
        const cls = `dsm-mermaid-seq-msg${item.dashed ? " dsm-mermaid-edge--dashed" : ""}`
        if (self) {
          const rx = x1 + 34
          const d = `M${round(x1)},${round(lineY - 9)} L${round(rx)},${round(lineY - 9)} L${round(rx)},${round(lineY + 9)} L${round(x1)},${round(lineY + 9)}`
          parts.push(`<path class="${cls}" d="${d}"${markerRef(item.head, uid, "end")}/>`)
          parts.push(seqText(item.text, x1 + 42, lineY - 14, "start"))
        } else {
          const dir = x2 > x1 ? 1 : -1
          const sx = x1 + dir * 0
          const ex = x2 - dir * 0
          parts.push(`<line class="${cls}" x1="${round(sx)}" y1="${round(lineY)}" x2="${round(ex)}" y2="${round(lineY)}"${markerRef(item.head, uid, "end")}${item.start ? markerRef(item.head, uid, "start") : ""}/>`)
          parts.push(seqText(item.text, (sx + ex) / 2, lineY - 9, "middle"))
        }
        y += rowH
        break
      }
      case "note": {
        const lines = labelLines(item.text)
        const h = lines.length * LINE_H + NOTE_PAD * 2
        const tw = textWidth(lines) + NOTE_PAD * 2 + 6
        let nx: number
        if (item.placement === "over") {
          const a = xOf(item.from)
          const b = xOf(item.to)
          const cx = (a + b) / 2
          const w = Math.max(tw, Math.abs(b - a) + 40)
          nx = cx - w / 2
          parts.push(`<g class="dsm-mermaid-note"><rect x="${round(nx)}" y="${round(y)}" width="${round(w)}" height="${round(h)}"/>`)
          parts.push(seqText(item.text, cx, y + h / 2, "middle", true))
          parts.push(`</g>`)
        } else if (item.placement === "right") {
          const a = xOf(item.from)
          nx = a + 18
          parts.push(`<g class="dsm-mermaid-note"><rect x="${round(nx)}" y="${round(y)}" width="${round(tw)}" height="${round(h)}"/>`)
          parts.push(seqText(item.text, nx + tw / 2, y + h / 2, "middle", true))
          parts.push(`</g>`)
        } else {
          const a = xOf(item.from)
          nx = a - 18 - tw
          parts.push(`<g class="dsm-mermaid-note"><rect x="${round(nx)}" y="${round(y)}" width="${round(tw)}" height="${round(h)}"/>`)
          parts.push(seqText(item.text, nx + tw / 2, y + h / 2, "middle", true))
          parts.push(`</g>`)
        }
        y += h + 12
        break
      }
      case "frame": {
        const frame: Frame = { type: item.type, label: item.label, startY: y, endY: y, dividers: [] }
        stack.push(frame)
        y += 26
        break
      }
      case "divider": {
        const current = stack[stack.length - 1]
        if (current) current.dividers.push({ y, label: item.label })
        y += 20
        break
      }
      case "frameEnd": {
        const frame = stack.pop()
        if (frame) {
          frame.endY = y + 10
          frames.push(frame)
          y += 12
        }
        break
      }
      case "activate": {
        const list = actStack.get(item.who) ?? []
        list.push(y)
        actStack.set(item.who, list)
        break
      }
      case "deactivate": {
        const list = actStack.get(item.who)
        if (list && list.length > 0) {
          const start = list.pop()!
          activations.push({ who: item.who, y1: start, y2: y })
        }
        break
      }
    }
  }
  for (const [who, list] of actStack) {
    while (list.length > 0) activations.push({ who, y1: list.pop()!, y2: y })
  }

  const bottom = y + PAD
  const frameX = 4
  const frameW = totalW - 8

  const body: string[] = []
  // Frames first so lifelines and messages draw over them.
  for (const frame of frames) {
    const fy = frame.startY
    const fh = Math.max(34, frame.endY - frame.startY)
    body.push(`<g class="dsm-mermaid-frame"><rect x="${frameX}" y="${round(fy)}" width="${round(frameW)}" height="${round(fh)}"/>`)
    const label = frameLabel(frame.type, frame.label)
    const lw = textWidth([label]) + 16
    body.push(`<path class="dsm-mermaid-frame-tab" d="M${frameX},${round(fy)} h${round(lw)} v14 l-8,8 h${round(-(lw - 8))} z"/>`)
    body.push(`<text class="dsm-mermaid-frame-label" x="${frameX + 8}" y="${round(fy + 12)}">${escapeHtml(label)}</text>`)
    body.push(`</g>`)
  }
  for (const frame of frames) {
    for (const d of frame.dividers) {
      body.push(`<line class="dsm-mermaid-frame-divider" x1="${frameX}" y1="${round(d.y)}" x2="${round(frameX + frameW)}" y2="${round(d.y)}"/>`)
      body.push(`<text class="dsm-mermaid-frame-label" x="${frameX + 8}" y="${round(d.y + 14)}">${escapeHtml(d.label)}</text>`)
    }
  }

  for (const p of participants) {
    body.push(`<line class="dsm-mermaid-lifeline" x1="${round(p.x)}" y1="${round(lifelineTop)}" x2="${round(p.x)}" y2="${round(bottom)}"/>`)
  }
  for (const a of activations) {
    const x = xOf(a.who)
    body.push(`<rect class="dsm-mermaid-activation" x="${round(x - 5)}" y="${round(a.y1)}" width="10" height="${round(Math.max(10, a.y2 - a.y1))}"/>`)
  }
  body.push(...parts)
  for (const p of participants) {
    const lines = labelLines(p.label)
    body.push(`<g class="dsm-mermaid-participant"><rect x="${round(p.x - p.w / 2)}" y="${round(top)}" width="${round(p.w)}" height="${BOX_H}"/>`)
    body.push(seqText(lines.join("\n"), p.x, top + BOX_H / 2, "middle", true))
    body.push(`</g>`)
  }

  return svgRoot(uid, totalW, bottom + 4, "Mermaid sequence diagram", body.join(""))
}

// ── Entry point ─────────────────────────────────────────────────────────────

/** Render a mermaid source block to SVG, or report why it could not be drawn. */
export function renderMermaid(source: string): MermaidRender {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  const first = lines.map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith("%%"))
  if (!first) return { ok: false, error: "empty diagram" }
  try {
    if (/^(?:flowchart|graph)\b/i.test(first)) {
      const model = parseFlowchart(lines)
      if (!model) return { ok: false, error: "no flowchart nodes" }
      const box = layoutFlowchart(model)
      if (box.w <= 0 || box.h <= 0) return { ok: false, error: "empty flowchart" }
      return { ok: true, kind: "flowchart", svg: renderFlowchartSvg(model, box) }
    }
    if (/^sequenceDiagram\b/i.test(first)) {
      const model = parseSequence(lines)
      if (!model) return { ok: false, error: "no sequence participants" }
      return { ok: true, kind: "sequence", svg: renderSequenceSvg(model) }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: false, error: "unsupported diagram type" }
}
