import { type Http } from "./http.ts";
import { type Commit, type GitObject, MODE_TREE, momentOf, parseCommit, parseTree } from "./objects.ts";
import { parsePack } from "./pack.ts";
import { fetchPack, type Remote, RemoteError } from "./protocol.ts";
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

/** How many commits a look for the time of one file goes through at most */
const MOST_COMMITS = 300;

/**
 * The commits of a remote back from one of them, as far as they are needed
 * to tell when a file was last changed there. This is what the git protocol
 * gives where the host has no way of its own to tell.
 *
 * The server is asked for commits and folders only, never for what a file
 * holds, and for a number of commits at a time: up to three times where the
 * history is a line, and once where it is not. What it sends is kept in
 * mind while the sync runs, and is not written to the device.
 */
export class History {
  private readonly http: Http;
  private readonly remote: Remote;
  private readonly store: ObjectStore;
  /** The commit that the look starts from. It is in the store, with its folders. */
  private readonly tip: string;
  private readonly objects = new Map<string, GitObject>();
  /** The commits that are here without their parents, as the server is told */
  private shallow: string[];
  /** How many times the server was asked */
  private asked = 0;
  /** True once the server refused to answer */
  private refused = false;
  /** True once it is not safe to ask further back: a commit with two parents came, or a response that was not small */
  private wide = false;

  constructor(http: Http, remote: Remote, store: ObjectStore, tip: string) {
    this.http = http;
    this.remote = remote;
    this.store = store;
    this.tip = tip;
    this.shallow = [tip];
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
    if (this.refused || this.asked >= DEPTHS.length || (this.asked > 0 && this.wide)) {
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
      this.wide = this.wide || fetched.pack.length > SMALL_RESPONSE;
      for (const object of await parsePack(fetched.pack, (oid) => this.get(oid))) {
        if (object.type === "commit" || object.type === "tree") {
          this.objects.set(object.oid, object);
        }
        if (object.type === "commit" && parseCommit(object.data).parents.length > 1) {
          this.wide = true;
        }
      }
      const deeper = new Set(fetched.unshallow);
      this.shallow = [...this.shallow.filter((oid) => !deeper.has(oid)), ...fetched.shallow];
      return true;
    } catch (error) {
      // A server that cuts no history short, or that leaves out nothing when asked to
      if (!(error instanceof RemoteError)) {
        throw error;
      }
      this.refused = true;
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
   * When the newest commit that changed a path was made, as its committer
   * says, in milliseconds since 1970. That is the commit that `git log` shows
   * first for the path: the newest one that holds the file otherwise than
   * each commit that it stands on. Null if that commit is too far back, or
   * the server does not give what it takes to find it.
   */
  async changedAt(path: string): Promise<number | null> {
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
      for (const parent of commit.parents) {
        const before = await this.commit(parent);
        if (before === null) {
          return null;
        }
        const entry = await this.entryAt(before.tree, path);
        if (entry === null) {
          return null;
        }
        if (entry === held) {
          same = before;
          break;
        }
      }
      if (same === null) {
        return momentOf(commit.committer);
      }
      commit = same;
    }
    return null;
  }
}
