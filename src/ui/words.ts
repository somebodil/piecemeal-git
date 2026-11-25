import { RemoteError } from "../git/protocol.ts";
import { type Plan, type Progress, type SyncResult } from "../git/sync.ts";

/** The first few of some paths, and how many more there are. */
export function list(paths: string[], most = 5): string {
  const shown = paths.slice(0, most).join(", ");
  return paths.length > most ? `${shown} and ${paths.length - most} more` : shown;
}

/** "1 file", "3 files". */
export function files(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

/** How long ago a moment was, as a person would say it. */
export function ago(then: number, now = Date.now()): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function progressText(progress: Progress): string {
  if (progress.step === "sending" && progress.total > 0) {
    return `Syncing… sending ${files(progress.total)}, ${progress.done} done`;
  }
  if (progress.step === "taking" && progress.total > 0) {
    return `Syncing… taking ${files(progress.total)}, ${progress.done} done`;
  }
  return "Syncing… looking at the vault and the repository";
}

/** What a sync did, in one line. */
export function headline(result: SyncResult): string {
  const taken = result.downloaded.length + result.deletedHere.length;
  const sent = result.uploaded.length + result.deletedThere.length;
  return taken + sent + result.merged.length === 0 ? "Nothing to sync." : `Synced: ${taken} taken, ${sent} sent.`;
}

/** What a sync did that is good to know, and nothing has to be done about. */
export function notes(result: SyncResult): string[] {
  const lines: string[] = [];
  if (result.merged.length > 0) {
    lines.push(`Changed on both sides, and put together: ${list(result.merged)}.`);
  }
  if (result.replaced.length > 0) {
    lines.push(`Not as the repository has ${result.replaced.length === 1 ? "it" : "them"}, and replaced by its version: ${list(result.replaced)}.`);
  }
  return lines;
}

/**
 * What to say after a sync that took settings of Obsidian or of a plugin, or
 * the code of a plugin: Obsidian read them when it started, and goes on with
 * what it read.
 * @param configDir the folder in which Obsidian keeps its settings
 */
export function restart(result: SyncResult, configDir: string): string[] {
  const settings = [...result.downloaded, ...result.merged, ...result.deletedHere].some((path) => path.startsWith(`${configDir}/`));
  return settings ? ["Settings of Obsidian came with it. Close Obsidian and open it again, so that it reads them."] : [];
}

/** The name of a file, without the folders that it is in. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** What a sync left for a person to look at. */
export function concerns(result: SyncResult): string[] {
  const lines: string[] = [];
  const laterHere = result.later.filter((item) => item.kept === "here").map((item) => item.path);
  if (laterHere.length > 0) {
    lines.push(
      `Changed on both sides, and yours is the later one: ${list(laterHere)}. Yours keeps the name and was sent. No copy was made: the version of the repository is in its history.`,
    );
  }
  // A version of the repository that did not get into the vault has not taken the name
  const came = new Set(result.downloaded);
  const laterThere = result.later.flatMap((item) => (item.kept === "there" && came.has(item.path) ? [item] : []));
  if (laterThere.length > 0) {
    lines.push(
      `Changed on both sides, and the repository's is the later one: ${list(laterThere.map((item) => `${item.path} (yours is now ${nameOf(item.copy)})`))}. The version of the repository has the name now, and yours is kept beside it as a copy.`,
    );
  }
  const told = new Set(laterThere.map((item) => item.path));
  const both = result.conflicts.filter((item) => came.has(item.path) && !told.has(item.path));
  if (both.length > 0) {
    lines.push(
      `Changed on both sides: ${list(both.map((item) => item.path))}. The version of the repository has the name now, and yours is kept beside it as a copy.`,
    );
  }
  const waiting = result.conflicts.filter((item) => !came.has(item.path));
  if (waiting.length > 0) {
    lines.push(
      `Changed on both sides: ${list(waiting.map((item) => item.path))}. Yours is kept as a copy beside it. The version of the repository did not get the name: it could not be put into the vault this time.`,
    );
  }
  if (result.earlier.length > 0) {
    lines.push(
      `Changed on both sides, and yours held what the repository held before: ${list(result.earlier)}. The version of the repository has the name now. No copy was made: what yours held is in the history of the repository.`,
    );
  }
  if (result.clashes.length > 0) {
    lines.push(
      `A file on one side and a folder on the other: ${list(result.clashes.map((c) => c.path))}. What is here keeps the name, and what the repository has is beside it.`,
    );
  }
  if (result.tooLargeIgnored.length > 0) {
    lines.push(`Too large to send, and written into .gitignore: ${list(result.tooLargeIgnored)}.`);
  }
  if (result.tooLargeChanged.length > 0) {
    lines.push(`Changed here but now too large to send: ${list(result.tooLargeChanged)}. The repository keeps its version.`);
  }
  if (result.tooLargeThere.length > 0) {
    lines.push(`Too large to get on this device: ${list(result.tooLargeThere)}. The repository keeps its version, and this vault is left without it.`);
  }
  if (result.sameName.length > 0) {
    lines.push(
      `Named like another file but for capital letters, which this device cannot tell apart, and left out of the vault: ${list(result.sameName)}.`,
    );
  }
  // A file that changed while the sync ran is not told here: the next sync takes care of it by itself
  return lines;
}

/** Why a sync failed, and what to do about it where that is known. */
export function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RemoteError) {
    if (error.status === 401 || error.status === 403) {
      return message.includes("wants a token")
        ? "The server wants a token. Give one in the settings."
        : "The server refuses the token. It may have run out, or it may not be allowed to read and write this repository. Give a new one in the settings.";
    }
    if (error.status === 404) {
      return "There is no repository at this address, or the token may not see it. Look at the address and the token in the settings.";
    }
    return message;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "This device is not connected to a network.";
  }
  // What the apps say when no answer came: each of them in words of its own
  if (
    /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_INTERNET|ERR_NETWORK|ERR_ADDRESS|ERR_TIMED_OUT|Failed to fetch|Load failed|timed out|Request Failed|ConnectException|UnknownHostException|SocketTimeoutException|Unable to resolve host|NSURLErrorDomain|could not connect/i.test(
      message,
    )
  ) {
    return `The server could not be reached. Is this device connected, and is the address right? (${message})`;
  }
  return message;
}

/** An address as a person may paste it, turned into the one that git clones over HTTPS. */
export function httpsAddress(given: string): string {
  const text = given.trim();
  // git@github.com:you/vault.git and ssh://git@github.com/you/vault.git
  const short = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(text);
  return short === null ? text : `https://${short[1]}/${short[2]}`;
}

/** True for a sync that a person should see before it does anything. */
export function worthAsking(plan: Plan): boolean {
  // A vault with notes meets a repository with files for the first time, or holds files that give way to it
  if (plan.first && ((plan.take > 0 && plan.send > 0) || plan.replace.length > 0)) {
    return true;
  }
  // A good part of what was synced is about to go
  const many = (n: number): boolean => n >= 10 && n * 4 >= plan.tracked;
  return many(plan.removeHere.length) || many(plan.removeThere.length);
}
