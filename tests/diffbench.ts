// How long a comparison takes, and how much it holds:  node tests/diffbench.ts
import { diffCounts, diffRows, diffText } from "../src/git/merge.ts";
const enc = new TextEncoder();
let seed = 7;
const random = (): number => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const line = (i: number): string => `line ${i} ${(i * 2654435761 >>> 0).toString(36)} some words of a note, 한글도 조금\n`;
const text = (count: number, changes: number, tag: string): string => {
  const out: string[] = [];
  const at = new Set<number>();
  if (changes >= count) { for (let i = 0; i < count; i++) at.add(i); }
  while (at.size < changes) at.add(Math.floor(random() * count));
  for (let i = 0; i < count; i++) out.push(at.has(i) ? `${tag} ${line(i)}` : line(i));
  return out.join("");
};
const run = (what: string, before: string, after: string): void => {
  const a = enc.encode(before);
  const b = enc.encode(after);
  globalThis.gc?.();
  const heap = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
  let peak = 0;
  const started = performance.now();
  const diffed = diffText(a, b);
  const ms = performance.now() - started;
  peak = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers - heap;
  const t2 = performance.now();
  let rows = 0;
  if (diffed !== null) { const it = diffRows(diffed); for (let i = 0; i < 200 && it.next().done !== true; i++) rows++; }
  console.log(`${what.padEnd(46)} ${(a.length / 1e6).toFixed(1)} MB  compare ${ms.toFixed(0).padStart(5)} ms  first ${rows} rows ${(performance.now() - t2).toFixed(1)} ms  held ${(peak / 1e6).toFixed(0).padStart(4)} MB  ${diffed === null ? "not compared" : JSON.stringify(diffCounts(diffed)) + (diffed.coarse ? " coarse" : "")}`);
};
const base = text(100_000, 0, "");
run("a note of 2 kB, 5 lines changed", text(40, 0, ""), text(40, 5, "x"));
run("5 MB, 100 lines changed", base, text(100_000, 100, "x"));
run("5 MB, 1500 lines changed", base, text(100_000, 1500, "x"));
run("5 MB, 6000 lines changed (too far apart)", base, text(100_000, 6000, "x"));
run("5 MB, two other texts", base, text(100_000, 100_000, "y"));
run("5 MB against nothing (a new file)", "", base);
