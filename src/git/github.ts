import { decode } from "./bytes.ts";
import { type Fs } from "./fs.ts";
import { type Http, type HttpResponse } from "./http.ts";
import { type LargeFile } from "./sync.ts";

/**
 * What GitHub offers beside the git protocol, and what makes two things
 * possible there that the protocol alone does not: to know the size of a
 * file before asking for it, and to get a large file in pieces.
 */
export interface GitHubRepo {
  owner: string;
  repo: string;
}

/** The owner and the name in an address of github.com, or null for another host. */
export function parseGitHub(url: string): GitHubRepo | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/*$/.exec(url);
  return match === null ? null : { owner: match[1]!, repo: match[2]! };
}

function headers(token: string | undefined, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { "X-GitHub-Api-Version": "2022-11-28", ...extra };
  if (token !== undefined && token !== "") {
    out["Authorization"] = `Bearer ${token}`;
  }
  return out;
}

interface TreeResponse {
  tree: { path: string; type: string; sha: string; size?: number }[];
  truncated: boolean;
}

/** The sizes of all files under a tree, by their ids. */
export function githubSizes(
  http: Http,
  where: GitHubRepo,
  token: string | undefined,
): (treeOid: string) => Promise<Map<string, number>> {
  const get = async (oid: string, recursive: boolean): Promise<TreeResponse> => {
    const response = await http({
      url: `https://api.github.com/repos/${where.owner}/${where.repo}/git/trees/${oid}${recursive ? "?recursive=1" : ""}`,
      method: "GET",
      headers: headers(token, { Accept: "application/vnd.github+json" }),
    });
    if (response.status !== 200) {
      throw new Error(`GitHub: the sizes of the files could not be read (${response.status})`);
    }
    return JSON.parse(decode(response.body)) as TreeResponse;
  };
  return async (treeOid) => {
    const sizes = new Map<string, number>();
    const todo = [treeOid];
    let recursive = true;
    while (todo.length > 0) {
      const listing = await get(todo.pop()!, recursive);
      if (recursive && listing.truncated) {
        // Too many files for one answer: ask folder by folder instead
        recursive = false;
        todo.push(treeOid);
        sizes.clear();
        continue;
      }
      for (const item of listing.tree) {
        if (item.type === "blob" && item.size !== undefined) {
          sizes.set(item.sha, item.size);
        } else if (item.type === "tree" && !recursive) {
          todo.push(item.sha);
        }
      }
    }
    return sizes;
  };
}

/**
 * Gets a file in pieces of `chunkBytes` and writes them to `path` one after
 * the other. The file is named by a commit and its path there, because the
 * address that takes a file by its id does not give pieces of a private
 * repository: it sends the whole file whatever range is asked for.
 */
export function githubLargeBlob(
  http: Http,
  fs: Fs,
  where: GitHubRepo,
  token: string | undefined,
  chunkBytes: number,
): (file: LargeFile, path: string) => Promise<boolean> {
  /** Set when the host has once answered a range with the whole file */
  let broken = false;
  return async (file, path) => {
    if (broken) {
      return false;
    }
    const part = `${path}.piecemeal-part`;
    await fs.remove(part);
    const encoded = file.path.split("/").map(encodeURIComponent).join("/");
    const extra: Record<string, string> = token !== undefined && token !== "" ? { Authorization: `token ${token}` } : {};
    for (let at = 0; at < file.size; at += chunkBytes) {
      const last = Math.min(at + chunkBytes, file.size) - 1;
      const response: HttpResponse = await http({
        url: `https://raw.githubusercontent.com/${where.owner}/${where.repo}/${file.commit}/${encoded}`,
        method: "GET",
        headers: { ...extra, Range: `bytes=${at}-${last}` },
      });
      if (response.status !== 206 || response.body.length !== last - at + 1) {
        broken = response.status === 200;
        await fs.remove(part);
        return false;
      }
      await fs.append(part, response.body);
    }
    const written = await fs.stat(part);
    if (written === null || written.size !== file.size) {
      await fs.remove(part);
      return false;
    }
    await fs.remove(path);
    await fs.rename(part, path);
    return true;
  };
}
