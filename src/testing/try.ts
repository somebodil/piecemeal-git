// Syncs a folder on disk with a repository, to try the sync outside Obsidian:
//   TOKEN=... node src/testing/try.ts <address> <folder> [--read-only]
// It prints what happened, how many requests it took, the largest response
// and the most memory the process held.
import { mkdirSync } from "node:fs";
import { githubLargeBlob, githubSizes, parseGitHub } from "../git/github.ts";
import { type Http } from "../git/http.ts";
import { remoteOf } from "../git/protocol.ts";
import { sync } from "../git/sync.ts";
import { nodeHttp, NodeFs } from "../platform/node.ts";

const [url, dir, flag] = process.argv.slice(2);
if (url === undefined || dir === undefined) {
  console.error("usage: node src/testing/try.ts <address> <folder> [--read-only]");
  process.exit(2);
}
const token = process.env["TOKEN"];
const readOnly = flag === "--read-only";
mkdirSync(dir, { recursive: true });

let requests = 0;
let largest = 0;
let received = 0;
let peak = 0;
const sample = (): void => {
  peak = Math.max(peak, process.memoryUsage().rss);
};
const timer = setInterval(sample, 20);
const http: Http = async (request) => {
  if (readOnly && request.url.endsWith("/git-receive-pack")) {
    throw new Error("read-only: this sync would have sent something");
  }
  const response = await nodeHttp(request);
  requests += 1;
  largest = Math.max(largest, response.body.length);
  received += response.body.length;
  sample();
  return response;
};

const fs = new NodeFs(dir);
const remote = remoteOf(url, token);
const github = parseGitHub(remote.url);
const MB = 1024 * 1024;
const started = Date.now();
const result = await sync({
  fs,
  http,
  remote,
  storeDir: ".piecemeal",
  author: { name: "Piecemeal Git", email: "piecemeal@example.com" },
  message: (when) => `vault sync ${when.toISOString()}`,
  composeNames: process.platform === "darwin",
  maxFileBytes: 20 * MB,
  batchBytes: 4 * MB,
  sizes: github === null ? undefined : githubSizes(http, github, token),
  largeBlob: github === null ? undefined : githubLargeBlob(http, fs, github, token, 4 * MB),
  log: (message) => console.log(message),
});
clearInterval(timer);
sample();
const mb = (n: number): string => `${(n / MB).toFixed(1)} MB`;
console.log(
  JSON.stringify(
    {
      commit: result.commit,
      downloaded: result.downloaded.length,
      uploaded: result.uploaded.length,
      deletedHere: result.deletedHere.length,
      deletedThere: result.deletedThere.length,
      merged: result.merged,
      conflicts: result.conflicts,
      tooLargeIgnored: result.tooLargeIgnored,
      tooLargeChanged: result.tooLargeChanged,
      tooLargeThere: result.tooLargeThere,
      sameName: result.sameName,
      busy: result.busy,
      seconds: (Date.now() - started) / 1000,
      requests,
      received: mb(received),
      largestResponse: mb(largest),
      peakMemory: mb(peak),
    },
    null,
    1,
  ),
);
