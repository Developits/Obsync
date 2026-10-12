// Line-based three-way merge using Myers' O(ND) algorithm.
// Automatically merges non-overlapping edits. Flags overlapping collision regions.

export interface MergeResult {
  clean: boolean;
  text: string;
  conflicts: number;
}

interface Match {
  base: number;
  other: number;
}

function commonLines(a: string[], b: string[]): Match[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 1);

  let d = 0;
  outer: for (; d <= max; d++) {
    const snapshot = new Int32Array(v);
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      const idx = k + max;
      let x: number;
      if (k === -d || (k !== d && (v[idx - 1] ?? 0) < (v[idx + 1] ?? 0))) {
        x = v[idx + 1] ?? 0;
      } else {
        x = (v[idx - 1] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[idx] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  const matches: Match[] = [];
  let x = n;
  let y = m;
  for (let step = Math.min(d, trace.length - 1); step > 0; step--) {
    const prev = trace[step] as Int32Array;
    const k = x - y;
    const idx = k + max;
    let prevK: number;
    if (k === -step || (k !== step && (prev[idx - 1] ?? 0) < (prev[idx + 1] ?? 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prev[prevK + max] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      matches.push({ base: x, other: y });
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    matches.push({ base: x, other: y });
  }
  matches.reverse();
  return matches;
}

function matchMap(base: string[], side: string[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const m of commonLines(base, side)) {
    map.set(m.base, m.other);
  }
  return map;
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const stripped = text.endsWith("\n") ? text.slice(0, -1) : text;
  return stripped.split("\n");
}

function joinLines(lines: string[], sample: string): string {
  const text = lines.join("\n");
  return sample.endsWith("\n") || text === "" ? text + "\n" : text;
}

function sameLines(x: string[], y: string[]): boolean {
  return x.length === y.length && x.every((line, i) => line === y[i]);
}

function blockPrefix(...chunks: string[][]): string {
  for (const chunk of chunks) {
    for (const line of chunk) {
      const m = /^((?:\s*>\s?)+)/.exec(line);
      if (m) return m[1] as string;
    }
  }
  return "";
}

function emit(
  out: string[],
  baseChunk: string[],
  mineChunk: string[],
  theirsChunk: string[],
  mineLabel: string,
  theirsLabel: string,
  onConflict: () => void
): void {
  if (sameLines(mineChunk, theirsChunk)) {
    out.push(...mineChunk);
    return;
  }
  if (sameLines(mineChunk, baseChunk)) {
    out.push(...theirsChunk);
    return;
  }
  if (sameLines(theirsChunk, baseChunk)) {
    out.push(...mineChunk);
    return;
  }

  onConflict();
  const prefix = blockPrefix(mineChunk, theirsChunk, baseChunk);
  out.push(`${prefix}%% conflict: ${mineLabel} %%`);
  out.push(...mineChunk);
  out.push(`${prefix}%% conflict: ${theirsLabel} %%`);
  out.push(...theirsChunk);
  out.push(`${prefix}%% conflict: end %%`);
}

export function merge3(
  base: string,
  mine: string,
  theirs: string,
  mineLabel = "local",
  theirsLabel = "remote"
): MergeResult {
  if (mine === theirs) return { clean: true, text: mine, conflicts: 0 };
  if (base === mine) return { clean: true, text: theirs, conflicts: 0 };
  if (base === theirs) return { clean: true, text: mine, conflicts: 0 };

  const b = splitLines(base);
  const a = splitLines(mine);
  const c = splitLines(theirs);

  const inMine = matchMap(b, a);
  const inTheirs = matchMap(b, c);

  const out: string[] = [];
  let conflicts = 0;
  let ai = 0;
  let ci = 0;
  let regionStart = 0;

  for (let bi = 0; bi < b.length; bi++) {
    const ma = inMine.get(bi);
    const mc = inTheirs.get(bi);
    if (ma === undefined || mc === undefined || ma < ai || mc < ci) continue;

    emit(
      out,
      b.slice(regionStart, bi),
      a.slice(ai, ma),
      c.slice(ci, mc),
      mineLabel,
      theirsLabel,
      () => conflicts++
    );
    out.push(b[bi] as string);
    ai = ma + 1;
    ci = mc + 1;
    regionStart = bi + 1;
  }

  emit(
    out,
    b.slice(regionStart),
    a.slice(ai),
    c.slice(ci),
    mineLabel,
    theirsLabel,
    () => conflicts++
  );

  return { clean: conflicts === 0, text: joinLines(out, theirs || mine), conflicts };
}
