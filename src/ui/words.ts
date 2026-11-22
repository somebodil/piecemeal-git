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
  return result.merged.length > 0 ? [`Changed on both sides, and put together: ${list(result.merged)}.`] : [];
}

/** What a sync left for a person to look at. */
export function concerns(result: SyncResult): string[] {
  const lines: string[] = [];
  if (result.conflicts.length > 0) {
    lines.push(
      `Changed on both sides: ${list(result.conflicts.map((c) => c.path))}. Your version stays, the other one is kept beside it as a copy.`,
    );
  }
  if (result.tooLargeIgnored.length > 0) {
    lines.push(`Too large to send, and written into .gitignore: ${list(result.tooLargeIgnored)}.`);
  }
  if (result.tooLargeChanged.length > 0) {
    lines.push(`Changed here but now too large to send: ${list(result.tooLargeChanged)}. The repository keeps its version.`);
  }
  if (result.tooLargeThere.length > 0) {
    lines.push(`Too large to get on this device, and left out of the vault: ${list(result.tooLargeThere)}.`);
  }
  if (result.sameName.length > 0) {
    lines.push(
      `Named like another file but for capital letters, which this device cannot tell apart, and left out of the vault: ${list(result.sameName)}.`,
    );
  }
  if (result.busy.length > 0) {
    lines.push(`Changed while the sync ran, left for the next one: ${list(result.busy)}.`);
  }
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
  // A vault with notes meets a repository with files for the first time
  if (plan.first && plan.take > 0 && plan.send > 0) {
    return true;
  }
  // A good part of what was synced is about to go
  const many = (n: number): boolean => n >= 10 && n * 4 >= plan.tracked;
  return many(plan.removeHere.length) || many(plan.removeThere.length);
}
