import { encode } from "./bytes.ts";

/** A run of lines of the old text, and the run of lines of the new text that took its place. Ends are not included. */
interface Change {
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
function diff(a: number[], b: number[]): Change[] | null {
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

  // How far each diagonal gets with d changes, for every d up to the one that reaches the end
  const max = Math.min(n + m, MAX_DISTANCE);
  const reached: Int32Array[] = [];
  let furthest = new Int32Array(2 * max + 2);
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
    reached.push(furthest);
    furthest = furthest.slice();
  }
  if (found < 0) {
    return null;
  }

  // Back from the end to the start, one change at a time
  const changes: Change[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const before = reached[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && before[max + k - 1] < before[max + k + 1]);
    const fromK = down ? k + 1 : k - 1;
    const fromX = before[max + fromK];
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
