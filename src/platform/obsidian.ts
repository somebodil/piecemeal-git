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

  constructor(adapter: DataAdapter) {
    this.adapter = adapter;
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
    if (!(await this.adapter.exists(path))) {
      return null;
    }
    return new Uint8Array(await this.adapter.readBinary(path));
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

  async list(dir: string): Promise<{ files: string[]; dirs: string[] }> {
    if (dir !== "" && !(await this.adapter.exists(dir))) {
      return { files: [], dirs: [] };
    }
    const listed = await this.adapter.list(dir === "" ? "/" : dir);
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
