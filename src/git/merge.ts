import { encode } from "./bytes.ts";

/** A run of lines of the old text, and the run of lines of the new text that took its place. Ends are not included. */
export interface Change {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/**
 * The lines of the old text that a change can be said to touch. Lines that
 * are added between two lines like the first or the last of them, and lines
 * that are taken out from among lines like them, can be told as a change a
 * few lines further up or down just as well. `git` may tell it the other way.
 */
function reach(change: Change, before: Change | undefined, after: Change | undefined, a: number[], b: number[]): [number, number] {
  let low = change.oldStart;
  let high = change.oldEnd;
  const floor = before?.oldEnd ?? 0;
  const ceiling = after?.oldStart ?? a.length;
  if (change.oldStart === change.oldEnd) {
    for (let s = 0; low > floor && b[change.newStart - s - 1] === b[change.newEnd - s - 1]; s++) {
      low--;
    }
    for (let s = 0; high < ceiling && b[change.newEnd + s] === b[change.newStart + s]; s++) {
      high++;
    }
  } else if (change.newStart === change.newEnd) {
    for (let s = 0; low > floor && a[change.oldStart - s - 1] === a[change.oldEnd - s - 1]; s++) {
      low--;
    }
    for (let s = 0; high < ceiling && a[change.oldEnd + s] === a[change.oldStart + s]; s++) {
      high++;
    }
  }
  return [low, high];
}

/** A text with more lines than this is not merged */
const MAX_LINES = 200_000;
/** Two texts that differ in more lines than this are not compared to the end */
const MAX_DISTANCE = 4_000;

/** The lines of a text, each with the end of line that it has. Null if it is not text. */
function lines(data: Uint8Array): string[] | null {
  // As git has it: what holds a zero byte is not text
  if (data.includes(0)) {
    return null;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return null;
  }
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    if (end < 0) {
      break;
    }
    out.push(text.slice(start, end + 1));
    start = end + 1;
  }
  if (start < text.length) {
    out.push(text.slice(start));
  }
  return out.length > MAX_LINES ? null : out;
}

/**
 * What changed from one list of lines to another, by the shortest way to
 * turn the first into the second (Myers). Null if they are too far apart.
 */
function diff(a: ArrayLike<number>, b: ArrayLike<number>, maxDistance = MAX_DISTANCE): Change[] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n === 0 && m === 0) {
    return [];
  }
  if (n === 0 || m === 0) {
    return [{ oldStart: head, oldEnd: head + n, newStart: head, newEnd: head + m }];
  }

  // They differ in as many lines at least as the one is longer than the other
  if (Math.abs(n - m) > maxDistance) {
    return null;
  }
  // How far each diagonal gets with d changes, for every d up to the one that reaches the end.
  // With d changes only the diagonals from -d to d are reached, and only those are kept of each
  // step: twice the cap of them would be kept otherwise, which is most of what a comparison holds.
  const max = Math.min(n + m, maxDistance);
  const reached: Int32Array[] = [];
  const furthest = new Int32Array(2 * max + 2);
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && furthest[max + k - 1] < furthest[max + k + 1]) ? furthest[max + k + 1] : furthest[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[head + x] === b[head + y]) {
        x++;
        y++;
      }
      furthest[max + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    reached.push(furthest.slice(max - d, max + d + 1));
  }
  if (found < 0) {
    return null;
  }

  // Back from the end to the start, one change at a time
  const changes: Change[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    // Of the step before, the diagonal k is at k + d - 1
    const before = reached[d - 1];
    const at = d - 1;
    const k = x - y;
    const down = k === -d || (k !== d && before[at + k - 1] < before[at + k + 1]);
    const fromK = down ? k + 1 : k - 1;
    const fromX = before[at + fromK];
    const fromY = fromX - fromK;
    // A change, and after it the lines that are the same on both sides
    const atX = down ? fromX : fromX + 1;
    const atY = down ? fromY + 1 : fromY;
    const last = changes[changes.length - 1];
    if (last !== undefined && last.oldStart === head + atX && last.newStart === head + atY) {
      last.oldStart = head + fromX;
      last.newStart = head + fromY;
    } else {
      changes.push({ oldStart: head + fromX, oldEnd: head + atX, newStart: head + fromY, newEnd: head + atY });
    }
    x = fromX;
    y = fromY;
  }
  return changes.reverse();
}

/** True for what git takes for a text, and this can read as one. */
export function isText(data: Uint8Array): boolean {
  return lines(data) !== null;
}

/**
 * Puts together what two sides made of one text, line by line, as
 * `git merge-file` does. Null if it cannot be done without a person: a side
 * is not text, or both changed the same lines or lines next to each other.
 */
export function merge3(base: Uint8Array, ours: Uint8Array, theirs: Uint8Array): Uint8Array | null {
  const baseLines = lines(base);
  const ourLines = lines(ours);
  const theirLines = lines(theirs);
  if (baseLines === null || ourLines === null || theirLines === null) {
    return null;
  }
  // A number for each line that is there, so that two lines are compared in one step
  const numbers = new Map<string, number>();
  const numbered = (list: string[]): number[] =>
    list.map((line) => {
      let number = numbers.get(line);
      if (number === undefined) {
        number = numbers.size;
        numbers.set(line, number);
      }
      return number;
    });
  const b = numbered(baseLines);
  const o = numbered(ourLines);
  const t = numbered(theirLines);
  const mine = diff(b, o);
  const yours = diff(b, t);
  if (mine === null || yours === null) {
    return null;
  }

  const out: string[] = [];
  let at = 0;
  let i = 0;
  let j = 0;
  const take = (change: Change, from: string[]): void => {
    out.push(...baseLines.slice(at, change.oldStart), ...from.slice(change.newStart, change.newEnd));
    at = change.oldEnd;
  };
  while (i < mine.length || j < yours.length) {
    const m = mine[i];
    const y = yours[j];
    // One change comes before another if a line that neither touches lies between them
    const mReach = m === undefined ? null : reach(m, mine[i - 1], mine[i + 1], b, o);
    const yReach = y === undefined ? null : reach(y, yours[j - 1], yours[j + 1], b, t);
    if (yReach === null || (mReach !== null && mReach[1] < yReach[0])) {
      take(m, ourLines);
      i++;
    } else if (mReach === null || yReach[1] < mReach[0]) {
      take(y, theirLines);
      j++;
    } else if (m === undefined || y === undefined) {
      return null;
    } else {
      // The two changes meet. That is fine only if they are one and the same.
      const alike =
        m.oldStart === y.oldStart &&
        m.oldEnd === y.oldEnd &&
        m.newEnd - m.newStart === y.newEnd - y.newStart &&
        o.slice(m.newStart, m.newEnd).every((line, n) => line === t[y.newStart + n]);
      if (!alike) {
        return null;
      }
      take(m, ourLines);
      i++;
      j++;
    }
  }
  out.push(...baseLines.slice(at));
  return encode(out.join(""));
}

/** Two texts, line by line, and what changed from the first to the second. */
export interface TextDiff {
  /** The lines of each text, each with the end of line that it has */
  before: string[];
  after: string[];
  /** The runs of lines that changed, from the top of the texts down */
  changes: Change[];
  /**
   * True if a part of the two is too far apart to be compared line by line.
   * That part is one change: all that lies between what the two start with
   * and what they end with alike there.
   */
  coarse: boolean;
}

/** Two runs of lines that differ in more lines than this are not compared to the end by themselves */
const DIFF_DISTANCE = 1000;

/**
 * The lines that both texts have exactly once, and in the same order: the
 * longest row of them. Whatever else changed, these are the same line on
 * both sides, so the texts can be compared piece by piece between them, as
 * `git diff --patience` does.
 *
 * @param kinds how many different lines there are, each one a number below it
 * @returns where each such line is in the one text and in the other, from the top down
 */
function anchors(a: Int32Array, b: Int32Array, kinds: number): [number, number][] {
  const inA = new Int32Array(kinds);
  const inB = new Int32Array(kinds);
  const whereB = new Int32Array(kinds);
  for (let i = 0; i < a.length; i++) {
    inA[a[i]]++;
  }
  for (let j = 0; j < b.length; j++) {
    inB[b[j]]++;
    whereB[b[j]] = j;
  }
  // The lines that both have once, in the order of the one text, by where they are in the other
  const fromA: number[] = [];
  const fromB: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (inA[a[i]] === 1 && inB[a[i]] === 1) {
      fromA.push(i);
      fromB.push(whereB[a[i]]);
    }
  }
  // The longest row of them that goes down in the other text too. `ends[n]` is the pair that a
  // row of n + 1 pairs ends with where it ends as high up as it can, and `before` the pair before each.
  const ends: number[] = [];
  const before = new Int32Array(fromB.length);
  for (let p = 0; p < fromB.length; p++) {
    let low = 0;
    let high = ends.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (fromB[ends[middle]] < fromB[p]) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    before[p] = low === 0 ? -1 : ends[low - 1];
    ends[low] = p;
  }
  const row: [number, number][] = [];
  for (let p = ends.length === 0 ? -1 : ends[ends.length - 1]; p >= 0; p = before[p]) {
    row.push([fromA[p], fromB[p]]);
  }
  return row.reverse();
}

/**
 * What changed from one list of lines to another. Two that are far apart
 * are compared piece by piece, between the lines that both have once. A
 * piece that is too far apart by itself is told as one change, and
 * `coarse` says that there is such a piece.
 */
function compare(a: Int32Array, b: Int32Array, kinds: number): { changes: Change[]; coarse: boolean } {
  const direct = diff(a, b, DIFF_DISTANCE);
  if (direct !== null) {
    return { changes: direct, coarse: false };
  }
  const changes: Change[] = [];
  let coarse = false;
  let oldAt = 0;
  let newAt = 0;
  const piece = (oldEnd: number, newEnd: number): void => {
    if (oldEnd === oldAt && newEnd === newAt) {
      return;
    }
    const part = diff(a.subarray(oldAt, oldEnd), b.subarray(newAt, newEnd), DIFF_DISTANCE);
    if (part === null) {
      // Too far apart also by itself: all that lies between what the two start and end with alike
      let head = 0;
      while (oldAt + head < oldEnd && newAt + head < newEnd && a[oldAt + head] === b[newAt + head]) {
        head++;
      }
      let tail = 0;
      while (oldEnd - tail > oldAt + head && newEnd - tail > newAt + head && a[oldEnd - 1 - tail] === b[newEnd - 1 - tail]) {
        tail++;
      }
      changes.push({ oldStart: oldAt + head, oldEnd: oldEnd - tail, newStart: newAt + head, newEnd: newEnd - tail });
      coarse = true;
      return;
    }
    for (const change of part) {
      changes.push({ oldStart: change.oldStart + oldAt, oldEnd: change.oldEnd + oldAt, newStart: change.newStart + newAt, newEnd: change.newEnd + newAt });
    }
  };
  for (const [inOld, inNew] of anchors(a, b, kinds)) {
    piece(inOld, inNew);
    oldAt = inOld + 1;
    newAt = inNew + 1;
  }
  piece(a.length, b.length);
  // Two changes that touch are one
  const joined: Change[] = [];
  for (const change of changes) {
    const last = joined[joined.length - 1];
    if (last !== undefined && last.oldEnd === change.oldStart && last.newEnd === change.newStart) {
      last.oldEnd = change.oldEnd;
      last.newEnd = change.newEnd;
    } else {
      joined.push(change);
    }
  }
  return { changes: joined, coarse };
}

/**
 * Compares two texts line by line, as `git diff` does. Null if one of them
 * is not a text, or has more lines than are compared.
 */
export function diffText(before: Uint8Array, after: Uint8Array): TextDiff | null {
  const a = lines(before);
  const b = lines(after);
  if (a === null || b === null) {
    return null;
  }
  // A number for each line that is there, so that two lines are compared in one step
  const numbers = new Map<string, number>();
  const numbered = (list: string[]): Int32Array => {
    const out = new Int32Array(list.length);
    for (let i = 0; i < list.length; i++) {
      let number = numbers.get(list[i]);
      if (number === undefined) {
        number = numbers.size;
        numbers.set(list[i], number);
      }
      out[i] = number;
    }
    return out;
  };
  const x = numbered(a);
  const y = numbered(b);
  return { before: a, after: b, ...compare(x, y, numbers.size) };
}

/**
 * The text that comes of a comparison when, for each change, the lines of
 * the one side are kept, or those of the other, or both.
 *
 * @param choices for each change of the comparison: 0 for the lines of the
 *   text before, 1 for those of the text after, 2 for both, the ones before first
 */
export function chosenText(diffed: TextDiff, choices: ArrayLike<number>): string {
  const { before, after, changes } = diffed;
  const out: string[] = [];
  let at = 0;
  changes.forEach((change, i) => {
    for (let line = at; line < change.oldStart; line++) {
      out.push(before[line]);
    }
    if (choices[i] !== 1) {
      for (let line = change.oldStart; line < change.oldEnd; line++) {
        out.push(before[line]);
      }
    }
    if (choices[i] === 1 || choices[i] === 2) {
      for (let line = change.newStart; line < change.newEnd; line++) {
        out.push(after[line]);
      }
    }
    at = change.oldEnd;
  });
  for (let line = at; line < before.length; line++) {
    out.push(before[line]);
  }
  // The last line of a text may have no end. Put before another line, it gets one, as that line has it.
  for (let i = 0; i < out.length - 1; i++) {
    if (!out[i].endsWith("\n")) {
      out[i] += out[i + 1].endsWith("\r\n") ? "\r\n" : "\n";
    }
  }
  return out.join("");
}

/** A line of a comparison as it is shown, or a run of lines that are the same on both sides and are not shown. */
export type DiffRow =
  /** `change` is which change of the comparison a line that was taken away or added belongs to, and null for a line that is the same */
  | { kind: "same" | "removed" | "added"; text: string; oldLine: number | null; newLine: number | null; change: number | null }
  /** `oldStart` and `newStart` are where the run starts in each text, and `count` how many lines it has */
  | { kind: "fold"; oldStart: number; newStart: number; count: number };

/**
 * The rows that show a comparison, from the top down: what changed, with a
 * few lines around each change, and a fold for every longer run of lines
 * that are the same. They are made one by one as they are asked for, so that
 * a long comparison costs no more than the part of it that is looked at.
 *
 * @param context how many lines that are the same are shown before and after a change
 */
export function* diffRows(diffed: TextDiff, context = 3): Generator<DiffRow> {
  const { before, after, changes } = diffed;
  let oldAt = 0;
  let newAt = 0;
  for (let i = 0; i <= changes.length; i++) {
    const change = changes[i];
    // The lines up to the change, or to the end, are the same on both sides
    const sameEnd = change === undefined ? before.length : change.oldStart;
    const count = sameEnd - oldAt;
    const lead = i === 0 ? 0 : Math.min(context, count);
    const trail = change === undefined ? 0 : Math.min(context, count - lead);
    yield* sameRows(before, oldAt, newAt, lead);
    if (count - lead - trail > 0) {
      yield { kind: "fold", oldStart: oldAt + lead, newStart: newAt + lead, count: count - lead - trail };
    }
    yield* sameRows(before, sameEnd - trail, newAt + count - trail, trail);
    oldAt = sameEnd;
    newAt += count;
    if (change === undefined) {
      break;
    }
    for (let line = change.oldStart; line < change.oldEnd; line++) {
      yield { kind: "removed", text: before[line], oldLine: line + 1, newLine: null, change: i };
    }
    for (let line = change.newStart; line < change.newEnd; line++) {
      yield { kind: "added", text: after[line], oldLine: null, newLine: line + 1, change: i };
    }
    oldAt = change.oldEnd;
    newAt = change.newEnd;
  }
}

/** Rows for lines that are the same on both sides: `count` of them from `oldStart` of the old text. */
export function* sameRows(before: string[], oldStart: number, newStart: number, count: number): Generator<DiffRow> {
  for (let i = 0; i < count; i++) {
    yield { kind: "same", text: before[oldStart + i], oldLine: oldStart + i + 1, newLine: newStart + i + 1, change: null };
  }
}

/** How many lines a comparison adds and takes away. */
export function diffCounts(diffed: TextDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const change of diffed.changes) {
    added += change.newEnd - change.newStart;
    removed += change.oldEnd - change.oldStart;
  }
  return { added, removed };
}
