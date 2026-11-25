// What the plugin keeps between two times that Obsidian runs, and how it is
// read. All of it is kept on the device, in the storage that Obsidian gives a
// vault there, and none of it in a file of the vault: the settings are those
// of one device, and a file would go to the others with whatever syncs the
// vault. A file is also what the app on Android now and then says it wrote
// and left empty, and a sync wrote that file every time.

export interface Settings {
  /** The address of the repository, as `git clone` takes it over HTTPS */
  url: string;
  /** The branch to sync with. Empty for the one the repository opens with. */
  branch: string;
  /** The name under which the token is kept in the secret storage of Obsidian */
  tokenSecret: string;
  /** Who the commits of this device are by */
  authorName: string;
  authorEmail: string;
  /** What the commits of this device call it */
  device: string;
  /** A file larger than this many megabytes is not sent from this device */
  maxFileMB: number;
  /** What both sides changed in different places of a text is put together, as git does */
  mergeText: boolean;
  /**
   * What becomes of a file that both sides changed and that was not put
   * together. "both": the one of the repository takes the name, and the one
   * of this device is kept beside it as a copy. "later": the same, but the
   * one of this device keeps the name, with no copy, where it was changed
   * later than the one of the repository.
   */
  onConflict: "later" | "both";
  /** A sync starts by itself every so many minutes. 0 for never. */
  everyMinutes: number;
  /** A sync starts by itself when Obsidian has opened the vault */
  onStart: boolean;
}

export const DEFAULTS: Settings = {
  url: "",
  branch: "",
  tokenSecret: "",
  authorName: "",
  authorEmail: "",
  device: "",
  maxFileMB: 20,
  mergeText: true,
  onConflict: "later",
  everyMinutes: 0,
  onStart: false,
};

/** How the last sync went. Kept so that it is known after Obsidian starts again. */
export interface Last {
  /** When it ended, in milliseconds since 1970 */
  at: number;
  ok: boolean;
  /** What it did, or why it failed, in a line */
  text: string;
  /** True if it left something for a person to look at */
  attention: boolean;
}

/** What is not a setting, and is kept as well: how the last sync went, and that the panel has its place. */
export interface DeviceState {
  last: Last | null;
  /** True once the panel was put into a sidebar. It is put there once: who closes it does not get it back. */
  panelPlaced: boolean;
}

/** The names under which Obsidian keeps the two for a vault on a device */
export const SETTINGS_KEY = "piecemeal-git-settings";
export const STATE_KEY = "piecemeal-git-state";

/** The settings that are one of a few words, with the words that each of them can be */
export const CHOICES: Partial<Record<keyof Settings, readonly string[]>> = { onConflict: ["later", "both"] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The settings that are in what was kept. What is not there, or is not of the kind that the setting is, is as the plugin comes. */
function readSettings(kept: Record<string, unknown>): Settings {
  const settings: Record<string, unknown> = { ...DEFAULTS };
  for (const [key, standard] of Object.entries(DEFAULTS)) {
    const value = kept[key];
    const choices = CHOICES[key as keyof Settings];
    if (typeof value === typeof standard && (typeof value !== "number" || Number.isFinite(value)) && (choices === undefined || choices.includes(value as string))) {
      settings[key] = value;
    }
  }
  return settings as unknown as Settings;
}

function readLast(kept: unknown): Last | null {
  if (!isRecord(kept) || typeof kept["at"] !== "number" || typeof kept["ok"] !== "boolean" || typeof kept["text"] !== "string") {
    return null;
  }
  return { at: kept["at"], ok: kept["ok"], text: kept["text"], attention: kept["attention"] === true };
}

/**
 * Works out what the plugin starts with.
 *
 * Before, all of it was in the file `data.json` of the plugin. A device that
 * still has that file and nothing kept in the storage of the app takes it
 * from the file, once.
 *
 * @param settings what the storage of the app has under `SETTINGS_KEY`
 * @param state what it has under `STATE_KEY`
 * @param file what the file of before holds, read only if `settings` is not there.
 *   Null if there is none, and not an object if it cannot be read.
 * @returns `fromFile` is true if the settings are those of the file, and have to be kept in the storage of the app now
 */
export function readStored(settings: unknown, state: unknown, file?: unknown): { config: Settings; state: DeviceState; fromFile: boolean } {
  const fromFile = !isRecord(settings) && isRecord(file);
  const source = isRecord(settings) ? settings : isRecord(file) ? file : {};
  // The file of before held how the last sync went too
  const rest = isRecord(state) ? state : fromFile ? source : {};
  return {
    config: readSettings(source),
    state: { last: readLast(rest["last"]), panelPlaced: rest["panelPlaced"] === true },
    fromFile,
  };
}
