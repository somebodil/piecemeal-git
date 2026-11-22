import { type FileStat, type Fs, join } from "../git/fs.ts";

/**
 * Files as an iPhone, an iPad and the apps of a Mac keep them: a name with
 * letters like "é" or "한" is stored with each letter taken apart into its
 * parts, whatever it was written as, and is found under either form. The
 * tests run on file systems that keep a name as it is given, and this makes
 * one that does not.
 */
export class DecomposingFs implements Fs {
  private readonly inner: Fs;

  constructor(inner: Fs) {
    this.inner = inner;
  }

  /** The path as the folder spells it, and taken apart where the folder does not have it yet. */
  private async spelled(path: string): Promise<string> {
    let out = "";
    for (const name of path === "" ? [] : path.split("/")) {
      const { files, dirs } = await this.inner.list(out);
      const found = [...dirs, ...files].find((other) => other.normalize("NFC") === name.normalize("NFC"));
      out = join(out, found ?? name.normalize("NFD"));
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
    const { files, dirs } = await this.inner.list(await this.spelled(dir));
    return { files: files.map((name) => name.normalize("NFD")), dirs: dirs.map((name) => name.normalize("NFD")) };
  }
}
