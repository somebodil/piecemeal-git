import { type Fs } from "./fs.ts";
import { type GitObject, objectId, unwrap, wrap } from "./objects.ts";
import { deflate, inflate } from "./zlib.ts";

/**
 * The commits and the folders that the device knows, one file each, the way
 * git keeps loose objects. The contents of the files of the vault are not
 * kept here: the vault is the copy.
 */
export class ObjectStore {
  private readonly cache = new Map<string, GitObject>();
  private readonly fs: Fs;
  private readonly dir: string;

  constructor(fs: Fs, dir: string) {
    this.fs = fs;
    this.dir = dir;
  }

  private path(oid: string): string {
    return `${this.dir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
  }

  async write(object: GitObject, oid?: string): Promise<string> {
    const id = oid ?? (await objectId(object));
    if (!this.cache.has(id)) {
      if ((await this.fs.stat(this.path(id))) === null) {
        await this.fs.write(this.path(id), deflate(wrap(object)));
      }
      this.cache.set(id, object);
    }
    return id;
  }

  async read(oid: string): Promise<GitObject | null> {
    const cached = this.cache.get(oid);
    if (cached !== undefined) {
      return cached;
    }
    const raw = await this.fs.read(this.path(oid));
    if (raw === null) {
      return null;
    }
    // A file that is cut off, empty, or not what its name says is as good as none.
    // It is removed, so that the object is asked for and written again.
    let object: GitObject | null = null;
    try {
      const inflated = inflate(raw) as Uint8Array | undefined;
      if (inflated !== undefined) {
        const read = unwrap(inflated);
        if ((await objectId(read)) === oid) {
          object = read;
        }
      }
    } catch {
      // Not an object
    }
    if (object === null) {
      await this.fs.remove(this.path(oid));
      return null;
    }
    this.cache.set(oid, object);
    return object;
  }
}
