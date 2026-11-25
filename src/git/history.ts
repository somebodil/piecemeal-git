import { type Http } from "./http.ts";
import { type Commit, type GitObject, MODE_TREE, momentOf, parseCommit, parseTree } from "./objects.ts";
import { parsePack } from "./pack.ts";
import { fetchPack, type Remote } from "./protocol.ts";
import { type ObjectStore } from "./store.ts";

/**
 * How many commits back from the newest one the server is asked for, with
 * the first request, the second and the third. There is no fourth: a file
 * that was last changed further back than that has no time that is known.
 */
const DEPTHS = [16, 64, 256];

/**
 * A response up to this size is followed by a request that goes further
 * back. So many commits back are so many commits only where the history is a
 * line. Where commits have two parents, they can be very many, and the
 * server cannot be told to send no more than fits. So the second and the
 * third request are made only while no such commit came and what came was small.
 */
const SMALL_RESPONSE = 256 * 1024;

/**
 * How much the commits and folders hold at most that are kept in mind, as
 * they are when they are read. That is not what the size of a response
 * tells: a folder of thousands of notes in which one note changed comes as
 * a few bytes, and is the whole list of its notes once it is read. What
 * would go above this is not read, and nothing further back is asked for.
 */
const MOST_BYTES = 4 * 1024 * 1024;

/** How many commits and folders are kept in mind at most */
const MOST_OBJECTS = 4000;

/** How many commits a look for one file goes through at most */
const MOST_COMMITS = 300;

/** What is known of the newest change of a file on the remote. */
export interface Change {
  /** When the commit that made the change was made, as its committer says, in milliseconds since 1970 */
  at: number;
  /**
   * The ids of what the file held before that change, in the commits that
   * were looked at for it or had come with them. Further back is not asked
   * for, so this is a part of what the file once held, and can be empty.
   */
  before: string[];
}

/**
 * The commits of a remote back from one of them, as far as they are needed
 * to tell when a file was last changed there. This is what the git protocol
 * gives where the host has no way of its own to tell.
 *
 * The server is asked for commits and folders only, never for what a file
 * holds, and for a number of commits at a time: up to three times where the
 * history is a line and what comes stays small, and once where it does not.
 * What it sends is kept in mind while the sync runs, up to a few megabytes,
 * and is not written to the device.
 *
 * Nothing that goes wrong here stops a sync. The time is not known then.
 */
export class History {
  private readonly http: Http;
  private readonly remote: Remote;
  private readonly store: ObjectStore;
  /** The commit that the look starts from. It is in the store, with its folders. */
  private readonly tip: string;
  private readonly log: (message: string) => void;
  private readonly objects = new Map<string, GitObject>();
  /** How many bytes the objects hold that are kept in mind */
  private bytes = 0;
  /** The commits that are here without their parents, as the server is told */
  private shallow: string[];
  /** How many times the server was asked */
  private asked = 0;
  /**
   * True once the server is not asked again: it did not answer, a commit
   * with two parents came, or what came was not small, as it came or as it
   * was read.
   */
  private closed = false;

  constructor(http: Http, remote: Remote, store: ObjectStore, tip: string, log?: (message: string) => void) {
    this.http = http;
    this.remote = remote;
    this.store = store;
    this.tip = tip;
    this.shallow = [tip];
    this.log = log ?? (() => undefined);
  }

  /** How much is kept in mind: so many commits and folders, which hold so many bytes. */
  held(): { objects: number; bytes: number } {
    return { objects: this.objects.size, bytes: this.bytes };
  }

  private async get(oid: string): Promise<GitObject | null> {
    return this.objects.get(oid) ?? (await this.store.read(oid));
  }

  /**
   * Asks the server for commits further back, as `git fetch --depth` does
   * for a clone that has the newest commit only. False if there is no more
   * to be had.
   */
  private async deepen(): Promise<boolean> {
    if (this.closed || this.asked >= DEPTHS.length) {
      return false;
    }
    const depth = DEPTHS[this.asked++];
    try {
      const fetched = await fetchPack(this.http, this.remote, {
        wants: [this.tip],
        // What the newest commit holds is here already, and is not sent again
        haves: [this.tip],
        shallow: this.shallow,
        depth,
        filter: "blob:none",
      });
      // No more is read than there is room for. A pack that holds more is given up on as a whole.
      const read = await parsePack(fetched.pack, (oid) => this.get(oid), {
        objects: MOST_OBJECTS - this.objects.size,
        bytes: MOST_BYTES - this.bytes,
      });
      let wide = fetched.pack.length > SMALL_RESPONSE;
      for (const object of read) {
        if (object.type !== "commit" && object.type !== "tree") {
          continue;
        }
        if (!this.objects.has(object.oid)) {
          this.objects.set(object.oid, { type: object.type, data: object.data });
          this.bytes += object.data.length;
        }
        if (object.type === "commit" && parseCommit(object.data).parents.length > 1) {
          wide = true;
        }
      }
      const deeper = new Set(fetched.unshallow);
      this.shallow = [...this.shallow.filter((oid) => !deeper.has(oid)), ...fetched.shallow];
      // The next request would go four times as far back. It is not made if what came so far,
      // taken four times, does not fit: the server would send it all the same.
      const next = DEPTHS[this.asked];
      if (wide || (next !== undefined && ((this.bytes / depth) * next > MOST_BYTES || (this.objects.size / depth) * next > MOST_OBJECTS))) {
        this.closed = true;
      }
      return true;
    } catch (error) {
      // A server that cuts no history short or leaves out nothing when asked to, no network,
      // a pack that is damaged or holds too much: whatever it is, there is no more to be had
      this.closed = true;
      this.log(`the commits of the remote could not be had further back (${error instanceof Error ? error.message : String(error)})`);
      return false;
    }
  }

  /** A commit, asked for if it is not here yet. Null if it cannot be had. */
  private async commit(oid: string): Promise<Commit | null> {
    for (;;) {
      const object = await this.get(oid);
      if (object !== null) {
        return object.type === "commit" ? parseCommit(object.data) : null;
      }
      // The server is told that the newest commit is here, and does not send it
      if (oid === this.tip || !(await this.deepen())) {
        return null;
      }
    }
  }

  /**
   * What a folder holds at a path under it, as its kind and its id in one
   * text: "" if it holds nothing there, and null if a folder on the way is
   * not here.
   */
  private async entryAt(tree: string, path: string): Promise<string | null> {
    const names = path.split("/");
    let oid = tree;
    for (let i = 0; i < names.length; i++) {
      const object = await this.get(oid);
      if (object === null || object.type !== "tree") {
        return null;
      }
      const entry = parseTree(object.data).find((other) => other.name === names[i]);
      if (entry === undefined) {
        return "";
      }
      if (i === names.length - 1) {
        return `${entry.mode} ${entry.oid}`;
      }
      if (entry.mode !== MODE_TREE) {
        return "";
      }
      oid = entry.oid;
    }
    return "";
  }

  /**
   * The newest change of a path: when the commit that made it was made, and
   * what the path held before, as far as that is here. The commit is the one
   * that `git log` shows first for the path: the newest one that holds the
   * file otherwise than each commit that it stands on. Null if that commit
   * is too far back, the server does not give what it takes to find it, or
   * anything else goes wrong on the way.
   */
  async lastChange(path: string): Promise<Change | null> {
    try {
      return await this.look(path);
    } catch (error) {
      // A file of the device that cannot be read, a commit that is not what it should be
      this.log(`when ${path} was changed on the remote could not be found (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
  }

  /** When the newest commit that changed a path was made, in milliseconds since 1970, or null if that is not known. */
  async changedAt(path: string): Promise<number | null> {
    return (await this.lastChange(path))?.at ?? null;
  }

  private async look(path: string): Promise<Change | null> {
    let commit = await this.commit(this.tip);
    if (commit === null) {
      return null;
    }
    const held = await this.entryAt(commit.tree, path);
    if (held === null || held === "") {
      return null;
    }
    for (let n = 0; n < MOST_COMMITS; n++) {
      // A commit that holds the file as one of its parents does has not changed it: the look goes on there
      let same: Commit | null = null;
      const before = new Set<string>();
      for (const parent of commit.parents) {
        const earlier = await this.commit(parent);
        if (earlier === null) {
          return null;
        }
        const entry = await this.entryAt(earlier.tree, path);
        if (entry === null) {
          return null;
        }
        if (entry === held) {
          same = earlier;
          break;
        }
        noteFile(before, entry);
      }
      if (same === null) {
        const at = momentOf(commit.committer);
        if (at === null) {
          return null;
        }
        await this.heldBefore(path, commit.parents, before);
        before.delete(idOf(held));
        return { at, before: [...before] };
      }
      commit = same;
    }
    return null;
  }

  /**
   * Adds what a path held in the commits below `from` that are kept in
   * mind. Nothing is asked for it, of the server or of the device beyond a
   * folder that the device has: the look ends where the commits end that
   * came already.
   */
  private async heldBefore(path: string, from: string[], into: Set<string>): Promise<void> {
    const seen = new Set<string>();
    const todo = [...from];
    while (todo.length > 0 && seen.size < MOST_COMMITS) {
      const oid = todo.pop()!;
      if (seen.has(oid)) {
        continue;
      }
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== "commit") {
        continue;
      }
      const commit = parseCommit(object.data);
      noteFile(into, (await this.entryAt(commit.tree, path)) ?? "");
      todo.push(...commit.parents);
    }
  }
}

/** The id in what `entryAt` gives. */
function idOf(entry: string): string {
  return entry.slice(entry.indexOf(" ") + 1);
}

/** Adds the id of what `entryAt` gave, if that is a file or a link and not a folder or nothing. */
function noteFile(into: Set<string>, entry: string): void {
  if (entry !== "" && !entry.startsWith(`${MODE_TREE} `)) {
    into.add(idOf(entry));
  }
}
