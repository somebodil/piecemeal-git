import { type FileStat, type Fs } from "../src/git/fs.ts";

/**
 * Files as the app on Android has been seen to keep them: now and then a
 * write is said to be done, and the file is there and empty.
 */
export class FlakyFs implements Fs {
  private readonly inner: Fs;
  private readonly fails: (path: string, nth: number) => boolean;
  private writes = 0;
  /** The paths whose write was lost */
  readonly lost: string[] = [];

  /** @param fails true for a write that is to be lost: asked with the path, and with how many writes there were before */
  constructor(inner: Fs, fails: (path: string, nth: number) => boolean) {
    this.inner = inner;
    this.fails = fails;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    if (this.fails(path, this.writes++)) {
      this.lost.push(path);
      await this.inner.write(path, new Uint8Array(0));
    } else {
      await this.inner.write(path, data);
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
