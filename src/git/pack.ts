import { concat, encode, fromHex, toHex } from "./bytes.ts";
import { type GitObject, objectId, type ObjectType } from "./objects.ts";
import { sha1 } from "./sha1.ts";
import { deflate, inflateAt } from "./zlib.ts";

const TYPE_OF: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const NUMBER_OF: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OFS_DELTA = 6;
const REF_DELTA = 7;

export interface PackedObject extends GitObject {
  oid: string;
}

/** An object of a pack before its deltas are applied. */
interface Entry {
  type: number;
  data: Uint8Array;
  /** Where the base of a delta starts in the pack */
  baseOffset?: number;
  /** The id of the base of a delta that names it */
  baseOid?: string;
  resolved?: GitObject;
}

/**
 * Reads every object of a pack. A delta against an object that is not in the
 * pack is looked up with `external`.
 */
export async function parsePack(
  pack: Uint8Array,
  external?: (oid: string) => Promise<GitObject | null>,
): Promise<PackedObject[]> {
  if (pack.length < 32 || toHex(pack.subarray(0, 4)) !== "5041434b") {
    throw new Error("pack: no PACK header");
  }
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (view.getUint32(4) !== 2) {
    throw new Error("pack: not version 2");
  }
  const count = view.getUint32(8);
  if ((await sha1(pack.subarray(0, pack.length - 20))) !== toHex(pack.subarray(pack.length - 20))) {
    throw new Error("pack: the checksum does not match, the download is damaged");
  }

  const entries = new Map<number, Entry>();
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const offset = pos;
    let byte = pack[pos++];
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    let scale = 16;
    while (byte & 0x80) {
      byte = pack[pos++]!;
      size += (byte & 0x7f) * scale;
      scale *= 128;
    }
    const entry: Entry = { type, data: pack };
    if (type === OFS_DELTA) {
      byte = pack[pos++]!;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos++]!;
        back = (back + 1) * 128 + (byte & 0x7f);
      }
      entry.baseOffset = offset - back;
    } else if (type === REF_DELTA) {
      entry.baseOid = toHex(pack.subarray(pos, pos + 20));
      pos += 20;
    } else if (TYPE_OF[type] === undefined) {
      throw new Error(`pack: unknown object type ${type}`);
    }
    const inflated = inflateAt(pack, pos, size);
    entry.data = inflated.data;
    pos = inflated.end;
    entries.set(offset, entry);
  }

  const byOid = new Map<string, GitObject>();
  const out: PackedObject[] = [];
  const finish = async (entry: Entry, object: GitObject): Promise<void> => {
    entry.resolved = object;
    const oid = await objectId(object);
    byOid.set(oid, object);
    out.push({ ...object, oid });
  };

  // Walks from an object down its bases to one that is known, then applies
  // the deltas on the way back. A list and not recursion: a chain can be long.
  // False if a base that is named by its id is not known yet.
  const resolve = async (start: Entry): Promise<boolean> => {
    const chain: Entry[] = [];
    let entry = start;
    let base: GitObject;
    for (;;) {
      if (entry.resolved !== undefined) {
        base = entry.resolved;
        break;
      }
      if (entry.type === OFS_DELTA) {
        chain.push(entry);
        const next = entries.get(entry.baseOffset!);
        if (next === undefined) {
          throw new Error("pack: a delta points at nothing");
        }
        entry = next;
      } else if (entry.type === REF_DELTA) {
        chain.push(entry);
        const found = byOid.get(entry.baseOid!) ?? (await external?.(entry.baseOid!)) ?? null;
        if (found === null) {
          return false;
        }
        base = found;
        break;
      } else {
        const whole = { type: TYPE_OF[entry.type], data: entry.data };
        await finish(entry, whole);
        base = whole;
        break;
      }
    }
    while (chain.length > 0) {
      const top = chain.pop()!;
      const object = { type: base.type, data: applyDelta(base.data, top.data) };
      await finish(top, object);
      base = object;
    }
    return true;
  };

  let waiting = [...entries.values()];
  while (waiting.length > 0) {
    const still: Entry[] = [];
    for (const entry of waiting) {
      if (entry.resolved === undefined && !(await resolve(entry))) {
        still.push(entry);
      }
    }
    if (still.length === waiting.length) {
      throw new Error("pack: a delta needs an object that is neither in the pack nor here");
    }
    waiting = still;
  }
  return out;
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let pos = 0;
  const readSize = (): number => {
    let size = 0;
    let scale = 1;
    let byte: number;
    do {
      byte = delta[pos++]!;
      size += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
    return size;
  };
  if (readSize() !== base.length) {
    throw new Error("pack: a delta does not fit its base");
  }
  const out = new Uint8Array(readSize());
  let at = 0;
  while (pos < delta.length) {
    const command = delta[pos++];
    if (command & 0x80) {
      let offset = 0;
      let size = 0;
      if (command & 0x01) offset = delta[pos++]!;
      if (command & 0x02) offset += delta[pos++] * 0x100;
      if (command & 0x04) offset += delta[pos++] * 0x10000;
      if (command & 0x08) offset += delta[pos++] * 0x1000000;
      if (command & 0x10) size = delta[pos++]!;
      if (command & 0x20) size += delta[pos++] * 0x100;
      if (command & 0x40) size += delta[pos++] * 0x10000;
      if (size === 0) size = 0x10000;
      out.set(base.subarray(offset, offset + size), at);
      at += size;
    } else if (command > 0) {
      out.set(delta.subarray(pos, pos + command), at);
      at += command;
      pos += command;
    } else {
      throw new Error("pack: a delta has a command of zero");
    }
  }
  if (at !== out.length) {
    throw new Error("pack: a delta gives the wrong size");
  }
  return out;
}

/** Writes a pack of whole objects. No deltas: the packs of a phone are small. */
export async function writePack(objects: GitObject[]): Promise<Uint8Array> {
  const head = new Uint8Array(12);
  head.set(encode("PACK"));
  const view = new DataView(head.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const parts: Uint8Array[] = [head];
  for (const object of objects) {
    let size = object.data.length;
    const header: number[] = [];
    let byte = (NUMBER_OF[object.type] << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size > 0) {
      header.push(byte | 0x80);
      byte = size & 0x7f;
      size = Math.floor(size / 128);
    }
    header.push(byte);
    parts.push(new Uint8Array(header), deflate(object.data));
  }
  const body = concat(parts);
  return concat([body, fromHex(await sha1(body))]);
}
