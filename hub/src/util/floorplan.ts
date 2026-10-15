import type { FloorPlan, PlanPoint, PlanRobotFit, PlanRoom, RobotMap } from '../model/types.ts';

// The home's floor plan: checking what's sent, a little geometry, where each device shows, and lining a robot
// vacuum's own map up with the plan so each of its areas gets the right room.

export const WALLS = ['concrete', 'brick', 'timber', 'plasterboard', 'glass'] as const;
/** About how much one wall of each kind weakens Wi-Fi (dB, 5 GHz; 2.4 GHz loses roughly half as much). */
export const WALL_DB: Record<(typeof WALLS)[number], number> = { concrete: 15, brick: 10, timber: 5, plasterboard: 3, glass: 4 };

const IMAGE = /^\/api\/photo\/floorplan-[0-9a-f]{16}\.(jpg|png|webp)$/;
const round = (n: number) => Math.round(n * 100) / 100;

/** A plan as sent (PUT /api/home/floorplan), checked and tidied, or what's wrong with it in plain words. */
export function cleanPlan(x: unknown, roomIds: string[]): FloorPlan | string {
  if (!x || typeof x !== 'object') return 'Send the plan';
  const p = x as Record<string, unknown>;
  const w = Number(p.widthM), h = Number(p.heightM);
  if (!(w >= 2 && w <= 200) || !(h >= 2 && h <= 200)) return 'The plan is 2 to 200 metres each way';
  const inPlan = (v: unknown): v is PlanPoint => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n))
    && v[0] >= -1 && v[0] <= w + 1 && v[1] >= -1 && v[1] <= h + 1;
  if (p.walls != null && !WALLS.includes(p.walls as never)) return `Walls are one of ${WALLS.join(', ')}`;
  if (!Array.isArray(p.rooms) || p.rooms.length > 200) return 'rooms is a list (200 at most)';
  const rooms: PlanRoom[] = [];
  const ids = new Set<string>();
  for (const r of p.rooms as Record<string, unknown>[]) {
    const id = String(r?.id ?? ''), name = String(r?.name ?? '').trim();
    if (!/^[\w-]{1,40}$/.test(id) || ids.has(id)) return 'Each room on the plan needs its own id';
    if (!name || name.length > 60) return 'Each room on the plan needs a name (60 letters at most)';
    if (!Array.isArray(r.points) || r.points.length < 3 || r.points.length > 64 || !r.points.every(inPlan)) return `${name}: its shape is 3 to 64 corners inside the plan`;
    const pts = (r.points as PlanPoint[]).map(([a, b]) => [round(a), round(b)] as PlanPoint);
    if (polyArea(pts) < 0.25) return `${name} is too small`;
    if (r.room != null && !roomIds.includes(String(r.room))) return `${name}: no room ${String(r.room)}`;
    ids.add(id);
    rooms.push({ id, name, points: pts, ...(r.room != null ? { room: String(r.room) } : {}), ...(r.outdoor === true ? { outdoor: true } : {}) });
  }
  const out: FloorPlan = { widthM: round(w), heightM: round(h), rooms, ...(p.walls ? { walls: p.walls as FloorPlan['walls'] } : {}) };
  if (p.places != null) {
    if (typeof p.places !== 'object' || Array.isArray(p.places) || Object.keys(p.places).length > 1000) return 'places is { device: [x, y] }';
    const places: Record<string, PlanPoint> = {};
    for (const [k, v] of Object.entries(p.places as Record<string, unknown>)) {
      if (!/^[\w:.-]{1,120}$/.test(k) || !inPlan(v)) return 'Each place is a device and a spot inside the plan';
      places[k] = [round(v[0]), round(v[1])];
    }
    out.places = places;
  }
  if (p.image != null) {
    if (typeof p.image !== 'string' || !IMAGE.test(p.image)) return 'image is the picture Kova keeps for the plan';
    out.image = p.image;
  }
  if (p.robots != null) {
    if (typeof p.robots !== 'object' || Array.isArray(p.robots)) return 'robots is { device: fit }';
    const robots: Record<string, PlanRobotFit> = {};
    for (const [k, v] of Object.entries(p.robots as Record<string, Record<string, unknown>>)) {
      const fit = cleanFit(v);
      if (!/^[\w:.-]{1,120}$/.test(k) || !fit) return 'A robot’s fit is { rot, flip, dx, dy }';
      robots[k] = fit;
    }
    out.robots = robots;
  }
  return out;
}

export function cleanFit(v: unknown): PlanRobotFit | null {
  const f = v as Record<string, unknown> | null;
  if (!f || ![0, 90, 180, 270].includes(f.rot as number) || typeof f.flip !== 'boolean') return null;
  const dx = Number(f.dx), dy = Number(f.dy);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 500 || Math.abs(dy) > 500) return null;
  return { rot: f.rot as PlanRobotFit['rot'], flip: f.flip, dx: round(dx), dy: round(dy) };
}

// ------------------------------------------------------------------ geometry --

export function polyArea(p: PlanPoint[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const [x1, y1] = p[i]!, [x2, y2] = p[(i + 1) % p.length]!; s += x1 * y2 - x2 * y1; }
  return Math.abs(s) / 2;
}

export function inside(p: PlanPoint[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i]!, [xj, yj] = p[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export function bbox(p: PlanPoint[]): { x: number; y: number; w: number; h: number } {
  const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Points on a grid `step` apart inside a shape. */
function fill(p: PlanPoint[], step: number): PlanPoint[] {
  const b = bbox(p), out: PlanPoint[] = [];
  for (let y = b.y + step / 2; y < b.y + b.h; y += step) for (let x = b.x + step / 2; x < b.x + b.w; x += step) if (inside(p, x, y)) out.push([x, y]);
  return out;
}

/** The room a spot is in (the smallest shape holding it), if any. */
export function roomAt(plan: FloorPlan, x: number, y: number): PlanRoom | null {
  let best: PlanRoom | null = null, size = Infinity;
  for (const r of plan.rooms) if (inside(r.points, x, y)) { const a = polyArea(r.points); if (a < size) { best = r; size = a; } }
  return best;
}

// ------------------------------------------------------------- where things are --

/**
 * Where each device shows on the plan: where it was put by hand, else spread over the biggest part of the plan that
 * is its room (a neat grid near the middle). Devices whose room isn't on the plan aren't shown.
 */
export function spots(plan: FloorPlan, devices: { id: string; room: string }[]): Record<string, { x: number; y: number; auto?: boolean }> {
  const out: Record<string, { x: number; y: number; auto?: boolean }> = {};
  const byRoom = new Map<string, string[]>();
  for (const d of devices) {
    const at = plan.places?.[d.id];
    if (at) { out[d.id] = { x: at[0], y: at[1] }; continue; }
    byRoom.set(d.room, [...(byRoom.get(d.room) ?? []), d.id]);
  }
  for (const [room, ids] of byRoom) {
    const shapes = plan.rooms.filter(r => r.room === room).sort((a, b) => polyArea(b.points) - polyArea(a.points));
    const shape = shapes[0];
    if (!shape) continue;
    const b = bbox(shape.points);
    // A grid about as wide as the room is, kept off the walls.
    const cols = Math.max(1, Math.min(ids.length, Math.round(Math.sqrt(ids.length * (b.w / Math.max(0.5, b.h))))));
    const rows = Math.ceil(ids.length / cols);
    const gx = Math.min(1, (b.w * 0.7) / cols);
    // Under the room's name (drawn in its top corner, about 2.6 × a 55th of the plan's longer side): never on it.
    const band = Math.min(b.h * 0.35, (Math.max(plan.widthM, plan.heightM) / 55) * 2.6);
    const cx = b.x + b.w / 2, cy = b.y + band + (b.h - band) / 2;
    const gy = Math.min(1, ((b.h - band) * 0.8) / rows);
    ids.forEach((id, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      let x = cx + (c - (cols - 1) / 2) * gx, y = cy + (r - (rows - 1) / 2) * gy;
      if (!inside(shape.points, x, y)) { const any = fill(shape.points, 0.25)[i] ?? [cx, cy]; [x, y] = any; }
      out[id] = { x: round(x), y: round(y), auto: true };
    });
  }
  return out;
}

// ------------------------------------------------------------ a robot's map --

/** A robot map's shapes ("M x yLx y…Z", 50 mm a unit, y down) as points in metres. */
export function robotShapes(map: RobotMap): { id: string; points: PlanPoint[] }[] {
  return map.areas.map(a => {
    const nums = (a.path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const points: PlanPoint[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i]! * 0.05, nums[i + 1]! * 0.05]);
    return { id: a.id, points };
  }).filter(s => s.points.length >= 3);
}

/** A point of the robot's map, on the plan. */
export function place(fit: PlanRobotFit, [x0, y0]: PlanPoint): PlanPoint {
  let x = fit.flip ? -x0 : x0, y = y0;
  if (fit.rot === 90) [x, y] = [-y, x];
  else if (fit.rot === 180) [x, y] = [-x, -y];
  else if (fit.rot === 270) [x, y] = [y, -x];
  return [x + fit.dx, y + fit.dy];
}

/**
 * Lines a robot's map up with the plan: every way it could be turned or mirrored, moved about, keeping the one where
 * each of the robot's areas lands inside one room and least of what it cleans lands outside the home. `score` is the share
 * that lands inside rooms (0–1): below about 0.75 it's a poor match (a different floor, or a plan drawn wrong).
 */
export function fitRobot(map: RobotMap, plan: FloorPlan): { fit: PlanRobotFit; score: number } | null {
  const rooms = plan.rooms.filter(r => !r.outdoor);
  if (!rooms.length) return null;
  const shapes = robotShapes(map);
  const pts = shapes.flatMap((s, i) => fill(s.points, 0.25).map(p => [p[0], p[1], i] as const));
  if (pts.length < 20) return null;
  // The plan as a grid of 10 cm cells, each holding which room it is in (1…n, the smallest that holds it) or 0.
  const W = Math.ceil(plan.widthM * 10), H = Math.ceil(plan.heightM * 10);
  const grid = new Uint16Array(W * H);
  const bySize = rooms.map((r, i) => ({ r, i })).sort((a, b) => polyArea(b.r.points) - polyArea(a.r.points));
  for (const { r, i } of bySize) {
    const b = bbox(r.points);
    for (let gy = Math.max(0, Math.floor(b.y * 10)); gy < Math.min(H, Math.ceil((b.y + b.h) * 10)); gy++)
      for (let gx = Math.max(0, Math.floor(b.x * 10)); gx < Math.min(W, Math.ceil((b.x + b.w) * 10)); gx++)
        if (inside(r.points, gx / 10 + 0.05, gy / 10 + 0.05)) grid[gy * W + gx] = i + 1;
  }
  const n = rooms.length + 1, counts = new Int32Array(shapes.length * n);
  // A good fit puts what the robot cleans inside the home, and each of its areas inside one room: per area, the
  // points in the room holding most of it count, those outside the home count against.
  const score = (fit: PlanRobotFit, share = false) => {
    counts.fill(0);
    for (const [x0, y0, a] of pts) {
      const [x, y] = place(fit, [x0, y0]);
      const gx = Math.floor(x * 10), gy = Math.floor(y * 10);
      counts[a * n + (gx >= 0 && gy >= 0 && gx < W && gy < H ? grid[gy * W + gx]! : 0)]!++;
    }
    let s = 0, inRooms = 0;
    for (let a = 0; a < shapes.length; a++) {
      let top = 0;
      for (let r = 1; r < n; r++) { const c = counts[a * n + r]!; inRooms += c; if (c > top) top = c; }
      s += top - 2 * counts[a * n]!;
    }
    return share ? inRooms / pts.length : s;
  };
  const home = bbox(rooms.flatMap(r => r.points));
  let best: { fit: PlanRobotFit; s: number } | null = null;
  for (const rot of [0, 90, 180, 270] as const) for (const flip of [false, true]) {
    const b = bbox(pts.map(([x, y]) => place({ rot, flip, dx: 0, dy: 0 }, [x, y])));
    // Start from the robot's map lined up with each corner of the home, and its middle.
    const seeds: [number, number][] = [
      [home.x - b.x, home.y - b.y], [home.x + home.w - (b.x + b.w), home.y - b.y],
      [home.x - b.x, home.y + home.h - (b.y + b.h)], [home.x + home.w - (b.x + b.w), home.y + home.h - (b.y + b.h)],
      [home.x + home.w / 2 - (b.x + b.w / 2), home.y + home.h / 2 - (b.y + b.h / 2)],
    ];
    for (const [sx, sy] of seeds) for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++) {
      const fit = { rot, flip, dx: sx + i * 0.25, dy: sy + j * 0.25 };
      const s = score(fit);
      if (!best || s > best.s) best = { fit, s };
    }
  }
  if (!best) return null;
  // Then finer, 5 cm at a time.
  const coarse = best.fit;
  for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) {
    const fit = { ...coarse, dx: coarse.dx + i * 0.05, dy: coarse.dy + j * 0.05 };
    const s = score(fit);
    if (s > best.s) best = { fit, s };
  }
  return { fit: { ...best.fit, dx: round(best.fit.dx), dy: round(best.fit.dy) }, score: Math.round(score(best.fit, true) * 100) / 100 };
}

/** Which room of the plan each of the robot's areas is mostly in, once lined up, and how much of it (0–1). */
export function robotAreaRooms(map: RobotMap, plan: FloorPlan, fit: PlanRobotFit): { id: string; planRoom: string | null; room: string | null; share: number }[] {
  return robotShapes(map).map(s => {
    const pts = fill(s.points, 0.1);
    const count = new Map<string, number>();
    for (const p of pts) { const [x, y] = place(fit, p); const r = roomAt(plan, x, y); if (r) count.set(r.id, (count.get(r.id) ?? 0) + 1); }
    const [top] = [...count].sort((a, b) => b[1] - a[1]);
    const pr = top ? plan.rooms.find(r => r.id === top[0])! : null;
    return { id: s.id, planRoom: pr?.id ?? null, room: pr?.room ?? null, share: pts.length && top ? Math.round((top[1] / pts.length) * 100) / 100 : 0 };
  });
}
