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
  /** True if the folder was made for this server, and goes with it */
  private readonly temporary: boolean;
  private server: Server | null = null;
  private port = 0;
  /** Sizes of the bodies that the server sent, to see that responses stay small */
  readonly responseSizes: number[] = [];
  /** A name and a password as "name:password". When set, a request without them is turned away. */
  credentials: string | null = null;
  /** Told about every request that was answered */
  onResponse: ((method: string, path: string, status: number, bytes: number) => void) | null = null;

  /** @param root a folder of repositories to serve. Without it the server makes one, and removes it when it stops. */
  constructor(root?: string) {
    this.temporary = root === undefined;
    this.root = root ?? mkdtempSync(path.join(tmpdir(), "piecemeal-"));
  }

  /** Runs git in a folder under the root and returns what it prints. */
  git(dir: string, ...args: string[]): string {
    return this.run(dir, args);
  }

  private run(dir: string, args: string[], extra: { env?: Record<string, string>; input?: string | Buffer } = {}): string {
    return execFileSync("git", args, {
      cwd: path.join(this.root, dir),
      encoding: "utf8",
      input: extra.input,
      // What git says beside its result is kept for the message of an error, not printed
      stdio: [extra.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        ...extra.env,
      },
    }).trim();
  }

  /**
   * Commits changes straight into the main branch of a repository of the
   * server, with no files on a disk in between: a path with content is
   * written, and a path with null is removed.
   *
   * This plays a computer that tells "a.md" from "A.md". The disk of most
   * computers does not, so a clone there can neither hold both names nor
   * show git that a name changed its capital letters.
   */
  commit(name: string, changes: Record<string, string | Buffer | null>, message: string): void {
    const dir = `${name}.git`;
    const index = path.join(this.root, `${name}.index`);
    rmSync(index, { force: true });
    const git = (args: string[], input?: string | Buffer): string =>
      // Git on a Mac would take the two spellings of a name for one, and put together the letters of a name it is given
      this.run(dir, ["-c", "core.ignorecase=false", "-c", "core.precomposeunicode=false", ...args], { env: { GIT_INDEX_FILE: index }, input });
    let parent: string | null = null;
    try {
      parent = git(["rev-parse", "--verify", "-q", "refs/heads/main"]);
      git(["read-tree", parent]);
    } catch {
      // No commit yet
    }
    for (const [file, content] of Object.entries(changes)) {
      if (content === null) {
        // A line with mode 0 takes the path out, and unlike --remove needs no files on a disk
        git(["update-index", "--index-info"], `0 ${"0".repeat(40)}\t${file}\n`);
      } else {
        const oid = git(["hash-object", "-w", "--stdin"], content);
        git(["update-index", "--add", "--cacheinfo", `100644,${oid},${file}`]);
      }
    }
    const tree = git(["write-tree"]);
    const commit = git(["commit-tree", tree, ...(parent === null ? [] : ["-p", parent]), "-m", message]);
    git(["update-ref", "refs/heads/main", commit]);
    rmSync(index, { force: true });
  }

  /**
   * Makes an empty repository that the server serves, and returns its address.
   * @param tellsSizes true for a server that tells the sizes of objects when asked, which git can but few hosts let it
   */
  createRepo(name: string, tellsSizes = false): string {
    this.git(".", "init", "-q", "--bare", "-b", "main", `${name}.git`);
    const dir = `${name}.git`;
    if (tellsSizes) {
      this.git(dir, "config", "transfer.advertiseObjectInfo", "true");
    }
    this.git(dir, "config", "http.receivepack", "true");
    this.git(dir, "config", "uploadpack.allowFilter", "true");
    this.git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
    return `http://127.0.0.1:${this.port}/${name}.git`;
  }

  /** Clones a repository of the server with the real git, to act as a computer. */
  cloneWithGit(name: string, into: string): void {
    this.git(".", "clone", "-q", path.join(this.root, `${name}.git`), into);
  }

  /** @param host "0.0.0.0" to let other devices of the network in, such as a phone */
  async start(host = "127.0.0.1", port = 0): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const body = Buffer.concat(chunks);
        if (this.credentials !== null && request.headers.authorization !== `Basic ${Buffer.from(this.credentials).toString("base64")}`) {
          this.onResponse?.(request.method ?? "GET", url.pathname, 401, 0);
          response.statusCode = 401;
          response.setHeader("WWW-Authenticate", 'Basic realm="git"');
          response.end();
          return;
        }
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
          this.onResponse?.(request.method ?? "GET", url.pathname, status, payload.length);
          response.statusCode = status;
          response.end(payload);
        });
        child.stdin.end(body);
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(port, host, () => resolve());
    });
    const address = this.server.address();
    this.port = typeof address === "object" && address !== null ? address.port : 0;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    if (this.temporary) {
      rmSync(this.root, { recursive: true, force: true });
    }
  }
}
