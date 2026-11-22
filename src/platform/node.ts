import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { type FileStat, type Fs } from "../git/fs.ts";
import { type Http } from "../git/http.ts";

/** The files of a folder on disk. For the tests, and for trying the sync from a terminal. */
export class NodeFs implements Fs {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private abs(p: string): string {
    return path.join(this.root, p);
  }

  async read(p: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fsp.readFile(this.abs(p)));
    } catch {
      return null;
    }
  }

  async write(p: string, data: Uint8Array): Promise<void> {
    await fsp.mkdir(path.dirname(this.abs(p)), { recursive: true });
    await fsp.writeFile(this.abs(p), data);
  }

  async append(p: string, data: Uint8Array): Promise<void> {
    await fsp.mkdir(path.dirname(this.abs(p)), { recursive: true });
    await fsp.appendFile(this.abs(p), data);
  }

  async remove(p: string): Promise<void> {
    await fsp.rm(this.abs(p), { force: true });
  }

  async removeDir(p: string): Promise<void> {
    try {
      await fsp.rmdir(this.abs(p));
    } catch {
      // Not empty, not a folder, or not there
    }
  }

  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(this.abs(from), this.abs(to));
  }

  async stat(p: string): Promise<FileStat | null> {
    try {
      const st = await fsp.stat(this.abs(p));
      return st.isFile() ? { size: st.size, mtime: Math.floor(st.mtimeMs) } : null;
    } catch {
      return null;
    }
  }

  async isDir(p: string): Promise<boolean> {
    try {
      return (await fsp.stat(this.abs(p))).isDirectory();
    } catch {
      return false;
    }
  }

  async list(dir: string): Promise<{ files: string[]; dirs: string[] }> {
    const out = { files: [] as string[], dirs: [] as string[] };
    let entries;
    try {
      entries = await fsp.readdir(this.abs(dir), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        out.dirs.push(entry.name);
      } else if (entry.isFile()) {
        out.files.push(entry.name);
      }
    }
    return out;
  }
}

export const nodeHttp: Http = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body as Uint8Array<ArrayBuffer> | undefined,
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return {
    status: response.status,
    headers,
    body: new Uint8Array(await response.arrayBuffer()),
  };
};
