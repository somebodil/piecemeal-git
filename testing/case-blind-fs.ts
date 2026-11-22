import { type FileStat, type Fs, join } from "../src/git/fs.ts";

/**
 * Files as a phone and most computers keep them: a name is found whatever its
 * capital letters are, and keeps the spelling it was made with. The tests run
 * on a file system that tells "a" from "A", and this makes it one that does not.
 */
export class CaseBlindFs implements Fs {
  private readonly inner: Fs;

  constructor(inner: Fs) {
    this.inner = inner;
  }

  /** The path as the folder spells it, as far as the folder has it. */
  private async spelled(path: string): Promise<string> {
    let out = "";
    for (const name of path === "" ? [] : path.split("/")) {
      const { files, dirs } = await this.inner.list(out);
      const found = [...dirs, ...files].find((other) => other.toLowerCase() === name.toLowerCase());
      out = join(out, found ?? name);
    }
    return out;
  }

  async read(path: string): Promise<Uint8Array | null> {
    return this.inner.read(await this.spelled(path));
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    await this.inner.write(await this.spelled(path), data);
  }

  async append(path: string, data: Uint8Array): Promise<void> {
    await this.inner.append(await this.spelled(path), data);
  }

  async remove(path: string): Promise<void> {
    await this.inner.remove(await this.spelled(path));
  }

  async removeDir(path: string): Promise<void> {
    await this.inner.removeDir(await this.spelled(path));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.inner.rename(await this.spelled(from), await this.spelled(to));
  }

  async stat(path: string): Promise<FileStat | null> {
    return this.inner.stat(await this.spelled(path));
  }

  async isDir(path: string): Promise<boolean> {
    return this.inner.isDir(await this.spelled(path));
  }

  async list(dir: string): Promise<{ files: string[]; dirs: string[] }> {
    return this.inner.list(await this.spelled(dir));
  }
}
