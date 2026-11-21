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
    const object = unwrap(inflate(raw));
    this.cache.set(oid, object);
    return object;
  }
}
