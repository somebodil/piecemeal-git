export interface FileStat {
  size: number;
  /** Milliseconds since 1970 */
  mtime: number;
}

/**
 * The files of a vault, as little of them as the sync needs. Paths are
 * relative to the vault, with forward slashes, and the vault itself is "".
 */
export interface Fs {
  /** The content of a file, or null if there is none. */
  read(path: string): Promise<Uint8Array | null>;
  /** Writes a file and makes the folders above it. */
  write(path: string, data: Uint8Array): Promise<void>;
  /** Adds to the end of a file, which is made if it is not there. */
  append(path: string, data: Uint8Array): Promise<void>;
  /** Removes a file. Nothing happens if there is none. */
  remove(path: string): Promise<void>;
  /**
   * Removes a file that a person may want back: one that the remote removed.
   * Where the app has a place for such files, it goes there. Without this
   * the file is removed as with `remove`.
   */
  discard?(path: string): Promise<void>;
  /** Removes a folder if it is empty. Nothing happens if it is not, or if there is none. */
  removeDir(path: string): Promise<void>;
  /** Gives a file another name. The folders above the new name exist. */
  rename(from: string, to: string): Promise<void>;
  /** Size and time of a file, or null if there is none or it is a folder. */
  stat(path: string): Promise<FileStat | null>;
  /**
   * Size and time of a file as the app has them in mind, without a look at
   * the disk, or null if it has none. It can be a moment behind, so it is
   * good for one thing only: to see that a file is still as it was.
   */
  quickStat?(path: string): Promise<FileStat | null> | FileStat | null;
  /** True if there is a folder with this path. */
  isDir(path: string): Promise<boolean>;
  /**
   * The names in a folder, spelled as the folder has them. Empty if there is
   * no such folder. Where `readLink` is there, a link is among the files,
   * whatever it points to.
   */
  list(dir: string): Promise<{ files: string[]; dirs: string[] }>;
  /**
   * Where a link points, or null if the path is not a link. Only on files
   * that can hold links and tell them from files: a phone cannot.
   */
  readLink?(path: string): Promise<string | null>;
  /** Makes a link, in place of a file or a link that has the name. Only where `readLink` is. */
  writeLink?(path: string, target: string): Promise<void>;
}

/** How often a file is written before the sync gives up on it */
const WRITE_ATTEMPTS = 3;

/**
 * The same files, with every write looked at afterwards. The app on Android
 * has been seen to say that a file was written and to leave it empty, about
 * once in a few hundred files. A file that does not have the size of what was
 * written is written again.
 */
export class VerifiedFs implements Fs {
  private readonly inner: Fs;
  /** How many writes had to be done again */
  rewritten = 0;
  readLink?: (path: string) => Promise<string | null>;
  writeLink?: (path: string, target: string) => Promise<void>;
  discard?: (path: string) => Promise<void>;
  quickStat?: (path: string) => Promise<FileStat | null> | FileStat | null;

  constructor(inner: Fs) {
    this.inner = inner;
    if (inner.quickStat !== undefined) {
      this.quickStat = (path) => inner.quickStat!(path);
    }
    if (inner.discard !== undefined) {
      this.discard = (path) => inner.discard!(path);
    }
    if (inner.readLink !== undefined && inner.writeLink !== undefined) {
      this.readLink = (path) => inner.readLink!(path);
      this.writeLink = (path, target) => inner.writeLink!(path, target);
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      await this.inner.write(path, data);
      const size = (await this.inner.stat(path))?.size;
      if (size === data.length) {
        return;
      }
      if (attempt === WRITE_ATTEMPTS) {
        throw new Error(`${path} could not be written: it has ${size ?? "no"} bytes of ${data.length}`);
      }
      this.rewritten++;
    }
  }

  read(path: string): Promise<Uint8Array | null> {
    return this.inner.read(path);
  }

  append(path: string, data: Uint8Array): Promise<void> {
    return this.inner.append(path, data);
  }

  remove(path: string): Promise<void> {
    return this.inner.remove(path);
  }

  removeDir(path: string): Promise<void> {
    return this.inner.removeDir(path);
  }

  rename(from: string, to: string): Promise<void> {
    return this.inner.rename(from, to);
  }

  stat(path: string): Promise<FileStat | null> {
    return this.inner.stat(path);
  }

  isDir(path: string): Promise<boolean> {
    return this.inner.isDir(path);
  }

  list(dir: string): Promise<{ files: string[]; dirs: string[] }> {
    return this.inner.list(dir);
  }
}

export function join(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}
