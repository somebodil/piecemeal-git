import { decode, encode } from "./bytes.ts";
import { type FileStat, type Fs, join } from "./fs.ts";
import { type Http } from "./http.ts";
import { addToBlock, type Verdict, verdict } from "./ignore.ts";
import {
  type GitObject,
  MODE_EXECUTABLE,
  MODE_FILE,
  MODE_TREE,
  objectId,
  parseCommit,
  parseTree,
  serializeCommit,
  serializeTree,
  signature,
  type TreeEntry,
} from "./objects.ts";
import { parsePack, writePack } from "./pack.ts";
import { fetchPack, lsRefs, push, type Remote, ZERO_OID } from "./protocol.ts";
import { ObjectStore } from "./store.ts";

/** A file of the remote that is too large to come in one response. */
export interface LargeFile {
  oid: string;
  size: number;
  /** A commit that holds the file, and the path of the file there */
  commit: string;
  path: string;
}

/** A file of a commit: what it holds, and what kind of thing it is. */
export interface Entry {
  oid: string;
  mode: string;
}

export interface SyncOptions {
  fs: Fs;
  http: Http;
  remote: Remote;
  /** The branch to sync with. Without it: the branch of the last sync, or the one the remote opens with. */
  branch?: string;
  /** The folder in the vault where the plugin keeps what it knows */
  storeDir: string;
  /** Paths that are never synced, whatever `.gitignore` says. A folder is asked about with `isDir`. */
  exclude?: (path: string, isDir: boolean) => boolean;
  author: { name: string; email: string };
  /** The message of a commit that this device makes */
  message: (when: Date) => string;
  /** A file larger than this is neither sent nor asked for in one piece */
  maxFileBytes: number;
  /** Contents of files are asked for, and sent, in batches of about this size */
  batchBytes: number;
  /** The sizes of the files under a tree, by their ids, if the host can tell */
  sizes?: (treeOid: string) => Promise<Map<string, number>>;
  /** Gets a file that is too large for one response and writes it to `path` in the vault. False if it cannot. */
  largeBlob?: (file: LargeFile, path: string) => Promise<boolean>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface SyncResult {
  /** The commit that the remote and this device now agree on, if there is one */
  commit: string | null;
  downloaded: string[];
  uploaded: string[];
  deletedHere: string[];
  deletedThere: string[];
  /** Files that both sides changed: this side stays, the other side is kept as a copy */
  conflicts: { path: string; copy: string }[];
  /** New files that were too large to send. They were written into `.gitignore`. */
  tooLargeIgnored: string[];
  /** Files of the remote that were changed here and are now too large to send. The remote keeps its version. */
  tooLargeChanged: string[];
  /** Files of the remote that are too large to get on this device. They are left out of the vault. */
  tooLargeThere: string[];
  /** Files that changed while the sync ran. The next sync takes care of them. */
  busy: string[];
}

interface State {
  version: 1;
  url: string;
  branch: string;
  /** The commit of the remote that was seen last */
  commit: string | null;
  /** What this device and the remote last agreed on, path by path */
  tree: Record<string, Entry>;
  /** Size and time of each file when it was last known to be as `tree` says */
  stat: Record<string, FileStat>;
  /** Paths of `tree` that are not in the vault: too large, or not a file */
  absent: Record<string, true>;
  /**
   * Files that were changed so shortly before `stat` was noted that another
   * change could leave their size and time as they are. They are read again.
   */
  racy?: Record<string, true>;
}

/**
 * How far apart two changes of a file are at least for its time to differ:
 * the coarsest clock of a file system that a vault is kept on, and a little more.
 */
const RACY_MS = 3000;

class MissingObjectError extends Error {}

function same(a: Entry | undefined, b: Entry | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode);
}

function isFile(entry: Entry): boolean {
  return entry.mode === MODE_FILE || entry.mode === MODE_EXECUTABLE;
}

/** The folder of a path, which is "" for a path at the top. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** All files under a tree, by path, and the ids of the tree and the trees inside it. */
async function flatten(
  store: ObjectStore,
  root: string,
): Promise<{ entries: Map<string, Entry>; trees: Set<string> }> {
  const entries = new Map<string, Entry>();
  const trees = new Set<string>();
  const todo: { oid: string; dir: string }[] = [{ oid: root, dir: "" }];
  while (todo.length > 0) {
    const { oid, dir } = todo.pop()!;
    const object = await store.read(oid);
    if (object === null) {
      throw new MissingObjectError(oid);
    }
    trees.add(oid);
    for (const entry of parseTree(object.data)) {
      const path = join(dir, entry.name);
      if (entry.mode === MODE_TREE) {
        todo.push({ oid: entry.oid, dir: path });
      } else {
        entries.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
  }
  return { entries, trees };
}

interface Node {
  files: Map<string, Entry>;
  dirs: Map<string, Node>;
}

/** Makes the trees for a set of files. Returns the id of the top one and every tree by its id. */
async function buildTrees(
  files: Map<string, Entry>,
): Promise<{ root: string; trees: Map<string, GitObject> }> {
  const top: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const names = path.split("/");
    let node = top;
    for (const name of names.slice(0, -1)) {
      let next = node.dirs.get(name);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(name, next);
      }
      node = next;
    }
    node.files.set(names[names.length - 1], entry);
  }
  const trees = new Map<string, GitObject>();
  const build = async (node: Node): Promise<string> => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) {
      entries.push({ name, mode: entry.mode, oid: entry.oid });
    }
    for (const [name, child] of node.dirs) {
      entries.push({ name, mode: MODE_TREE, oid: await build(child) });
    }
    const object: GitObject = { type: "tree", data: serializeTree(entries) };
    const oid = await objectId(object);
    trees.set(oid, object);
    return oid;
  };
  return { root: await build(top), trees };
}

/** A name next to `path` for the other side of a conflict. */
function conflictPath(path: string, when: Date, taken: (path: string) => boolean): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const stem = dot > slash + 1 ? path.slice(0, dot) : path;
  const ext = dot > slash + 1 ? path.slice(dot) : "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())}`;
  let candidate = `${stem} (conflict ${stamp})${ext}`;
  for (let n = 2; taken(candidate); n++) {
    candidate = `${stem} (conflict ${stamp} ${n})${ext}`;
  }
  return candidate;
}

/**
 * Brings the vault and a branch of the remote to the same files.
 *
 * The device keeps no commits of its own. Every sync compares three things
 * for each path: what both sides last agreed on, what the vault holds now,
 * and what the remote holds now. What changed on one side goes to the other.
 * What changed on both stays as it is here, and the other version is kept
 * beside it under another name. The changes of the device then become one
 * commit on top of the remote, so the history of the branch stays a line.
 */
export async function sync(options: SyncOptions): Promise<SyncResult> {
  const { fs, http, remote } = options;
  const log = options.log ?? (() => undefined);
  const now = (options.now ?? (() => new Date()))();
  const store = new ObjectStore(fs, options.storeDir);
  const statePath = `${options.storeDir}/state.json`;
  const excluded = (path: string, isDir: boolean): boolean =>
    path === options.storeDir ||
    path.startsWith(`${options.storeDir}/`) ||
    path === ".git" ||
    path.startsWith(".git/") ||
    (options.exclude?.(path, isDir) ?? false);

  const result: SyncResult = {
    commit: null,
    downloaded: [],
    uploaded: [],
    deletedHere: [],
    deletedThere: [],
    conflicts: [],
    tooLargeIgnored: [],
    tooLargeChanged: [],
    tooLargeThere: [],
    busy: [],
  };

  // --- What was agreed on last time -----------------------------------------
  let state: State = { version: 1, url: remote.url, branch: "", commit: null, tree: {}, stat: {}, absent: {} };
  const saved = await fs.read(statePath);
  if (saved !== null) {
    const parsed = JSON.parse(decode(saved)) as State;
    if (parsed.url !== remote.url) {
      throw new Error(
        `This vault was synced with ${parsed.url}. To sync it with another repository, remove the folder ${options.storeDir} first.`,
      );
    }
    state = parsed;
  }
  const base = new Map(Object.entries(state.tree));

  // --- What the remote holds now --------------------------------------------
  const refs = await lsRefs(http, remote);
  const branch = options.branch ?? (state.branch !== "" ? state.branch : (refs.head?.slice("refs/heads/".length) ?? "main"));
  const ref = `refs/heads/${branch}`;
  let tip = refs.heads.get(ref) ?? null;

  const fetchCommit = async (oid: string, have: string | null): Promise<void> => {
    const fetched = await fetchPack(http, remote, {
      wants: [oid],
      haves: have === null ? [] : [have],
      shallow: have === null ? [] : [have],
      depth: 1,
      filter: "blob:none",
    });
    for (const object of await parsePack(fetched.pack, (id) => store.read(id))) {
      if (object.type === "commit" || object.type === "tree") {
        await store.write(object, object.oid);
      }
    }
  };
  const readTree = async (commitOid: string): Promise<{ entries: Map<string, Entry>; trees: Set<string>; root: string }> => {
    const commit = await store.read(commitOid);
    if (commit === null) {
      throw new MissingObjectError(commitOid);
    }
    const root = parseCommit(commit.data).tree;
    return { ...(await flatten(store, root)), root };
  };

  let there = new Map<string, Entry>();
  let knownTrees = new Set<string>();
  let thereRoot: string | null = null;
  if (tip !== null) {
    if ((await store.read(tip)) === null) {
      await fetchCommit(tip, state.commit);
    }
    let read;
    try {
      read = await readTree(tip);
    } catch (error) {
      if (!(error instanceof MissingObjectError)) {
        throw error;
      }
      // A tree that should be here is not. Ask for everything again.
      await fetchCommit(tip, null);
      read = await readTree(tip);
    }
    there = read.entries;
    knownTrees = read.trees;
    thereRoot = read.root;
  }

  // --- What the vault holds now ---------------------------------------------
  const here = new Map<string, Entry>();
  const stats = new Map<string, FileStat>();
  /** The files that the vault holds, whatever is to become of them */
  const present = new Set<string>();
  {
    let gitignore = decode((await fs.read(".gitignore")) ?? new Uint8Array(0));
    const found: string[] = [];
    /** The `.gitignore` files that have a say in a folder, the one of the vault first */
    type Level = { dir: string; decide: Verdict };
    const ignored = (levels: Level[], path: string, isDir: boolean): boolean => {
      // As in git, the file of the innermost folder that says something decides
      for (let i = levels.length - 1; i >= 0; i--) {
        const { dir, decide } = levels[i];
        const said = decide(dir === "" ? path : path.slice(dir.length + 1), isDir);
        if (said !== undefined) {
          return said;
        }
      }
      return false;
    };
    // A folder that is ignored is not gone into, so nothing inside it is brought back
    const walk = async (dir: string, above: Level[]): Promise<void> => {
      const listing = await fs.list(dir);
      let levels = above;
      if (dir !== "" && listing.files.includes(".gitignore")) {
        const own = await fs.read(join(dir, ".gitignore"));
        if (own !== null) {
          levels = [...above, { dir, decide: verdict(decode(own)) }];
        }
      }
      for (const name of listing.files) {
        const path = join(dir, name);
        if (!excluded(path, false) && (base.has(path) || !ignored(levels, path, false))) {
          found.push(path);
        }
      }
      for (const name of listing.dirs) {
        const path = join(dir, name);
        if (!excluded(path, true) && !ignored(levels, path, true)) {
          await walk(path, levels);
        }
      }
    };
    await walk("", [{ dir: "", decide: verdict(gitignore) }]);
    const seen = new Set(found);
    // A file that is tracked stays tracked when its folder is ignored later
    for (const path of base.keys()) {
      if (!seen.has(path) && !excluded(path, false) && (await fs.stat(path)) !== null) {
        found.push(path);
        seen.add(path);
      }
    }

    const tooLarge: string[] = [];
    for (const path of found) {
      const stat = await fs.stat(path);
      if (stat === null) {
        continue;
      }
      if (stat.size > options.maxFileBytes && !base.has(path)) {
        tooLarge.push(path);
      }
    }
    if (tooLarge.length > 0) {
      gitignore = addToBlock(gitignore, tooLarge);
      await fs.write(".gitignore", encode(gitignore));
      result.tooLargeIgnored = tooLarge;
      if (!seen.has(".gitignore")) {
        found.push(".gitignore");
      }
      log(`${tooLarge.length} file(s) are too large to send and were written into .gitignore`);
    }
    const skip = new Set(tooLarge);

    for (const path of found) {
      if (skip.has(path)) {
        continue;
      }
      const stat = await fs.stat(path);
      if (stat === null) {
        continue;
      }
      present.add(path);
      const agreed = base.get(path);
      const before = state.stat[path];
      const unchanged =
        agreed !== undefined &&
        before !== undefined &&
        before.size === stat.size &&
        before.mtime === stat.mtime &&
        // A file that is too large to read cannot be looked at again, so its size and time have to do
        (state.racy?.[path] !== true || stat.size > options.maxFileBytes);
      if (unchanged) {
        here.set(path, agreed);
      } else if (stat.size > options.maxFileBytes) {
        // Tracked, changed, and too large to read and send: the remote keeps its version
        // No new size and time are noted, so that every sync says so again
        here.set(path, agreed!);
        result.tooLargeChanged.push(path);
        continue;
      } else {
        const data = await fs.read(path);
        if (data === null) {
          continue;
        }
        const oid = await objectId({ type: "blob", data });
        here.set(path, { oid, mode: agreed !== undefined && isFile(agreed) ? agreed.mode : MODE_FILE });
      }
      stats.set(path, stat);
    }
    // What is tracked but not in the vault on purpose counts as unchanged
    for (const [path, entry] of base) {
      if (!here.has(path) && (state.absent[path] === true || !isFile(entry))) {
        here.set(path, entry);
      }
    }
  }

  // --- Compare, path by path ------------------------------------------------
  const agreed = new Map(base);
  const absent = new Set(Object.keys(state.absent));
  /** The tree of the commit that this sync leaves on the remote */
  const target = new Map(there);
  /** `from` is where the remote has the content, when that is not `path` */
  const downloads: { path: string; entry: Entry; from?: string }[] = [];
  /** The commit that `there` was read from */
  const thereCommit = tip;
  const uploads: string[] = [];
  const removeHere: string[] = [];
  const paths = new Set([...base.keys(), ...here.keys(), ...there.keys()]);
  for (const path of paths) {
    if (excluded(path, false)) {
      // Never synced: whatever the remote has under this name stays there, and is not taken
      continue;
    }
    const b = base.get(path);
    const h = here.get(path);
    const t = there.get(path);
    if (same(h, b)) {
      if (!same(t, b)) {
        if (t === undefined) {
          removeHere.push(path);
        } else {
          downloads.push({ path, entry: t });
        }
      }
    } else if (same(t, b)) {
      if (h === undefined) {
        target.delete(path);
        result.deletedThere.push(path);
      } else {
        uploads.push(path);
      }
    } else if (same(h, t)) {
      // Both sides made the same change
      if (h === undefined) {
        agreed.delete(path);
      } else {
        agreed.set(path, h);
      }
    } else if (h === undefined) {
      // Removed here, changed there: the change wins
      downloads.push({ path, entry: t! });
    } else if (t === undefined) {
      // Changed here, removed there: the change wins
      uploads.push(path);
    } else {
      const copy = conflictPath(path, now, (p) => paths.has(p) || target.has(p));
      target.set(copy, t);
      downloads.push({ path: copy, entry: t, from: path });
      uploads.push(path);
      result.conflicts.push({ path, copy });
    }
  }

  // --- A name that is a file on one side and a folder on the other ----------
  // Neither a vault nor a commit can hold both. What the vault holds keeps its
  // name, and what the remote has goes beside it under another name, as with
  // a file that both sides changed.
  {
    const removing = new Set(removeHere);
    const isHere = (path: string): boolean => present.has(path) && !removing.has(path);
    const names = new Set([...target.keys(), ...uploads]);
    const folders = new Set<string>();
    for (const name of names) {
      for (let dir = folderOf(name); dir !== ""; dir = folderOf(dir)) {
        folders.add(dir);
      }
    }
    const taken = (path: string): boolean => paths.has(path) || names.has(path) || folders.has(path);
    /** Gives what the remote has at `from` the name `to`: in the commit, and where it is taken to */
    const move = (from: string, to: string): void => {
      const entry = target.get(from);
      if (entry === undefined) {
        return;
      }
      target.delete(from);
      target.set(to, entry);
      names.add(to);
      const download = downloads.find((item) => item.path === from);
      if (download !== undefined) {
        download.from = download.from ?? from;
        download.path = to;
      } else {
        // Tracked but not in the vault. Only its name changes.
        agreed.delete(from);
        agreed.set(to, entry);
        if (absent.delete(from)) {
          absent.add(to);
        }
      }
      result.conflicts.push({ path: from, copy: to });
    };
    for (const file of [...names].filter((name) => folders.has(name)).sort()) {
      if (isHere(file)) {
        // A file here and a folder there: the folder of the remote gets the other name
        const copy = conflictPath(file, now, taken);
        for (const inside of [...target.keys()]) {
          if (inside.startsWith(`${file}/`) && !isHere(inside)) {
            move(inside, copy + inside.slice(file.length));
          }
        }
      } else {
        // A folder here and a file there
        move(file, conflictPath(file, now, taken));
      }
    }
  }

  const saveState = async (): Promise<void> => {
    const next: State = {
      version: 1,
      url: remote.url,
      branch,
      commit: tip,
      tree: Object.fromEntries(agreed),
      stat: {},
      absent: {},
      racy: {},
    };
    // A file that changed this shortly before now can change again without its time moving on
    const racyAfter = Date.now() - RACY_MS;
    for (const path of agreed.keys()) {
      const stat = stats.get(path);
      if (absent.has(path)) {
        next.absent[path] = true;
      } else if (stat !== undefined) {
        next.stat[path] = stat;
        if (stat.mtime > racyAfter) {
          next.racy![path] = true;
        }
      }
    }
    await fs.write(statePath, encode(JSON.stringify(next)));
  };

  /** True if a file is no longer what the scan saw. Such a file is left for the next sync. */
  const changedSinceScan = async (path: string): Promise<boolean> => {
    const seen = stats.get(path);
    const stat = await fs.stat(path);
    if (seen === undefined || stat === null) {
      return (seen === undefined) !== (stat === null);
    }
    return seen.size !== stat.size || seen.mtime !== stat.mtime;
  };

  try {
    // --- Give what this device changed --------------------------------------
    // Sending comes first. If the sync stops after it, the next one finds the
    // remote ahead and simply takes what is left to take.
    const groups: string[][] = [];
    {
      let group: string[] = [];
      let bytes = 0;
      for (const path of uploads) {
        const size = stats.get(path)?.size ?? 0;
        if (group.length > 0 && bytes + size > options.batchBytes) {
          groups.push(group);
          group = [];
          bytes = 0;
        }
        group.push(path);
        bytes += size;
      }
      if (group.length > 0) {
        groups.push(group);
      }
    }
    // Removals and the copies of conflicts need a commit even if no content is sent
    if (groups.length === 0 && (target.size !== there.size || [...target].some(([path, entry]) => !same(entry, there.get(path))))) {
      groups.push([]);
    }

    const who = signature(options.author.name, options.author.email, now);
    for (const group of groups) {
      const blobs: GitObject[] = [];
      const sent: { path: string; entry: Entry; stat: FileStat }[] = [];
      for (const path of group) {
        const stat = await fs.stat(path);
        const data = stat === null ? null : await fs.read(path);
        if (stat === null || data === null || data.length > options.maxFileBytes) {
          result.busy.push(path);
          continue;
        }
        const blob: GitObject = { type: "blob", data };
        const entry = { oid: await objectId(blob), mode: here.get(path)!.mode };
        if (!same(entry, target.get(path))) {
          blobs.push(blob);
          target.set(path, entry);
        }
        sent.push({ path, entry, stat });
      }
      const built = await buildTrees(target);
      if (built.root !== thereRoot) {
        const trees = [...built.trees].filter(([oid]) => !knownTrees.has(oid));
        const commit: GitObject = {
          type: "commit",
          data: serializeCommit({
            tree: built.root,
            parents: tip === null ? [] : [tip],
            author: who,
            committer: who,
            message: options.message(now),
          }),
        };
        const commitOid = await objectId(commit);
        const pack = await writePack([...blobs, ...trees.map(([, tree]) => tree), commit]);
        await push(http, remote, { ref, oldOid: tip ?? ZERO_OID, newOid: commitOid, pack });

        for (const [oid, tree] of trees) {
          await store.write(tree, oid);
          knownTrees.add(oid);
        }
        await store.write(commit, commitOid);
        tip = commitOid;
        thereRoot = built.root;
        log(`sent ${blobs.length} file(s) as ${commitOid.slice(0, 7)}`);
      }
      for (const { path, entry, stat } of sent) {
        agreed.set(path, entry);
        stats.set(path, stat);
        absent.delete(path);
        result.uploaded.push(path);
      }
      for (const path of result.deletedThere) {
        agreed.delete(path);
        absent.delete(path);
      }
    }

    // --- Take what the remote changed ---------------------------------------
    const emptied = new Set<string>();
    for (const path of removeHere) {
      if (await changedSinceScan(path)) {
        result.busy.push(path);
        continue;
      }
      await fs.remove(path);
      stats.delete(path);
      agreed.delete(path);
      absent.delete(path);
      result.deletedHere.push(path);
      for (let dir = folderOf(path); dir !== ""; dir = folderOf(dir)) {
        emptied.add(dir);
      }
    }
    // A folder that lost its last file goes too, the innermost first. One that still holds something stays.
    for (const dir of [...emptied].sort((a, b) => b.length - a.length)) {
      await fs.removeDir(dir);
    }

    if (downloads.length > 0) {
      const sizes = (thereRoot !== null ? await options.sizes?.(thereRoot) : undefined) ?? new Map<string, number>();
      /** The paths that wait for the content with an id */
      const wanted = new Map<string, { path: string; entry: Entry }[]>();
      const settle = (path: string, entry: Entry, isAbsent: boolean): void => {
        agreed.set(path, entry);
        if (isAbsent) {
          absent.add(path);
          stats.delete(path);
        } else {
          absent.delete(path);
        }
      };
      /**
       * Does what puts a file into the vault. False if the vault has something in
       * its place that does not give way, such as a file where a folder is to be.
       * An empty folder with the name of the file does give way.
       */
      const put = async (path: string, write: () => Promise<boolean>): Promise<boolean> => {
        try {
          return await write();
        } catch {
          await fs.removeDir(path);
        }
        try {
          return await write();
        } catch {
          result.busy.push(path);
          return false;
        }
      };
      for (const { path, entry, from } of downloads) {
        if (!isFile(entry)) {
          // A link or a repository inside the repository: tracked, but not made in the vault
          settle(path, entry, true);
          continue;
        }
        if (await changedSinceScan(path)) {
          result.busy.push(path);
          continue;
        }
        const size = sizes.get(entry.oid);
        if (size !== undefined && size > options.maxFileBytes) {
          const file = { oid: entry.oid, size, commit: thereCommit!, path: from ?? path };
          const { largeBlob } = options;
          const busyBefore = result.busy.length;
          if (largeBlob !== undefined && (await put(path, () => largeBlob(file, path)))) {
            const stat = await fs.stat(path);
            if (stat !== null) {
              stats.set(path, stat);
            }
            settle(path, entry, false);
            result.downloaded.push(path);
          } else if (result.busy.length === busyBefore) {
            settle(path, entry, true);
            result.tooLargeThere.push(path);
          }
          continue;
        }
        const list = wanted.get(entry.oid);
        if (list === undefined) {
          wanted.set(entry.oid, [{ path, entry }]);
        } else {
          list.push({ path, entry });
        }
      }

      // A size that is not known counts as a guess, so that a batch still ends somewhere
      const GUESS = 64 * 1024;
      let batch: string[] = [];
      let bytes = 0;
      const flush = async (): Promise<void> => {
        if (batch.length === 0) {
          return;
        }
        const fetched = await fetchPack(http, remote, { wants: batch });
        const byOid = new Map((await parsePack(fetched.pack)).map((object) => [object.oid, object]));
        for (const oid of batch) {
          const object = byOid.get(oid);
          if (object === undefined || object.type !== "blob") {
            throw new Error(`fetch: the server did not send ${oid}`);
          }
          for (const { path, entry } of wanted.get(oid)!) {
            const { data } = object;
            const written = await put(path, async () => {
              await fs.write(path, data);
              return true;
            });
            if (!written) {
              continue;
            }
            const stat = await fs.stat(path);
            if (stat !== null) {
              stats.set(path, stat);
            }
            settle(path, entry, false);
            result.downloaded.push(path);
          }
        }
        batch = [];
        bytes = 0;
      };
      for (const oid of wanted.keys()) {
        const size = sizes.get(oid) ?? GUESS;
        if (batch.length > 0 && bytes + size > options.batchBytes) {
          await flush();
        }
        batch.push(oid);
        bytes += size;
      }
      await flush();
    }
  } finally {
    await saveState();
  }
  result.commit = tip;
  return result;
}
