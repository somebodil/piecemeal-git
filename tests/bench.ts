// Times the sync on a vault of many notes against the git server of the tests:
//   node tests/bench.ts [notes]
// It prints how long each kind of sync took, and how many requests it made.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type Http } from "../src/git/http.ts";
import { sync, type SyncResult } from "../src/git/sync.ts";
import { nodeHttp, NodeFs } from "./node.ts";
import { TestServer } from "./server.ts";

const count = Number(process.argv[2] ?? 3000);
const server = new TestServer();
await server.start();
const url = server.createRepo("bench", true);
server.cloneWithGit("bench", "bench-pc");
const pcDir = path.join(server.root, "bench-pc");
const phoneDir = mkdtempSync(path.join(tmpdir(), "piecemeal-bench-"));

/** A text that is like no other, of about `bytes` bytes */
const text = (seed: number, bytes: number): string => {
  let out = `# Note ${seed}\n\n`;
  let x = seed * 2654435761;
  while (out.length < bytes) {
    x = (x * 1103515245 + 12345) >>> 0;
    out += `${x.toString(36)} ${(x >>> 7).toString(36)} some words of a line that is like many others\n`;
  }
  return out;
};
const name = (i: number): string => `folder ${i % 40}/sub ${i % 7}/노트 ${i}.md`;
for (let i = 0; i < count; i++) {
  const file = path.join(pcDir, name(i));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text(i, 500 + ((i * 37) % 4000)));
}
for (let i = 0; i < 20; i++) {
  mkdirSync(path.join(pcDir, "Attachments"), { recursive: true });
  writeFileSync(path.join(pcDir, "Attachments", `image ${i}.png`), Buffer.from(Array.from({ length: 300_000 }, (_, k) => (k * 31 + i * 17 + ((k * k) >>> 3)) & 255)));
}
server.git("bench-pc", "add", "-A");
server.git("bench-pc", "commit", "-q", "-m", "many notes");
server.git("bench-pc", "push", "-q", "origin", "HEAD:main");

let requests = 0;
const http: Http = async (request) => {
  requests += 1;
  return nodeHttp(request);
};
let clock = Date.parse("2026-01-01T00:00:00Z");
const MB = 1024 * 1024;
const run = async (what: string): Promise<SyncResult> => {
  requests = 0;
  const cpu = process.cpuUsage();
  const started = performance.now();
  const result = await sync({
    fs: new NodeFs(phoneDir),
    http,
    remote: { url },
    storeDir: ".piecemeal",
    author: { name: "Bench", email: "bench@example.com" },
    message: () => "from the bench",
    maxFileBytes: 20 * MB,
    batchBytes: 4 * MB,
  });
  const ms = performance.now() - started;
  const used = process.cpuUsage(cpu);
  console.log(
    `${what.padEnd(34)} ${ms.toFixed(0).padStart(6)} ms  cpu ${((used.user + used.system) / 1000).toFixed(0).padStart(6)} ms  ${String(requests).padStart(3)} requests  taken ${result.downloaded.length} sent ${result.uploaded.length}`,
  );
  return result;
};
const writePhone = (file: string, content: string): void => {
  const full = path.join(phoneDir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  clock += 60_000;
  utimesSync(full, clock / 1000, clock / 1000);
};

await run(`first sync of ${count} notes`);
await run("nothing to do");
await run("nothing to do, again");
for (let i = 0; i < 20; i++) {
  writePhone(name(i * 50), text(i + 9_000_000, 2000));
}
await run("20 notes changed here");
for (let i = 0; i < 20; i++) {
  writeFileSync(path.join(pcDir, name(i * 50 + 1)), text(i + 8_000_000, 2000));
}
server.git("bench-pc", "pull", "-q", "origin", "main");
server.git("bench-pc", "add", "-A");
server.git("bench-pc", "commit", "-q", "-m", "20 notes");
server.git("bench-pc", "push", "-q", "origin", "HEAD:main");
await run("20 notes changed there");
for (let i = 0; i < 300; i++) {
  writePhone(`new/노트 ${i}.md`, text(i + 7_000_000, 3000));
}
await run("300 new notes here");
await run("nothing to do, at the end");

await server.stop();
rmSync(phoneDir, { recursive: true, force: true });
