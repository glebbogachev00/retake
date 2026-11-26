/**
 * Journeys, the part that decides whether anything changed.
 *
 * A journey is run every night and put against the run a person last
 * accepted as normal, one step at a time. A step has changed when any of
 * three things is true:
 *
 *   - it passed before and fails now (or the other way round);
 *   - the page's visible text is different;
 *   - the picture differs by more than a small patch.
 *
 * Masked regions count for nothing in either comparison: what is hidden
 * from the video is hidden from the comparison too, so a secret (or a clock
 * the journey masked because it changes on its own) can never make a
 * journey "change".
 *
 * Everything here is pure: pictures come in decoded, and nothing touches a
 * browser, so the decisions are the same in a test as at 3 a.m.
 */
import zlib from "node:zlib";

// ---------- pictures ----------

/** A decoded picture: 8-bit RGBA, rows top to bottom. */
export type Picture = { width: number; height: number; data: Uint8Array };
/** In the picture's own pixels. */
export type Rect = { x: number; y: number; width: number; height: number };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The PNGs a browser takes: 8-bit grey, grey+alpha, RGB or RGBA, not
    interlaced. Anything else is refused rather than half-read. */
export function decodePng(buf: Buffer): Picture {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let i = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    i += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[color];
  if (!width || !height || depth !== 8 || !channels || interlace !== 0) throw new Error(`a PNG this cannot read (depth ${depth}, colour type ${color}${interlace ? ", interlaced" : ""})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride, prev = out - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[out + x - channels] : 0;
      const b = y > 0 ? px[prev + x] : 0;
      const c = y > 0 && x >= channels ? px[prev + x - channels] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[out + x] = v & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let p = 0, q = 0; p < width * height; p++, q += channels) {
    const o = p * 4;
    if (channels >= 3) { data[o] = px[q]; data[o + 1] = px[q + 1]; data[o + 2] = px[q + 2]; data[o + 3] = channels === 4 ? px[q + 3] : 255; }
    else { data[o] = data[o + 1] = data[o + 2] = px[q]; data[o + 3] = channels === 2 ? px[q + 1] : 255; }
  }
  return { width, height, data };
}

let crcTable: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGBA in, a plain PNG out. */
export function encodePng(p: Picture): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(p.width, 0); ihdr.writeUInt32BE(p.height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((p.width * 4 + 1) * p.height);
  for (let y = 0; y < p.height; y++) Buffer.from(p.data.buffer, p.data.byteOffset + y * p.width * 4, p.width * 4).copy(raw, y * (p.width * 4 + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A channel has to move this far before a pixel counts as different: font
    smoothing and colour rounding move it less. */
export const PIXEL_DELTA = 48;
/** The picture is compared in square blocks of this many pixels a side. */
export const BLOCK = 8;
/** A block has changed when this many of its pixels have. Scattered noise
    never gets there; a glyph, an edge or an icon does. */
export const BLOCK_PIXELS = 8;
/** A step's picture has changed when this many blocks have: about a 20 × 20
    patch, the size of a small icon. */
export const CHANGED_BLOCKS = 6;

export type PictureDiff = {
  changed: boolean;
  changedBlocks: number;
  blocks: number;
  /** Where it changed, as fractions of the picture (0–1), for drawing. */
  box: { x: number; y: number; width: number; height: number } | null;
  sizeChanged?: boolean;
};

/** How far, in pixels, a pixel may have moved and still be the same: text
    that reflows by one pixel (a masked clock a digit narrower, a rounding
    change in the layout) is not a change. */
export const SHIFT_TOLERANCE = 1;

const near = (a: Uint8Array, o: number, b: Uint8Array, q: number) =>
  Math.abs(a[o] - b[q]) <= PIXEL_DELTA && Math.abs(a[o + 1] - b[q + 1]) <= PIXEL_DELTA && Math.abs(a[o + 2] - b[q + 2]) <= PIXEL_DELTA;

/** Is the pixel at (x, y) of `p` found within SHIFT_TOLERANCE of (x, y) in `q`? */
function foundNear(p: Uint8Array, q: Uint8Array, x: number, y: number, W: number, H: number): boolean {
  const o = (y * W + x) * 4;
  for (let dy = -SHIFT_TOLERANCE; dy <= SHIFT_TOLERANCE; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= H) continue;
    for (let dx = -SHIFT_TOLERANCE; dx <= SHIFT_TOLERANCE; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= W) continue;
      if (near(p, o, q, (yy * W + xx) * 4)) return true;
    }
  }
  return false;
}

/** How much two pictures differ, leaving out the regions in `ignore` (the
    masks, in either picture). A pixel differs only when nothing within a
    pixel of it in the other picture matches it, either way round: a shift by
    one pixel is not a change, an icon gone or a word replaced is. */
export function pictureDiff(a: Picture, b: Picture, ignore: Rect[] = []): PictureDiff {
  const cols = Math.ceil(b.width / BLOCK), rows = Math.ceil(b.height / BLOCK);
  if (a.width !== b.width || a.height !== b.height) {
    return { changed: true, changedBlocks: cols * rows, blocks: cols * rows, box: { x: 0, y: 0, width: 1, height: 1 }, sizeChanged: true };
  }
  const { width: W, height: H } = b;
  const skip = new Uint8Array(W * H);
  for (const r of ignore) {
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(W, Math.ceil(r.x + r.width)), y1 = Math.min(H, Math.ceil(r.y + r.height));
    for (let y = y0; y < y1; y++) skip.fill(1, y * W + x0, y * W + x1);
  }
  let changed = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      let n = 0;
      const yEnd = Math.min(H, (by + 1) * BLOCK), xEnd = Math.min(W, (bx + 1) * BLOCK);
      for (let y = by * BLOCK; y < yEnd && n < BLOCK_PIXELS; y++) {
        for (let x = bx * BLOCK; x < xEnd; x++) {
          const p = y * W + x;
          if (skip[p]) continue;
          const o = p * 4;
          if (near(a.data, o, b.data, o)) continue;
          if (!foundNear(b.data, a.data, x, y, W, H) || !foundNear(a.data, b.data, x, y, W, H)) {
            if (++n >= BLOCK_PIXELS) break;
          }
        }
      }
      if (n >= BLOCK_PIXELS) {
        changed++;
        minX = Math.min(minX, bx * BLOCK); minY = Math.min(minY, by * BLOCK);
        maxX = Math.max(maxX, xEnd); maxY = Math.max(maxY, yEnd);
      }
    }
  }
  return {
    changed: changed >= CHANGED_BLOCKS, changedBlocks: changed, blocks: cols * rows,
    box: changed ? { x: minX / W, y: minY / H, width: (maxX - minX) / W, height: (maxY - minY) / H } : null,
  };
}

// ---------- text ----------

/** One line of visible text, as it is compared: whitespace collapsed. */
export const normLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Lines that are new, and lines that are gone. Order does not count — a
    paragraph that moved is the picture's business — but a line that now
    appears twice where it appeared once does. */
export function textDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const count = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs.map(normLine).filter(Boolean)) m.set(x, (m.get(x) ?? 0) + 1); return m; };
  const a = count(before), b = count(after);
  const added: string[] = [], removed: string[] = [];
  for (const [line, n] of b) for (let i = a.get(line) ?? 0; i < n; i++) added.push(line);
  for (const [line, n] of a) for (let i = b.get(line) ?? 0; i < n; i++) removed.push(line);
  return { added, removed };
}

// ---------- steps ----------

/** What a journey's step looked like when it ended: kept for every run, and
    for the run that was accepted as normal. */
export type Snapshot = {
  n: number;
  scenario: string | null;
  intent: string;
  result: "pass" | "fail" | null;
  url: string;
  /** The page's visible text, one line per block, masked parts left out. */
  text: string[];
  /** The picture, relative to the folder the snapshot is kept in. */
  shot: string | null;
  /** Masked regions, in the picture's pixels. */
  masks: Rect[];
  width: number;
  height: number;
  /** Milliseconds into the session, the same clock as its video. */
  t: number;
  tEnd: number | null;
};

export type ChangeKind = "result" | "text" | "picture" | "new" | "missing";
export type StepChange = {
  /** The step in this run (or, for a missing one, in the accepted run). */
  n: number;
  scenario: string | null;
  intent: string;
  kinds: ChangeKind[];
  result?: { before: Snapshot["result"]; after: Snapshot["result"] };
  text?: { added: string[]; removed: string[] };
  picture?: { changedBlocks: number; box: PictureDiff["box"] };
  /** The accepted step's picture and this run's, relative to their folders. */
  before: string | null;
  after: string | null;
  t: number | null;
  tEnd: number | null;
};

/** Steps are matched by what they say they do, not by number: a step added
    in the middle must not make every later step "change". */
export const keyOf = (s: Pick<Snapshot, "scenario" | "intent">) => `${s.scenario ?? ""}\u0000${normLine(s.intent)}`;

export function matchSteps(before: Snapshot[], after: Snapshot[]): { pairs: [Snapshot | null, Snapshot | null][] } {
  const pool = new Map<string, Snapshot[]>();
  for (const s of before) { const k = keyOf(s); pool.set(k, [...(pool.get(k) ?? []), s]); }
  const used = new Set<Snapshot>();
  const pairs: [Snapshot | null, Snapshot | null][] = [];
  for (const s of after) {
    const b = pool.get(keyOf(s))?.shift() ?? null;
    if (b) used.add(b);
    pairs.push([b, s]);
  }
  for (const s of before) if (!used.has(s)) pairs.push([s, null]);
  return { pairs };
}

/**
 * Every step that changed, in the order they ran. `load` decodes a step's
 * picture (side "before" from the accepted run, "after" from this one), or
 * returns null when there is none.
 */
export function compareSnapshots(before: Snapshot[], after: Snapshot[], load: (s: Snapshot, side: "before" | "after") => Picture | null): StepChange[] {
  const out: StepChange[] = [];
  for (const [b, a] of matchSteps(before, after).pairs) {
    const s = (a ?? b)!;
    const change: StepChange = { n: s.n, scenario: s.scenario, intent: s.intent, kinds: [], before: b?.shot ?? null, after: a?.shot ?? null, t: a?.t ?? null, tEnd: a?.tEnd ?? null };
    if (!b) change.kinds.push("new");
    else if (!a) change.kinds.push("missing");
    else {
      if (b.result !== a.result) { change.kinds.push("result"); change.result = { before: b.result, after: a.result }; }
      const td = textDiff(b.text, a.text);
      if (td.added.length || td.removed.length) { change.kinds.push("text"); change.text = { added: td.added.slice(0, 20), removed: td.removed.slice(0, 20) }; }
      const pb = load(b, "before"), pa = load(a, "after");
      if (pb && pa) {
        const pd = pictureDiff(pb, pa, [...b.masks, ...a.masks]);
        if (pd.changed) { change.kinds.push("picture"); change.picture = { changedBlocks: pd.changedBlocks, box: pd.box }; }
      } else if (!!pb !== !!pa) { change.kinds.push("picture"); change.picture = { changedBlocks: 0, box: null }; }
    }
    if (change.kinds.length) out.push(change);
  }
  return out;
}

// ---------- the verdict ----------

export type JourneyStatus = "unchanged" | "changed" | "failed";

/** Failed beats changed: a journey that could not finish, or a step that
    did not pass, is the thing to look at first. */
export function verdict(o: { error: string | null; steps: Pick<Snapshot, "result">[]; changes: StepChange[] }): JourneyStatus {
  if (o.error || !o.steps.length || o.steps.some((s) => s.result !== "pass")) return "failed";
  return o.changes.length ? "changed" : "unchanged";
}

/** What changed at one step, in a few words a person reads. */
export function describeChange(c: StepChange): string {
  const parts: string[] = [];
  if (c.kinds.includes("new")) parts.push("a new step");
  if (c.kinds.includes("missing")) parts.push("this step did not run");
  if (c.result) parts.push(c.result.after === "fail" ? "it failed, and passed before" : c.result.after === "pass" ? "it passes now, and failed before" : "it did not finish");
  if (c.kinds.includes("text")) parts.push("the text changed");
  if (c.kinds.includes("picture")) parts.push("the picture changed");
  const s = parts.join(", ");
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}
