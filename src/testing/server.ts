import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * A git server on this machine: the `git http-backend` that comes with git,
 * behind a few lines of HTTP. The tests sync against it, and then ask the
 * real git what it thinks of the result.
 */
export class TestServer {
  readonly root: string;
  private server: Server | null = null;
  private port = 0;
  /** Sizes of the bodies that the server sent, to see that responses stay small */
  readonly responseSizes: number[] = [];

  constructor() {
    this.root = mkdtempSync(path.join(tmpdir(), "piecemeal-"));
  }

  /** Runs git in a folder under the root and returns what it prints. */
  git(dir: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd: path.join(this.root, dir),
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    }).trim();
  }

  /** Makes an empty repository that the server serves, and returns its address. */
  createRepo(name: string): string {
    this.git(".", "init", "-q", "--bare", "-b", "main", `${name}.git`);
    const dir = `${name}.git`;
    this.git(dir, "config", "http.receivepack", "true");
    this.git(dir, "config", "uploadpack.allowFilter", "true");
    this.git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
    return `http://127.0.0.1:${this.port}/${name}.git`;
  }

  /** Clones a repository of the server with the real git, to act as a computer. */
  cloneWithGit(name: string, into: string): void {
    this.git(".", "clone", "-q", path.join(this.root, `${name}.git`), into);
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const body = Buffer.concat(chunks);
        const child = spawn("git", ["http-backend"], {
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_PROJECT_ROOT: this.root,
            GIT_HTTP_EXPORT_ALL: "1",
            REQUEST_METHOD: request.method ?? "GET",
            PATH_INFO: decodeURIComponent(url.pathname),
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: request.headers["content-type"] ?? "",
            CONTENT_LENGTH: String(body.length),
            GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
          },
        });
        const out: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        child.on("close", () => {
          const all = Buffer.concat(out);
          const split = all.indexOf("\r\n\r\n");
          let status = 200;
          for (const line of all.subarray(0, split).toString().split("\r\n")) {
            const colon = line.indexOf(":");
            const name = line.slice(0, colon);
            const value = line.slice(colon + 1).trim();
            if (name.toLowerCase() === "status") {
              status = parseInt(value, 10);
            } else if (colon > 0) {
              response.setHeader(name, value);
            }
          }
          const payload = all.subarray(split + 4);
          this.responseSizes.push(payload.length);
          response.statusCode = status;
          response.end(payload);
        });
        child.stdin.end(body);
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    this.port = typeof address === "object" && address !== null ? address.port : 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    rmSync(this.root, { recursive: true, force: true });
  }
}
