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
  /** Removes a folder if it is empty. Nothing happens if it is not, or if there is none. */
  removeDir(path: string): Promise<void>;
  /** Gives a file another name. The folders above the new name exist. */
  rename(from: string, to: string): Promise<void>;
  /** Size and time of a file, or null if there is none or it is a folder. */
  stat(path: string): Promise<FileStat | null>;
  /** True if there is a folder with this path. */
  isDir(path: string): Promise<boolean>;
  /** The names in a folder, spelled as the folder has them. Empty if there is no such folder. */
  list(dir: string): Promise<{ files: string[]; dirs: string[] }>;
}

export function join(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}
