import { decode, encode } from "./bytes.ts";
import { type FileStat, type Fs, join } from "./fs.ts";
import { type Http } from "./http.ts";
import { addToBlock, type Verdict, verdict } from "./ignore.ts";
import { isText, merge3 } from "./merge.ts";
import {
  type GitObject,
  MODE_EXECUTABLE,
  MODE_FILE,
  MODE_LINK,
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
import { capabilities, fetchPack, lsRefs, objectSizes, push, RejectedError, type Remote, RemoteError, ZERO_OID } from "./protocol.ts";
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
  /**
   * True on a device that keeps a name like "é.md" or "한글.md" with each
   * letter taken apart into its parts, whatever the name was written as, and
   * finds it under either form: an iPhone, an iPad, a Mac. The names of the
   * vault are then read as the repository spells them, and a new name is sent
   * with its letters in one piece, as git does on a Mac.
   */
  composeNames?: boolean;
  /**
   * False to never put together what both sides made of a text. The version
   * of the remote then always takes the name, and the one of the vault is
   * kept beside it, as a copy.
   */
  mergeText?: boolean;
  /** A file larger than this is neither sent nor asked for in one piece */
  maxFileBytes: number;
  /** Contents of files are asked for, and sent, in batches of about this size */
  batchBytes: number;
  /**
   * The sizes of the files under a tree, by their ids, if the host has a way
   * of its own to tell. Without it the server is asked as git would ask, which
   * works where the server offers it.
   */
  sizes?: (treeOid: string) => Promise<Map<string, number>>;
  /** Gets a file that is too large for one response and writes it to `path` in the vault. False if it cannot. */
  largeBlob?: (file: LargeFile, path: string) => Promise<boolean>;
  /** Told how far the sync is, for a person who waits */
  onProgress?: (progress: Progress) => void;
  /**
   * Asked before anything is changed on either side, with what the sync is
   * about to do. False stops the sync there, with a `CancelledError`.
   */
  confirm?: (plan: Plan) => Promise<boolean>;
  now?: () => Date;
  log?: (message: string) => void;
  /**
   * Waits so many milliseconds. Called before the sync starts over after the
   * remote turned away what it sent. Without it the sync starts over at once.
   */
  wait?: (ms: number) => Promise<void>;
}

/** How far a sync is: what it is at, and how many files of how many are done with. */
export interface Progress {
  step: "looking" | "sending" | "taking";
  done: number;
  total: number;
}

/** What a sync is about to do. */
export interface Plan {
  /** True if this vault and this remote have not been synced before */
  first: boolean;
  /** How many files had been agreed on */
  tracked: number;
  /** How many files come from the remote, and how many go there */
  take: number;
  send: number;
  /** Files that the sync removes from the vault, and from the remote */
  removeHere: string[];
  removeThere: string[];
  /** Files that differ on the two sides at a first sync. The version of the remote takes their place. */
  replace: string[];
  /**
   * Files that both sides changed. They are put together where they are
   * texts and it works out. Else the version of the remote takes the name,
   * and the one of the vault is kept beside it as a copy.
   */
  bothChanged: string[];
}

/** Thrown when the sync was stopped by what `confirm` said. Nothing was changed. */
export class CancelledError extends Error {
  constructor() {
    super("The sync was stopped before it changed anything.");
  }
}

export interface SyncResult {
  /** The commit that the remote and this device now agree on, if there is one */
  commit: string | null;
  downloaded: string[];
  uploaded: string[];
  deletedHere: string[];
  deletedThere: string[];
  /** Texts that both sides changed in different places. The vault and the remote now hold both changes. */
  merged: string[];
  /** Files that both sides changed: the version of the remote has the name, and the one of this side is at `copy` */
  conflicts: { path: string; copy: string }[];
  /** Files that differed at the first sync with the remote. The version of the remote took their place. */
  replaced: string[];
  /**
   * Names that are a file on one side and a folder on the other. What the
   * vault holds keeps the name, and what the remote has is at `copy`.
   */
  clashes: { path: string; copy: string }[];
  /** New files that were too large to send. They were written into `.gitignore`. */
  tooLargeIgnored: string[];
  /** Files of the remote that were changed here and are now too large to send. The remote keeps its version. */
  tooLargeChanged: string[];
  /** Files of the remote that are too large to get on this device. They are left out of the vault. */
  tooLargeThere: string[];
  /**
   * Files of the remote that the vault already holds under a name that differs
   * in capital letters only. This device cannot hold both. They are left out of the vault.
   */
  sameName: string[];
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
  /** Paths of `tree` that are not in the vault: too large, named like another file, or not a file */
  absent: Record<string, true>;
  /** The sizes of the files of `absent` that are not in the vault because they are too large */
  large?: Record<string, number>;
  /**
   * Files that were changed so shortly before `stat` was noted that another
   * change could leave their size and time as they are. They are read again.
   */
  racy?: Record<string, true>;
  /**
   * True while the first sync with the remote has not come to its end. One
   * that was cut off goes on as a first sync, and not as one after it.
   */
  joining?: true;
}

/**
 * How far apart two changes of a file are at least for its time to differ:
 * the coarsest clock of a file system that a vault is kept on, and a little more.
 */
const RACY_MS = 3000;

/** How often a sync starts over because another device moved the branch in the meantime */
const ATTEMPTS = 3;
/** How long a sync waits before it starts over the first time. The second time it waits twice as long. */
const RETRY_WAIT_MS = 1500;

/**
 * How many things the files of the vault are asked at once. On a phone each
 * answer takes its time whatever is asked, and the answers do not wait for
 * one another.
 */
const AT_ONCE = 8;

/** A file up to this size is read while others are read. A larger one is read alone, so that not much is held at a time. */
const SMALL_BYTES = 256 * 1024;

/** Lets a few jobs run at once, and the others wait for their turn. */
class Gate {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(atOnce: number) {
    this.free = atOnce;
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.free > 0) {
      this.free--;
    } else {
      // Whoever is done hands its turn on, so the count stays as it is
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next === undefined) {
        this.free++;
      } else {
        next();
      }
    }
  }
}

/** What a look at the vault finds. */
interface Looked {
  /** The text of the `.gitignore` at the top, or "" if there is none */
  gitignore: string;
  /** The paths of the files that the sync is about */
  found: string[];
  seen: Set<string>;
  /** The size and time of each of them that is there */
  scanned: Map<string, FileStat>;
}

/** A path that has `.git` as one of its names, in whatever case, as git itself looks for it */
const DOT_GIT = /(?:^|\/)\.git(?:\/|$)/i;

/** Endings of names of files that are text, and with that mostly small */
const TEXT_KINDS = new Set(["md", "txt", "json", "canvas", "base", "css", "js", "ts", "yaml", "yml", "csv", "html", "xml", "svg", ""]);

class MissingObjectError extends Error {}

function same(a: Entry | undefined, b: Entry | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode);
}

function isFile(entry: Entry): boolean {
  return entry.mode === MODE_FILE || entry.mode === MODE_EXECUTABLE;
}

/**
 * True for what a vault can hold: a file, or a link. A repository inside the
 * repository is not made in the vault, as git does not get one unless told to.
 */
function inVault(entry: Entry): boolean {
  return isFile(entry) || entry.mode === MODE_LINK;
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

/** The name of `path` up to its ending, and the ending. */
function stemOf(path: string): { stem: string; ext: string } {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? { stem: path.slice(0, dot), ext: path.slice(dot) } : { stem: path, ext: "" };
}

/** True if `candidate` is a name that `conflictPath` gives for `path`. */
function isCopyOf(candidate: string, path: string): boolean {
  const { stem, ext } = stemOf(path);
  const start = `${stem} (conflict `;
  const end = `)${ext}`;
  return (
    candidate.length > start.length + end.length &&
    candidate.startsWith(start) &&
    candidate.endsWith(end) &&
    /^\d{4}-\d{2}-\d{2} \d{4}(?: \d+)?$/.test(candidate.slice(start.length, candidate.length - end.length))
  );
}

/** A name next to `path` for the other side of a conflict. */
function conflictPath(path: string, when: Date, taken: (path: string) => boolean): string {
  const { stem, ext } = stemOf(path);
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
 * Where both changed a file and the two cannot be put together, the remote
 * is right: its version takes the name, and the one of the vault is kept
 * beside it under another name. At the first sync with a remote, a file that
 * differs is replaced by the one of the remote. The changes of the device
 * then become one commit on top of the remote, so the history of the branch
 * stays a line.
 */
export async function sync(options: SyncOptions): Promise<SyncResult> {
  /** What an attempt did before the remote refused the rest */
  const done = { uploaded: [] as string[], tooLargeIgnored: [] as string[] };
  // Asked once, and not again when the sync starts over
  let confirmed = false;
  const { confirm } = options;
  const asked: SyncOptions =
    confirm === undefined
      ? options
      : {
          ...options,
          confirm: async (plan) => {
            confirmed = confirmed || (await confirm(plan));
            return confirmed;
          },
        };
  for (let attempt = 1; ; attempt++) {
    const result = emptyResult();
    try {
      await attemptSync(asked, result);
    } catch (error) {
      // Another device sent something while this one was at it. What the remote
      // holds now is looked at again, and the sync goes on from there.
      if (error instanceof RejectedError && attempt < ATTEMPTS) {
        done.uploaded.push(...result.uploaded);
        done.tooLargeIgnored.push(...result.tooLargeIgnored);
        (options.log ?? (() => undefined))(`the branch moved while the sync ran, looking at it again (${error.message})`);
        // Not at once: a server that is still at work on what it was sent a moment ago turns away
        // what comes right after it, and so it does again if it is asked again right away
        await options.wait?.(RETRY_WAIT_MS * attempt);
        continue;
      }
      throw error;
    }
    result.uploaded = [...new Set([...done.uploaded, ...result.uploaded])];
    result.tooLargeIgnored = [...new Set([...done.tooLargeIgnored, ...result.tooLargeIgnored])];
    return result;
  }
}

function emptyResult(): SyncResult {
  return {
    commit: null,
    downloaded: [],
    uploaded: [],
    deletedHere: [],
    deletedThere: [],
    merged: [],
    conflicts: [],
    replaced: [],
    clashes: [],
    tooLargeIgnored: [],
    tooLargeChanged: [],
    tooLargeThere: [],
    sameName: [],
    busy: [],
  };
}

async function attemptSync(options: SyncOptions, result: SyncResult): Promise<void> {
  const { fs, http, remote } = options;
  const log = options.log ?? (() => undefined);
  const now = (options.now ?? (() => new Date()))();
  const store = new ObjectStore(fs, options.storeDir);
  const statePath = `${options.storeDir}/state.json`;
  const excluded = (path: string, isDir: boolean): boolean =>
    path === options.storeDir ||
    path.startsWith(`${options.storeDir}/`) ||
    // At the top of the vault or in any folder of it: what git keeps there is not a part of what
    // it tracks, and no server takes a commit with such a name in it
    DOT_GIT.test(path) ||
    (options.exclude?.(path, isDir) ?? false);

  // --- How the vault spells its names ----------------------------------------
  // Most phones and computers take "a.md" and "A.md" for the same file, and git
  // does not. So a file is in the vault only if the vault spells every name of
  // its path as the path does, and what the remote has under another spelling
  // of a name of the vault cannot be put beside it.
  //
  // Some devices also keep "é" as "e" and an accent, and "한" as its three
  // parts, whatever the name was written as. There a name of the vault is the
  // name that the repository has for it, and a new one has its letters in one
  // piece, so that a name does not change by going through such a device.
  /** How the repository spells a path or a folder, by the path with its letters in one piece */
  const spelling = new Map<string, string>();
  const noteSpelling = (paths: Iterable<string>): void => {
    if (options.composeNames !== true) {
      return;
    }
    for (const path of paths) {
      for (let at = path; at !== ""; at = folderOf(at)) {
        const composed = at.normalize("NFC");
        if (!spelling.has(composed)) {
          spelling.set(composed, at);
        }
      }
    }
  };
  /** The name of something in a folder of the vault, as the sync calls it */
  const named = (dir: string, name: string): string => {
    if (options.composeNames !== true) {
      return name;
    }
    const known = spelling.get(join(dir, name).normalize("NFC"));
    return known !== undefined && folderOf(known) === dir ? known.slice(dir === "" ? 0 : dir.length + 1) : name.normalize("NFC");
  };
  const gate = new Gate(AT_ONCE);
  const listings = new Map<string, { files: Set<string>; dirs: Set<string> }>();
  /** The folders that are asked about or were, so that each is asked once also when two ask at the same time */
  const listingJobs = new Map<string, Promise<{ files: Set<string>; dirs: Set<string> }>>();
  const listing = (dir: string): Promise<{ files: Set<string>; dirs: Set<string> }> => {
    let job = listingJobs.get(dir);
    if (job === undefined) {
      job = gate
        .run(() => fs.list(dir))
        .then(({ files, dirs }) => {
          const listed = { files: new Set(files.map((name) => named(dir, name))), dirs: new Set(dirs.map((name) => named(dir, name))) };
          listings.set(dir, listed);
          return listed;
        });
      listingJobs.set(dir, job);
    }
    return job;
  };
  /** Notes that the sync made a file, and with it the folders above it. */
  const noteWritten = (path: string): void => {
    const names = path.split("/");
    let dir = "";
    names.forEach((name, i) => {
      const listed = listings.get(dir);
      if (listed !== undefined) {
        (i === names.length - 1 ? listed.files : listed.dirs).add(name);
      }
      dir = join(dir, name);
    });
  };
  /** True if the vault holds a file or a folder of the path, but under another spelling. */
  const spelledOtherwise = async (path: string): Promise<boolean> => {
    const names = path.split("/");
    let dir = "";
    for (let i = 0; i < names.length; i++) {
      const isLast = i === names.length - 1;
      const listed = await listing(dir);
      const next = join(dir, names[i]);
      if (!(isLast ? listed.files : listed.dirs).has(names[i])) {
        // Not there under this spelling. If the file system finds it all the same, it is there under another.
        return isLast ? (await fs.stat(next)) !== null : await fs.isDir(next);
      }
      dir = next;
    }
    return false;
  };

  /** Where a link points, as the repository keeps it, or null for what is not a link or cannot be told from a file. */
  const linkAt = async (path: string): Promise<Uint8Array | null> => {
    const target = (await fs.readLink?.(path)) ?? null;
    return target === null ? null : encode(target);
  };

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
  /**
   * Finds the files of the vault that the sync is about, and the size and
   * time of each. The folders are asked a few at once. Of the remote this
   * needs nothing but the rules that come from it, so it can start before
   * the remote has answered.
   * @param rules the text of each `.gitignore` that counts in place of the one of the vault, by its path
   * @param base what was agreed on, and `known` what was noted of the files then
   */
  const look = async (rules: Map<string, string>, base: Map<string, Entry>, known: State): Promise<Looked> => {
    const gitignore = rules.get(".gitignore") ?? decode((await gate.run(() => fs.read(".gitignore"))) ?? new Uint8Array(0));
    // A folder that is ignored is not gone into, so nothing inside it is brought back
    const walk = async (dir: string, above: Level[]): Promise<string[]> => {
      const listed = await listing(dir);
      let levels = above;
      if (dir !== "") {
        const at = join(dir, ".gitignore");
        let own = rules.get(at);
        if (own === undefined && listed.files.has(".gitignore")) {
          const data = await gate.run(() => fs.read(at));
          own = data === null ? undefined : decode(data);
        }
        if (own !== undefined) {
          levels = [...above, { dir, decide: verdict(own) }];
        }
      }
      const files: string[] = [];
      for (const name of listed.files) {
        const path = join(dir, name);
        if (!excluded(path, false) && (base.has(path) || !ignored(levels, path, false))) {
          files.push(path);
        }
      }
      const inside: Promise<string[]>[] = [];
      for (const name of listed.dirs) {
        const path = join(dir, name);
        if (!excluded(path, true) && !ignored(levels, path, true)) {
          inside.push(walk(path, levels));
        }
      }
      // In the order of the folders, whichever of them answered first
      return files.concat(...(await Promise.all(inside)));
    };
    const found = await walk("", [{ dir: "", decide: verdict(gitignore) }]);
    const seen = new Set(found);
    // A file that is tracked stays tracked when its folder is ignored later.
    // One that got another spelling here is a file with another name now.
    const unseen = [...base.keys()].filter((path) => !seen.has(path) && !excluded(path, false));
    const still = await Promise.all(unseen.map((path) => gate.run(() => fs.stat(path))));
    /** What the disk said a moment ago, so that it is not asked again */
    const asked = new Map<string, FileStat>();
    for (let i = 0; i < unseen.length; i++) {
      const stat = still[i];
      if (stat !== null && !(await spelledOtherwise(unseen[i]))) {
        found.push(unseen[i]);
        seen.add(unseen[i]);
        asked.set(unseen[i], stat);
      }
    }
    const sizes = await Promise.all(
      found.map(async (path) => {
        const before = known.stat[path];
        // Where the app has the size and time of its files in mind, a file that is as it was costs no look at the disk
        if (fs.quickStat !== undefined && before !== undefined && base.has(path) && known.racy?.[path] !== true) {
          const inMind = await fs.quickStat(path);
          if (inMind !== null && inMind.size === before.size && inMind.mtime === before.mtime) {
            return before;
          }
        }
        return asked.get(path) ?? gate.run(() => fs.stat(path));
      }),
    );
    const scanned = new Map<string, FileStat>();
    found.forEach((path, i) => {
      const stat = sizes[i];
      if (stat !== null) {
        scanned.set(path, stat);
      }
    });
    return { gitignore, found, seen, scanned };
  };

  // --- What was agreed on last time -----------------------------------------
  let state: State = { version: 1, url: remote.url, branch: "", commit: null, tree: {}, stat: {}, absent: {} };
  const saved = await fs.read(statePath);
  /** True if there was a sync before, and what it agreed on is lost */
  let lost = false;
  /** The file of last time as it is, to see afterwards whether there is anything new to write into it */
  const savedText = saved === null ? null : decode(saved);
  if (savedText !== null) {
    let parsed: State | null = null;
    try {
      parsed = JSON.parse(savedText) as State;
    } catch {
      // Cut off, as after an app that was stopped while it wrote. The vault joins the remote anew:
      // nothing is removed on either side. A file that differs may hold what this device changed
      // since, so the version of the vault is kept beside the one of the remote, as a copy.
      lost = true;
      log("what was agreed on last time cannot be read: the vault joins the remote anew");
    }
    if (parsed !== null && typeof parsed === "object" && typeof parsed.tree === "object") {
      if (parsed.url !== remote.url) {
        throw new Error(
          `This vault was synced with ${parsed.url}. To sync it with another repository, remove the folder ${options.storeDir} first.`,
        );
      }
      state = { ...state, ...parsed, stat: parsed.stat ?? {}, absent: parsed.absent ?? {} };
    }
  }

  // --- What the remote holds now --------------------------------------------
  const progress = options.onProgress ?? (() => undefined);
  progress({ step: "looking", done: 0, total: 0 });
  // The look at the vault starts now and goes on while the remote answers: the two do not wait for
  // each other. Not where names are read as the remote spells them, which is not known yet.
  const stateAtFirst = state;
  const early = options.composeNames === true ? null : look(new Map(), new Map(Object.entries(state.tree)), state);
  // If the sync stops before it asks for what this found, a failure of it is nobody's to hear
  early?.catch(() => undefined);
  const refs = await lsRefs(http, remote);
  const opensWith = refs.head?.slice("refs/heads/".length);
  // Without a branch that is asked for: the one of last time while the remote has it, and
  // then the one that the remote opens with, which is where a branch goes that gets another name
  const branch =
    options.branch ??
    (state.branch !== "" && (refs.heads.has(`refs/heads/${state.branch}`) || opensWith === undefined) ? state.branch : (opensWith ?? "main"));
  const ref = `refs/heads/${branch}`;
  /** The commit that the branch is at on the remote, or null while the remote has no such branch */
  let refTip = refs.heads.get(ref) ?? null;
  /** The commit that the vault is held against, and that the commits of this device stand on */
  let tip = refTip;
  if (tip === null && state.commit !== null) {
    if (state.branch !== branch && refs.heads.has(`refs/heads/${state.branch}`)) {
      // A branch that the remote does not have yet starts where the last sync left off, as with git
      tip = state.commit;
      log(`the remote has no branch ${branch}: it starts at ${tip.slice(0, 7)} of ${state.branch}`);
    } else {
      // The branch that was synced is gone from the remote. What was agreed on with it says nothing
      // any more: held against a remote with nothing in it, it would say that every file was removed
      // there. So it is forgotten, and the vault is sent as a branch that starts anew.
      log(`the remote has no branch ${branch} any more: it starts anew from what the vault holds`);
      state = { version: 1, url: remote.url, branch: "", commit: null, tree: {}, stat: {}, absent: {} };
    }
  }
  const base = new Map(Object.entries(state.tree));
  /**
   * True if this vault and this remote have not been synced to the end before.
   * What the vault holds then was not made from what the remote holds, so a
   * file that differs gives way to the one of the remote.
   */
  const first = !lost && (saved === null || state.commit === null || state.joining === true);

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

  /**
   * The files of a commit of the remote, as they were read from its folders
   * or as this device sent them. A remote that is at that commit is then
   * known by this one file, and not by one for each of its folders.
   */
  const flatPath = `${options.storeDir}/flat.json`;
  let there = new Map<string, Entry>();
  let knownTrees = new Set<string>();
  let thereRoot: string | null = null;
  if (tip !== null) {
    // The files of a commit, as they were read from its folders the last time. A remote that
    // has not moved is then known by one file, and not by one for each of its folders.
    let read: { entries: Map<string, Entry>; trees: Set<string>; root: string } | null = null;
    try {
      const kept = await fs.read(flatPath);
      const flat = kept === null ? null : (JSON.parse(decode(kept)) as { commit: string; root: string; entries: Record<string, Entry>; trees: string[] });
      if (flat !== null && flat.commit === tip && typeof flat.root === "string") {
        read = { entries: new Map(Object.entries(flat.entries)), trees: new Set(flat.trees), root: flat.root };
      }
    } catch {
      // Cut off or not there: the folders are read again
    }
    if (read === null) {
      if ((await store.read(tip)) === null) {
        // The commit of last time may be the one that is missing, if its file was lost
        await fetchCommit(tip, state.commit === tip ? null : state.commit);
      }
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
      await fs.write(flatPath, encode(JSON.stringify({ commit: tip, root: read.root, entries: Object.fromEntries(read.entries), trees: [...read.trees] })));
    }
    there = read.entries;
    knownTrees = read.trees;
    thereRoot = read.root;
  }

  // --- What the vault holds now ---------------------------------------------
  noteSpelling(base.keys());
  noteSpelling(there.keys());
  // A `.gitignore` of the remote that this sync is about to put into the vault
  // counts in this sync already, as it would after a pull with git. Without
  // that, a vault that meets a repository for the first time would send what
  // the repository leaves out on purpose.
  /** The text of such a file, by its path */
  const rulesToCome = new Map<string, string>();
  {
    const wants = new Map<string, string[]>();
    for (const [path, t] of there) {
      if ((path !== ".gitignore" && !path.endsWith("/.gitignore")) || !isFile(t) || excluded(path, false)) {
        continue;
      }
      const b = base.get(path);
      if (!first && same(t, b)) {
        // The remote left it as it was: the one of the vault counts, changed or not
        continue;
      }
      const data = await fs.read(path);
      const oid = data === null ? null : await objectId({ type: "blob", data });
      // The same on both sides, or changed here as well: what comes out of the two is not known yet
      if (oid === t.oid || (!first && oid !== null && oid !== b?.oid)) {
        continue;
      }
      wants.set(t.oid, [...(wants.get(t.oid) ?? []), path]);
    }
    if (wants.size > 0) {
      const fetched = await fetchPack(http, remote, { wants: [...wants.keys()] });
      for (const object of await parsePack(fetched.pack)) {
        for (const path of wants.get(object.oid) ?? []) {
          rulesToCome.set(path, decode(object.data));
        }
      }
    }
  }

  /** The sizes of contents that the remote holds, by their ids, as far as they were asked for and told */
  const knownSizes = new Map<string, number>();
  let hostAsked = false;
  /** Null until the server was asked whether it tells sizes */
  let serverTells: boolean | null = null;
  const askedFor = new Set<string>();
  /**
   * Asks for the sizes of contents of the remote, where they are not known
   * yet. The host is asked for all of them at once, in its own way. A server
   * is asked as git asks, which few servers answer.
   */
  const sizesFor = async (oids: string[]): Promise<Map<string, number>> => {
    if (options.sizes !== undefined) {
      if (!hostAsked) {
        hostAsked = true;
        if (thereRoot !== null) {
          for (const [oid, size] of await options.sizes(thereRoot)) {
            knownSizes.set(oid, size);
          }
        }
      }
      return knownSizes;
    }
    const missing = oids.filter((oid) => !askedFor.has(oid));
    if (missing.length > 0 && serverTells !== false) {
      try {
        serverTells ??= (await capabilities(http, remote)).has("object-info");
        if (serverTells) {
          for (const [oid, size] of await objectSizes(http, remote, missing)) {
            knownSizes.set(oid, size);
          }
        }
      } catch (error) {
        if (!(error instanceof RemoteError)) {
          throw error;
        }
        serverTells = false;
      }
      for (const oid of missing) {
        askedFor.add(oid);
      }
    }
    return knownSizes;
  };

  const here = new Map<string, Entry>();
  const stats = new Map<string, FileStat>();
  /**
   * The id of what a file held when its size and time were taken. They are
   * noted for the next sync only if that is what was agreed on: a change that
   * could not be sent must not look like no change the next time.
   */
  const seenAs = new Map<string, string>();
  /** The files that the vault holds, whatever is to become of them */
  const present = new Set<string>();
  /**
   * Files above the limit that are new by their name, and that are taken for
   * a tracked file that got another name: one that is gone and had the same
   * size to the byte. Such a file is too large to read and see what it holds.
   */
  const moved = new Map<string, Entry>();
  /**
   * Files above the limit that the remote has otherwise under the same name,
   * and that were never agreed on. `sizeKnown` is true if the size of the one
   * of the remote is known, so that it can be taken piece by piece. `stat` is
   * the size and time of the one of the vault, as the scan found them.
   */
  const largeOther = new Map<string, { sizeKnown: boolean; stat: FileStat }>();
  /** True if the paths of files that are too large were added to the `.gitignore` of the remote, and not to one of the vault */
  let addedToTheirs = false;
  {
    // What was found while the remote answered holds, unless the remote has a say in what is found
    let looked: Looked;
    if (early !== null && rulesToCome.size === 0 && state === stateAtFirst) {
      looked = await early;
    } else {
      await early?.catch(() => undefined);
      looked = await look(rulesToCome, base, state);
    }
    let { gitignore } = looked;
    const { found, seen, scanned } = looked;

    const tooLarge: string[] = [];
    /** Tracked files that the vault does not hold any more, by the size that they had */
    const gone = new Map<number, string[]>();
    for (const path of base.keys()) {
      const before = state.stat[path];
      if (!seen.has(path) && before !== undefined) {
        gone.set(before.size, [...(gone.get(before.size) ?? []), path]);
      }
    }
    /** Files above the limit that were never agreed on, and that the remote has a file for under the same name */
    const largeOnBoth: string[] = [];
    for (const path of found) {
      const stat = scanned.get(path);
      if (stat !== undefined && stat.size > options.maxFileBytes && !base.has(path)) {
        const was = gone.get(stat.size)?.shift();
        if (was !== undefined) {
          moved.set(path, base.get(was)!);
        } else if (there.has(path) && isFile(there.get(path)!)) {
          largeOnBoth.push(path);
        } else {
          tooLarge.push(path);
        }
      }
    }
    if (largeOnBoth.length > 0) {
      // Too large to read and see what it holds, as a file that got another name is. If it has,
      // to the byte, the size of the file of the remote, it is taken for that file. It is no new
      // file in any case, and is not written into `.gitignore`: the repository tracks it.
      const sizes = await sizesFor(largeOnBoth.map((path) => there.get(path)!.oid));
      for (const path of largeOnBoth) {
        const theirs = there.get(path)!;
        if (sizes.get(theirs.oid) === scanned.get(path)!.size) {
          moved.set(path, theirs);
        } else {
          largeOther.set(path, { sizeKnown: sizes.has(theirs.oid), stat: scanned.get(path)! });
        }
      }
    }
    if (tooLarge.length > 0) {
      gitignore = addToBlock(gitignore, tooLarge);
      await fs.write(".gitignore", encode(gitignore));
      noteWritten(".gitignore");
      addedToTheirs = rulesToCome.has(".gitignore");
      result.tooLargeIgnored = tooLarge;
      if (!seen.has(".gitignore")) {
        found.push(".gitignore");
      }
      // What the scan found of it holds no more
      const written = await fs.stat(".gitignore");
      if (written === null) {
        scanned.delete(".gitignore");
      } else {
        scanned.set(".gitignore", written);
      }
      log(`${tooLarge.length} file(s) are too large to send and were written into .gitignore`);
    }
    const skip = new Set([...tooLarge, ...largeOther.keys()]);

    /** True if a file has the size and time that it had when it was agreed on, so that it need not be read */
    const asItWas = (path: string, stat: FileStat): boolean => {
      const before = state.stat[path];
      return (
        base.has(path) &&
        before !== undefined &&
        before.size === stat.size &&
        before.mtime === stat.mtime &&
        // A file that is too large to read cannot be looked at again, so its size and time have to do
        (state.racy?.[path] !== true || stat.size > options.maxFileBytes)
      );
    };
    // The files that have to be read to know what they hold: new ones, and ones that are not as they were.
    // Small ones are read a few at once. A large one is read alone.
    /** What each of them holds, or null for one that is gone by now */
    const held = new Map<string, Entry | null>();
    const read = async (path: string): Promise<void> => {
      const agreed = base.get(path);
      const target = await linkAt(path);
      const data = target ?? (await fs.read(path));
      if (data === null) {
        held.set(path, null);
        return;
      }
      const oid = await objectId({ type: "blob", data });
      let mode = MODE_FILE;
      if (target !== null) {
        mode = MODE_LINK;
      } else if (agreed !== undefined && (isFile(agreed) || (agreed.mode === MODE_LINK && fs.readLink === undefined))) {
        // Whether a file may be run is not known here, so it stays as the repository has it.
        // So does a link where links cannot be made: it is a file there that holds where it points.
        mode = agreed.mode;
      }
      held.set(path, { oid, mode });
    };
    {
      const small: string[] = [];
      const large: string[] = [];
      for (const path of found) {
        const stat = scanned.get(path);
        if (stat === undefined || skip.has(path) || moved.has(path) || stat.size > options.maxFileBytes || asItWas(path, stat)) {
          continue;
        }
        (stat.size <= SMALL_BYTES ? small : large).push(path);
      }
      await Promise.all(small.map((path) => gate.run(() => read(path))));
      for (const path of large) {
        await read(path);
      }
    }

    for (const path of found) {
      if (skip.has(path)) {
        continue;
      }
      const stat = scanned.get(path);
      if (stat === undefined) {
        continue;
      }
      present.add(path);
      const known = moved.get(path);
      if (known !== undefined) {
        here.set(path, known);
        stats.set(path, stat);
        seenAs.set(path, known.oid);
        continue;
      }
      const agreed = base.get(path);
      if (agreed !== undefined && asItWas(path, stat)) {
        here.set(path, agreed);
      } else if (stat.size > options.maxFileBytes) {
        // Tracked, changed, and too large to read and send: the remote keeps its version
        // No new size and time are noted, so that every sync says so again
        here.set(path, agreed!);
        result.tooLargeChanged.push(path);
        continue;
      } else {
        const entry = held.get(path) ?? null;
        if (entry === null) {
          continue;
        }
        here.set(path, entry);
      }
      stats.set(path, stat);
      seenAs.set(path, here.get(path)!.oid);
    }
    // What is tracked but not in the vault on purpose counts as unchanged
    for (const [path, entry] of base) {
      if (!here.has(path) && (state.absent[path] === true || !inVault(entry))) {
        here.set(path, entry);
      }
    }
  }

  // --- Compare, path by path ------------------------------------------------
  const agreed = new Map(base);
  const absent = new Set(Object.keys(state.absent));
  /** The sizes of the files that were left out of the vault for their size */
  const large = new Map(Object.entries(state.large ?? {}));
  /**
   * Files that an earlier sync left out of the vault, and that this one looks
   * at again: the limit may have been raised since, or the file that had the
   * name may be gone. One that is left out again is not told about again.
   */
  const again = new Set<string>();
  /** The tree of the commit that this sync leaves on the remote */
  const target = new Map(there);
  /** `from` is where the remote has the content, when that is not `path` */
  const downloads: { path: string; entry: Entry; from?: string }[] = [];
  /** The commit that `there` was read from */
  const thereCommit = tip;
  const uploads: string[] = [];
  const removeHere: string[] = [];
  const paths = new Set([...base.keys(), ...here.keys(), ...there.keys()]);
  /** Files that both sides changed, and that may be texts that can be put together */
  const bothChanged: { path: string; b: Entry; h: Entry; t: Entry }[] = [];
  /** Files that differ at a first sync. The version of the remote takes their place. */
  const replaced = new Set<string>();
  /** Files of the vault that give way to the version of the remote, and go beside it under the name `copy` */
  const aside: { path: string; copy: string; h: Entry }[] = [];
  const copyNames = new Set<string>();
  /** Gives the name to the version of the remote, and keeps the one of the vault beside it. */
  const takeTheirs = (path: string, h: Entry, t: Entry): void => {
    // A sync that was cut off may have made the copy of this very version already
    let copy = [...here.keys()].find((other) => isCopyOf(other, path) && here.get(other)!.oid === h.oid);
    if (copy === undefined) {
      copy = conflictPath(path, now, (p) => paths.has(p) || target.has(p) || copyNames.has(p));
      copyNames.add(copy);
      aside.push({ path, copy, h });
    }
    downloads.push({ path, entry: t });
    result.conflicts.push({ path, copy });
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
  for (const path of paths) {
    if (excluded(path, false)) {
      // Never synced: whatever the remote has under this name stays there, and is not taken
      continue;
    }
    if (path === ".gitignore" && addedToTheirs) {
      // What the vault holds of it is the one of the remote, with the files that are too large added
      uploads.push(path);
      continue;
    }
    const tooLargeHere = largeOther.get(path);
    if (tooLargeHere !== undefined) {
      const theirs = there.get(path);
      if (first && tooLargeHere.sizeKnown && theirs !== undefined) {
        // Never synced with this remote: the remote is right, as for any file that differs
        downloads.push({ path, entry: theirs });
        replaced.add(path);
        // So that it is seen afterwards if the file changed while the sync ran
        stats.set(path, tooLargeHere.stat);
      } else {
        // Too large to send, and not to be taken without knowing how large it is: both stay as they are
        result.tooLargeChanged.push(path);
      }
      continue;
    }
    const b = base.get(path);
    let h = here.get(path);
    const t = there.get(path);
    if (b === undefined && h !== undefined && t !== undefined && h.oid === t.oid && h.mode === MODE_FILE) {
      // A file that was never agreed on holds what the remote has, and the remote says more about it:
      // that it may be run, or that it is a link. The device does not know such things. The remote is right.
      h = t;
      here.set(path, t);
    }
    if (same(h, b)) {
      if (!same(t, b)) {
        if (t === undefined) {
          removeHere.push(path);
        } else {
          downloads.push({ path, entry: t });
        }
      } else if (t !== undefined && inVault(t) && absent.has(path) && !present.has(path)) {
        // Left out before. A file that was too large is asked for only if the limit lets it in now.
        const size = large.get(path);
        if (size === undefined || size <= options.maxFileBytes) {
          downloads.push({ path, entry: t });
          again.add(path);
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
    } else if (!inVault(t)) {
      // A repository inside the repository, where the vault has a file: neither gives way
    } else if (b === undefined && first) {
      // Never synced with this remote: the remote is right
      downloads.push({ path, entry: t });
      replaced.add(path);
    } else if (options.mergeText !== false && b !== undefined && isFile(b) && isFile(h) && isFile(t)) {
      bothChanged.push({ path, b, h, t });
    } else {
      takeTheirs(path, h, t);
    }
  }

  if (options.confirm !== undefined) {
    const plan: Plan = {
      first: first || lost,
      tracked: base.size,
      take: downloads.length,
      send: uploads.length,
      removeHere: removeHere.filter((path) => !absent.has(path)),
      removeThere: [...result.deletedThere],
      replace: [...replaced],
      bothChanged: [...bothChanged.map((item) => item.path), ...result.conflicts.map((item) => item.path)],
    };
    if (!(await options.confirm(plan))) {
      throw new CancelledError();
    }
  }

  // --- A text that both sides changed ----------------------------------------
  // As git does it: what the two sides changed in different places of a text
  // is put together, line by line. The device keeps no contents of what was
  // agreed on, so the remote is asked for the text as it was. Where that does
  // not work out, the version of the remote takes the name.
  for (const { path, b, h, t } of bothChanged) {
    const stat = stats.get(path);
    const ours = stat === undefined || stat.size > options.batchBytes ? null : await fs.read(path);
    if (ours === null || !isText(ours)) {
      // Too large for one request, or not a text
      takeTheirs(path, h, t);
      continue;
    }
    if ((await objectId({ type: "blob", data: ours })) !== h.oid) {
      result.busy.push(path);
      continue;
    }
    let both: Uint8Array | null = null;
    let theirs: Uint8Array | undefined;
    try {
      const fetched = await fetchPack(http, remote, { wants: [b.oid, t.oid] });
      const byOid = new Map((await parsePack(fetched.pack)).map((object) => [object.oid, object.data]));
      const was = byOid.get(b.oid);
      theirs = byOid.get(t.oid);
      if (was !== undefined && theirs !== undefined) {
        both = merge3(was, ours, theirs);
      }
    } catch (error) {
      // A remote that no longer has the text as it was, after its history was rewritten
      if (!(error instanceof RemoteError) || error instanceof RejectedError) {
        throw error;
      }
    }
    if (both === null) {
      takeTheirs(path, h, t);
      continue;
    }
    const entry: Entry = { oid: await objectId({ type: "blob", data: both }), mode: h.mode !== b.mode ? h.mode : t.mode };
    if (await changedSinceScan(path)) {
      result.busy.push(path);
      continue;
    }
    if (entry.oid !== h.oid) {
      try {
        await fs.write(path, both);
      } catch (error) {
        // The text of this device is nowhere else. It is put back before the sync stops.
        await fs.write(path, ours);
        throw error;
      }
      const written = await fs.stat(path);
      if (written !== null) {
        stats.set(path, written);
      }
    }
    here.set(path, entry);
    seenAs.set(path, entry.oid);
    if (same(entry, t)) {
      // What this side changed, the remote changed too, and more
      agreed.set(path, entry);
    } else {
      uploads.push(path);
    }
    result.merged.push(path);
  }

  // --- A file that gives way to the version of the remote --------------------
  // What the vault holds of it is written beside it first, under another
  // name, and goes to the remote as a new file. Only then does the version of
  // the remote take the name, so that what this device made is never lost.
  for (const { path, copy, h } of aside) {
    const link = await linkAt(path);
    const data = link ?? (await fs.read(path));
    let stat: FileStat | null = null;
    if (data !== null && (await objectId({ type: "blob", data })) === h.oid) {
      if (link !== null && fs.writeLink !== undefined) {
        await fs.writeLink(copy, decode(link));
      } else {
        await fs.write(copy, data);
      }
      stat = await fs.stat(copy);
    }
    if (stat === null) {
      // Changed since it was looked at, or gone: the file stays as it is, for the next sync
      const planned = downloads.findIndex((item) => item.path === path);
      if (planned >= 0) {
        downloads.splice(planned, 1);
      }
      result.conflicts = result.conflicts.filter((item) => item.path !== path);
      result.busy.push(path);
      continue;
    }
    noteWritten(copy);
    present.add(copy);
    here.set(copy, h);
    stats.set(copy, stat);
    seenAs.set(copy, h.oid);
    uploads.push(copy);
  }

  // --- A name that is a file on one side and a folder on the other ----------
  // Neither a vault nor a commit can hold both. What the vault holds keeps its
  // name, and what the remote has goes beside it under another name: a folder
  // of the vault with all that it holds is not moved out of the way.
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
          const size = large.get(from);
          if (size !== undefined) {
            large.set(to, size);
          }
        }
      }
      result.clashes.push({ path: from, copy: to });
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

  /** True once the sync has done all that it set out to do */
  let ended = false;
  /** The commit that this device sent last in this sync, with the files that it holds, or null if it sent none */
  let sentTree: { commit: string; root: string; entries: Record<string, Entry>; trees: string[] } | null = null;
  const saveState = async (): Promise<void> => {
    const next: State = {
      version: 1,
      url: remote.url,
      branch,
      commit: tip,
      tree: Object.fromEntries(agreed),
      stat: {},
      absent: {},
      large: {},
      racy: {},
    };
    // A file that changed this shortly before now can change again without its time moving on
    const racyAfter = Date.now() - RACY_MS;
    for (const path of agreed.keys()) {
      const stat = stats.get(path);
      if (absent.has(path)) {
        next.absent[path] = true;
        const size = large.get(path);
        if (size !== undefined) {
          next.large![path] = size;
        }
      } else if (stat !== undefined && seenAs.get(path) === agreed.get(path)!.oid) {
        next.stat[path] = stat;
        if (stat.mtime > racyAfter) {
          next.racy![path] = true;
        }
      }
    }
    if (first && !ended) {
      next.joining = true;
    }
    // A sync that found nothing to do leaves what was agreed on as it is, and the file with it
    const text = JSON.stringify(next);
    if (savedText !== text) {
      await fs.write(statePath, encode(text));
    }
  };

  try {
    // --- Give what this device changed --------------------------------------
    // Sending comes first. If the sync stops after it, the next one finds the
    // remote ahead and simply takes what is left to take.
    /** The ids of the contents that the remote is known to have */
    const remoteHas = new Set([...there.values()].map((entry) => entry.oid));
    const groups: string[][] = [];
    {
      let group: string[] = [];
      let bytes = 0;
      for (const path of uploads) {
        // What the remote has already is not sent, so it does not count
        const size = remoteHas.has(here.get(path)?.oid ?? "") ? 0 : (stats.get(path)?.size ?? 0);
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
    // Removals and files that only change their name need a commit even if no content is sent
    if (groups.length === 0 && (target.size !== there.size || [...target].some(([path, entry]) => !same(entry, there.get(path))))) {
      groups.push([]);
    }

    const who = signature(options.author.name, options.author.email, now);
    let sentSoFar = 0;
    for (const group of groups) {
      progress({ step: "sending", done: sentSoFar, total: uploads.length });
      sentSoFar += group.length;
      const blobs: GitObject[] = [];
      const sent: { path: string; entry: Entry; stat: FileStat }[] = [];
      for (const path of group) {
        const stat = await fs.stat(path);
        const known = moved.get(path);
        if (known !== undefined && stat !== null && !(await changedSinceScan(path))) {
          // Too large to read. The remote has what it holds, under the name it had before.
          target.set(path, known);
          sent.push({ path, entry: known, stat });
          continue;
        }
        const data = stat === null ? null : ((await linkAt(path)) ?? (await fs.read(path)));
        if (stat === null || data === null || data.length > options.maxFileBytes) {
          result.busy.push(path);
          continue;
        }
        const blob: GitObject = { type: "blob", data };
        const entry = { oid: await objectId(blob), mode: here.get(path)!.mode };
        if (!same(entry, target.get(path))) {
          // What the remote has under another name, as after a file was given a new one, is not sent again
          if (!remoteHas.has(entry.oid)) {
            blobs.push(blob);
            remoteHas.add(entry.oid);
          }
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
        await push(http, remote, { ref, oldOid: refTip ?? ZERO_OID, newOid: commitOid, pack });

        for (const [oid, tree] of trees) {
          await store.write(tree, oid);
          knownTrees.add(oid);
        }
        await store.write(commit, commitOid);
        tip = commitOid;
        refTip = commitOid;
        thereRoot = built.root;
        sentTree = { commit: commitOid, root: built.root, entries: Object.fromEntries(target), trees: [...built.trees.keys()] };
        log(`sent ${blobs.length} file(s) as ${commitOid.slice(0, 7)}`);
      }
      for (const { path, entry, stat } of sent) {
        agreed.set(path, entry);
        stats.set(path, stat);
        seenAs.set(path, entry.oid);
        absent.delete(path);
        result.uploaded.push(path);
      }
      for (const path of result.deletedThere) {
        agreed.delete(path);
        absent.delete(path);
      }
    }

    if (sentTree !== null) {
      // The remote is at a commit that this device made. Its files are known, and are noted as if they
      // had been read from its folders, so that the next sync does not read every folder to know them.
      await fs.write(flatPath, encode(JSON.stringify(sentTree)));
    }

    if (refTip === null && tip !== null) {
      // A new branch with nothing to send: it is made all the same, at the commit it starts from
      await push(http, remote, { ref, oldOid: ZERO_OID, newOid: tip, pack: await writePack([]) });
      refTip = tip;
    }

    // --- Take what the remote changed ---------------------------------------
    const emptied = new Set<string>();
    for (const path of removeHere) {
      if (absent.has(path)) {
        // Never was in the vault. What the vault has under that name, if anything, is another file.
        agreed.delete(path);
        absent.delete(path);
        continue;
      }
      if (await changedSinceScan(path)) {
        result.busy.push(path);
        continue;
      }
      await (fs.discard === undefined ? fs.remove(path) : fs.discard(path));
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
      // Asked for when the first file needs it. A sync that only looks again at files that stay out asks nothing.
      const toTake = [...new Set(downloads.filter(({ entry }) => isFile(entry)).map(({ entry }) => entry.oid))];
      const sizeOf = async (oid: string): Promise<number | undefined> => (await sizesFor(toTake)).get(oid);
      /** The paths that wait for the content with an id */
      const wanted = new Map<string, { path: string; entry: Entry }[]>();
      /** `tooLarge` is the size of a file that stays out of the vault because of it */
      const settle = (path: string, entry: Entry, isAbsent: boolean, tooLarge?: number): void => {
        agreed.set(path, entry);
        if (isAbsent) {
          absent.add(path);
          stats.delete(path);
        } else {
          absent.delete(path);
        }
        if (tooLarge === undefined) {
          large.delete(path);
        } else {
          large.set(path, tooLarge);
        }
      };
      /**
       * Does what puts a file into the vault. False if the vault has something in
       * its place that does not give way, such as a file where a folder is to be.
       * An empty folder with the name of the file does give way.
       */
      const put = async (path: string, entry: Entry, write: () => Promise<boolean>): Promise<boolean> => {
        let written: boolean;
        try {
          written = await write();
        } catch {
          await fs.removeDir(path);
          try {
            written = await write();
          } catch {
            // A write that failed can leave a file that is neither the old one nor the new one,
            // and the next sync must not take that for a change of this device. So it goes, and
            // the file counts as left out of the vault: every sync asks for it again.
            try {
              if ((await fs.stat(path)) !== null) {
                await fs.remove(path);
              }
            } catch {
              // Nothing more to be done about it here
            }
            settle(path, entry, true);
            result.busy.push(path);
            return false;
          }
        }
        if (written) {
          noteWritten(path);
        }
        return written;
      };
      /**
       * True if the vault holds the path under another spelling, which may be a
       * file that this sync put there a moment ago. The file is then tracked
       * without being in the vault, and the remote keeps it.
       */
      const clashes = async (path: string, entry: Entry): Promise<boolean> => {
        if (!(await spelledOtherwise(path))) {
          return false;
        }
        // Told when it is news: not for a file that was left out for its name before
        if (!again.has(path) || large.has(path)) {
          result.sameName.push(path);
        }
        settle(path, entry, true);
        return true;
      };
      /**
       * At a first sync, what the vault holds under the name of a file of the
       * remote makes room for it. It goes where the app keeps what a person
       * deleted, where the app has such a place for it.
       */
      const makeRoom = async (path: string): Promise<void> => {
        if (replaced.has(path) && fs.discard !== undefined && (await fs.stat(path)) !== null) {
          await fs.discard(path);
        }
      };
      /** Notes that a file of the remote is in the vault now. */
      const took = (path: string): void => {
        result.downloaded.push(path);
        if (replaced.has(path)) {
          result.replaced.push(path);
        }
      };
      let taken = 0;
      const tookOne = (): void => progress({ step: "taking", done: ++taken, total: downloads.length });
      progress({ step: "taking", done: 0, total: downloads.length });
      for (const { path, entry, from } of downloads) {
        if (!inVault(entry)) {
          tookOne();
          // A repository inside the repository: tracked, but not made in the vault
          settle(path, entry, true);
          continue;
        }
        if (await clashes(path, entry)) {
          continue;
        }
        if (await changedSinceScan(path)) {
          result.busy.push(path);
          continue;
        }
        const size = await sizeOf(entry.oid);
        if (size !== undefined && size > options.maxFileBytes) {
          const file = { oid: entry.oid, size, commit: thereCommit!, path: from ?? path };
          const { largeBlob } = options;
          const busyBefore = result.busy.length;
          tookOne();
          if (largeBlob !== undefined) {
            await makeRoom(path);
          }
          if (largeBlob !== undefined && (await put(path, entry, () => largeBlob(file, path)))) {
            const stat = await fs.stat(path);
            if (stat !== null) {
              stats.set(path, stat);
              seenAs.set(path, entry.oid);
            }
            settle(path, entry, false);
            took(path);
          } else if (result.busy.length === busyBefore) {
            settle(path, entry, true, size);
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

      // A size that the host does not tell is guessed from the files of the same kind that
      // came before, so that a batch still ends somewhere near where it is meant to.
      // The first file of a kind that is rarely text is taken to fill a batch by itself.
      const seen = new Map<string, { bytes: number; count: number }>();
      const kindOf = (oid: string): string => {
        const { path } = wanted.get(oid)![0];
        const name = path.slice(path.lastIndexOf("/") + 1);
        const dot = name.lastIndexOf(".");
        return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
      };
      const guess = (oid: string): number => {
        const kind = kindOf(oid);
        const before = seen.get(kind);
        if (before !== undefined) {
          return Math.max(1, Math.ceil(before.bytes / before.count));
        }
        return TEXT_KINDS.has(kind) ? Math.min(64 * 1024, options.batchBytes) : options.batchBytes;
      };
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
          const kind = kindOf(oid);
          const before = seen.get(kind) ?? { bytes: 0, count: 0 };
          seen.set(kind, { bytes: before.bytes + object.data.length, count: before.count + 1 });
          for (const { path, entry } of wanted.get(oid)!) {
            const { data } = object;
            tookOne();
            // Another file of this sync may have taken the name under another spelling
            if (await clashes(path, entry)) {
              continue;
            }
            await makeRoom(path);
            const written = await put(path, entry, async () => {
              if (entry.mode === MODE_LINK && fs.writeLink !== undefined) {
                await fs.writeLink(path, decode(data));
              } else {
                // Where links cannot be made, a link is a file that holds where it points, as git has it there
                await fs.write(path, data);
              }
              return true;
            });
            if (!written) {
              continue;
            }
            const stat = await fs.stat(path);
            if (stat !== null) {
              stats.set(path, stat);
              seenAs.set(path, entry.oid);
            }
            settle(path, entry, false);
            took(path);
          }
        }
        batch = [];
        bytes = 0;
      };
      for (const oid of wanted.keys()) {
        const size = (await sizeOf(oid)) ?? guess(oid);
        if (batch.length > 0 && bytes + size > options.batchBytes) {
          await flush();
        }
        batch.push(oid);
        bytes += size;
      }
      await flush();
    }
    ended = true;
  } finally {
    await saveState();
  }
  result.commit = tip;
}
