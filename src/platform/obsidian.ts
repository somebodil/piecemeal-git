import { type DataAdapter, requestUrl } from "obsidian";
import pako from "pako";
import { type FileStat, type Fs } from "../git/fs.ts";
import { type Http } from "../git/http.ts";

/** The bytes as a buffer of their own, which is what Obsidian takes. */
function toBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function parent(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * The files of the vault through the adapter, which sees hidden folders too
 * and is the same on a computer and on a phone.
 */
export class ObsidianFs implements Fs {
  private readonly adapter: DataAdapter;
  /** Folders that are known to exist, so that they are asked about once */
  private readonly made = new Set<string>([""]);
  /** Puts a file where the app keeps what a person deleted. False if it is not a file that the app does that for. */
  private readonly trash: ((path: string) => Promise<boolean>) | null;
  /** The size and time of a file as Obsidian has them in mind, or null for a file that it keeps no list of */
  private readonly inMind: ((path: string) => FileStat | null) | null;
  /** True for a file that `trash` puts where a person can get it back */
  private readonly kept: ((path: string) => boolean) | null;

  constructor(
    adapter: DataAdapter,
    trash?: (path: string) => Promise<boolean>,
    inMind?: (path: string) => FileStat | null,
    kept?: (path: string) => boolean,
  ) {
    this.adapter = adapter;
    this.trash = trash ?? null;
    this.inMind = inMind ?? null;
    this.kept = kept ?? null;
  }

  keeps(path: string): boolean {
    return this.trash !== null && (this.kept?.(path) ?? false);
  }

  quickStat(path: string): FileStat | null {
    return this.inMind?.(path) ?? null;
  }

  async discard(path: string): Promise<void> {
    if (this.trash === null || !(await this.trash(path))) {
      await this.remove(path);
    }
  }

  private async mkdirs(dir: string): Promise<void> {
    if (this.made.has(dir)) {
      return;
    }
    await this.mkdirs(parent(dir));
    if (!(await this.adapter.exists(dir))) {
      await this.adapter.mkdir(dir);
    }
    this.made.add(dir);
  }

  async read(path: string): Promise<Uint8Array | null> {
    // Asked once for a file that is there, which most are. Only a read that fails is asked why:
    // a file that is not there is no failure, and one that cannot be read must not pass for one that is gone.
    try {
      return new Uint8Array(await this.adapter.readBinary(path));
    } catch (error) {
      if (await this.adapter.exists(path)) {
        throw error;
      }
      return null;
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    await this.mkdirs(parent(path));
    await this.adapter.writeBinary(path, toBuffer(data));
  }

  async append(path: string, data: Uint8Array): Promise<void> {
    await this.mkdirs(parent(path));
    await this.adapter.appendBinary(path, toBuffer(data));
  }

  async remove(path: string): Promise<void> {
    if (await this.adapter.exists(path)) {
      await this.adapter.remove(path);
    }
  }

  async removeDir(dir: string): Promise<void> {
    if (dir === "" || (await this.adapter.stat(dir))?.type !== "folder") {
      return;
    }
    // The adapter of Android removes a folder with all that is in it, whatever
    // it is told, so the look into the folder is what keeps a file in it
    const listed = await this.adapter.list(dir);
    if (listed.files.length > 0 || listed.folders.length > 0) {
      return;
    }
    await this.adapter.rmdir(dir, false);
    this.made.delete(dir);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.mkdirs(parent(to));
    await this.adapter.rename(from, to);
  }

  async stat(path: string): Promise<FileStat | null> {
    const stat = await this.adapter.stat(path);
    return stat === null || stat.type !== "file" ? null : { size: stat.size, mtime: stat.mtime };
  }

  async isDir(path: string): Promise<boolean> {
    return path === "" || (await this.adapter.stat(path))?.type === "folder";
  }

  async list(dir: string): Promise<{ files: string[]; dirs: string[] }> {
    let listed: { files: string[]; folders: string[] };
    try {
      listed = await this.adapter.list(dir === "" ? "/" : dir);
    } catch (error) {
      // As with a file: asked once where the folder is there, and why only where the listing failed
      if (dir === "" || (await this.adapter.exists(dir))) {
        throw error;
      }
      return { files: [], dirs: [] };
    }
    const name = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
    return { files: listed.files.map(name), dirs: listed.folders.map(name) };
  }
}

/**
 * Requests through Obsidian, which may talk to any host from a phone where
 * the browser inside the app may not. The price is that a response comes
 * whole, which is why the sync keeps every response small.
 */
export const obsidianHttp: Http = async (request) => {
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body === undefined ? undefined : toBuffer(request.body),
    throw: false,
  });
  let body = new Uint8Array(response.arrayBuffer);
  // Some platforms hand over a compressed body as it came. A pack must be exact.
  if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
    body = pako.ungzip(body);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    headers[name.toLowerCase()] = value;
  }
  return { status: response.status, headers, body };
};
