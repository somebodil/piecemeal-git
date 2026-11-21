import { compareBytes, concat, decode, encode, fromHex, toHex } from "./bytes.ts";
import { sha1 } from "./sha1.ts";

export type ObjectType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  type: ObjectType;
  data: Uint8Array;
}

/** An object as git hashes and stores it: its type and size, a zero byte, its content. */
export function wrap(object: GitObject): Uint8Array {
  return concat([encode(`${object.type} ${object.data.length}\0`), object.data]);
}

export function unwrap(wrapped: Uint8Array): GitObject {
  const zero = wrapped.indexOf(0);
  if (zero < 0) {
    throw new Error("object: no header");
  }
  const [type, size] = decode(wrapped.subarray(0, zero)).split(" ");
  const data = wrapped.subarray(zero + 1);
  if (
    (type !== "commit" && type !== "tree" && type !== "blob" && type !== "tag") ||
    Number(size) !== data.length
  ) {
    throw new Error("object: bad header");
  }
  return { type, data };
}

export async function objectId(object: GitObject): Promise<string> {
  return sha1(wrap(object));
}

export const MODE_FILE = "100644";
export const MODE_EXECUTABLE = "100755";
export const MODE_TREE = "40000";
export const MODE_LINK = "120000";
export const MODE_SUBMODULE = "160000";

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const zero = data.indexOf(0, space);
    if (space < 0 || zero < 0 || zero + 21 > data.length) {
      throw new Error("tree: cut off");
    }
    entries.push({
      mode: decode(data.subarray(pos, space)),
      name: decode(data.subarray(space + 1, zero)),
      oid: toHex(data.subarray(zero + 1, zero + 21)),
    });
    pos = zero + 21;
  }
  return entries;
}

/** Writes a tree with its entries in the order of git: by name, a folder as if its name ended in a slash. */
export function serializeTree(entries: TreeEntry[]): Uint8Array {
  const keyed = entries.map((entry) => ({
    entry,
    key: encode(entry.mode === MODE_TREE ? `${entry.name}/` : entry.name),
  }));
  keyed.sort((a, b) => compareBytes(a.key, b.key));
  const parts: Uint8Array[] = [];
  for (const { entry } of keyed) {
    parts.push(encode(`${entry.mode} ${entry.name}\0`), fromHex(entry.oid));
  }
  return concat(parts);
}

export interface Commit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Uint8Array): Commit {
  const text = decode(data);
  const split = text.indexOf("\n\n");
  const head = split < 0 ? text : text.slice(0, split);
  const commit: Commit = {
    tree: "",
    parents: [],
    author: "",
    committer: "",
    message: split < 0 ? "" : text.slice(split + 2),
  };
  for (const line of head.split("\n")) {
    const space = line.indexOf(" ");
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === "tree") {
      commit.tree = value;
    } else if (key === "parent") {
      commit.parents.push(value);
    } else if (key === "author") {
      commit.author = value;
    } else if (key === "committer") {
      commit.committer = value;
    }
  }
  if (commit.tree === "") {
    throw new Error("commit: no tree");
  }
  return commit;
}

export function serializeCommit(commit: Commit): Uint8Array {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${commit.author}`, `committer ${commit.committer}`, "", commit.message);
  return encode(lines.join("\n"));
}

/** A name, an address and a moment as a commit writes them. */
export function signature(name: string, email: string, when: Date): string {
  const seconds = Math.floor(when.getTime() / 1000);
  const minutes = -when.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const zone = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
  return `${name} <${email}> ${seconds} ${zone}`;
}
