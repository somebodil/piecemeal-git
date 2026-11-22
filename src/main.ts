import { type App, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting, type SettingDefinitionItem } from "obsidian";
import { githubLargeBlob, githubSizes, parseGitHub } from "./git/github.ts";
import { sync, type SyncResult } from "./git/sync.ts";
import { ObsidianFs, obsidianHttp } from "./platform/obsidian.ts";

interface Settings {
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
  /** A sync starts by itself every so many minutes. 0 for never. */
  everyMinutes: number;
  /** A sync starts by itself when Obsidian has opened the vault */
  onStart: boolean;
}

const DEFAULTS: Settings = {
  url: "",
  branch: "",
  tokenSecret: "",
  authorName: "",
  authorEmail: "",
  device: "",
  maxFileMB: 20,
  everyMinutes: 0,
  onStart: false,
};

const MB = 1024 * 1024;
/** Where the plugin keeps the commits, the folders and what it last agreed on */
const STORE_DIR = ".piecemeal";
/** About how much content one request asks for or sends */
const BATCH_BYTES = 4 * MB;

function list(paths: string[]): string {
  const shown = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${shown} and ${paths.length - 5} more` : shown;
}

/** What a sync did, for a person to read. The second value says if it asks for attention. */
function summary(result: SyncResult): [string, boolean] {
  const lines = [
    result.downloaded.length + result.uploaded.length + result.deletedHere.length + result.deletedThere.length === 0
      ? "Nothing to sync."
      : `Synced: ${result.downloaded.length + result.deletedHere.length} taken, ${result.uploaded.length + result.deletedThere.length} sent.`,
  ];
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
  return [lines.join("\n"), lines.length > 1];
}

export default class PiecemealGitPlugin extends Plugin {
  config: Settings = { ...DEFAULTS };
  private running = false;
  /** The timer of the syncs that start by themselves */
  private timer: number | null = null;
  /** True after a sync that nobody asked for failed, so that it is said once and not every few minutes */
  private failedUnasked = false;

  override async onload(): Promise<void> {
    this.config = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
    this.addSettingTab(new SettingsTab(this.app, this));
    this.schedule();
    this.app.workspace.onLayoutReady(() => {
      if (this.config.onStart) {
        void this.sync(true);
      }
    });
    this.addCommand({
      id: "sync",
      name: "Sync with the repository",
      callback: () => {
        void this.sync();
      },
    });
    this.addRibbonIcon("refresh-cw", "Sync with the repository", () => {
      void this.sync();
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.config);
  }

  /** Starts the timer over. Called when the plugin loads and when the minutes change. */
  schedule(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    const minutes = this.config.everyMinutes;
    if (minutes > 0) {
      this.timer = window.setInterval(() => void this.sync(true), minutes * 60_000);
      this.registerInterval(this.timer);
    }
  }

  /**
   * @param unasked true for a sync that started by itself. It says nothing
   *   while it runs, and afterwards only what is worth an interruption: that
   *   something was taken, that something asks for attention, or that it failed.
   */
  async sync(unasked = false): Promise<void> {
    if (this.running) {
      if (!unasked) {
        new Notice("A sync is running already.");
      }
      return;
    }
    const { url, branch, tokenSecret, authorName, authorEmail, device, maxFileMB } = this.config;
    if (url === "") {
      if (!unasked) {
        new Notice("Give the address of the repository in the settings first.");
      }
      return;
    }
    this.running = true;
    const progress = unasked ? null : new Notice("Syncing…", 0);
    try {
      const token = (tokenSecret === "" ? null : this.app.secretStorage.getSecret(tokenSecret)) ?? undefined;
      const fs = new ObsidianFs(this.app.vault.adapter);
      const github = parseGitHub(url);
      const ownData = `${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`;
      const from = device !== "" ? device : Platform.isMobile ? "a phone" : "a computer";
      const result = await sync({
        fs,
        http: obsidianHttp,
        remote: { url, token },
        branch: branch === "" ? undefined : branch,
        storeDir: STORE_DIR,
        // The settings of this plugin stay on the device, and so does the trash of Obsidian
        exclude: (path) => path === ownData || path === ".trash" || path.startsWith(".trash/"),
        author: {
          name: authorName !== "" ? authorName : "Piecemeal Git",
          email: authorEmail !== "" ? authorEmail : "piecemeal-git@users.noreply.github.com",
        },
        message: () => `Sync from ${from}`,
        maxFileBytes: maxFileMB * MB,
        batchBytes: BATCH_BYTES,
        sizes: github === null ? undefined : githubSizes(obsidianHttp, github, token),
        largeBlob: github === null ? undefined : githubLargeBlob(obsidianHttp, fs, github, token, BATCH_BYTES),
      });
      const [text, attention] = summary(result);
      const taken = result.downloaded.length + result.deletedHere.length;
      if (!unasked || attention || taken > 0) {
        new Notice(text, attention ? 0 : 5000);
      }
      this.failedUnasked = false;
    } catch (error) {
      if (!unasked || !this.failedUnasked) {
        new Notice(`The sync failed. ${error instanceof Error ? error.message : String(error)}`, 0);
      }
      this.failedUnasked = unasked;
    } finally {
      progress?.hide();
      this.running = false;
    }
  }
}

/** A row of the settings: what it is called, and which of the settings it holds. */
type Row = { name: string; desc?: string } & (
  | { type: "text"; key: "url" | "branch" | "authorName" | "authorEmail" | "device"; placeholder: string }
  | { type: "secret"; key: "tokenSecret" }
  | { type: "number"; key: "maxFileMB" | "everyMinutes"; min: number }
  | { type: "toggle"; key: "onStart" }
);

const ROWS: Row[] = [
  { type: "text", key: "url", name: "Repository", desc: "The address that git clones over HTTPS.", placeholder: "https://github.com/you/vault.git" },
  {
    type: "secret",
    key: "tokenSecret",
    name: "Token",
    desc: "A token that may read and write the contents of this one repository. It is kept in the secret storage of Obsidian, not in the vault.",
  },
  { type: "text", key: "branch", name: "Branch", desc: "Leave empty for the branch that the repository opens with.", placeholder: "main" },
  {
    type: "number",
    key: "maxFileMB",
    name: "Largest file to send",
    desc: "In megabytes. A new file above this is not sent. It is written into .gitignore, and you are told.",
    min: 1,
  },
  {
    type: "number",
    key: "everyMinutes",
    name: "Sync every",
    desc: "In minutes. 0 to sync only when you run the command. A sync that starts by itself tells you only when it took something, when something asks for your attention, or when it failed.",
    min: 0,
  },
  { type: "toggle", key: "onStart", name: "Sync when Obsidian starts" },
  { type: "text", key: "authorName", name: "Name on commits", desc: "Who the commits of this device are by.", placeholder: "Your name" },
  { type: "text", key: "authorEmail", name: "Email on commits", placeholder: "you@example.com" },
  { type: "text", key: "device", name: "Name of this device", desc: "The message of a commit says where it is from.", placeholder: "My phone" },
];

class SettingsTab extends PluginSettingTab {
  private readonly plugin: PiecemealGitPlugin;

  constructor(app: App, plugin: PiecemealGitPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * What Obsidian 1.13 and later makes the rows from. Rows that are told this
   * way are found by the search of the settings.
   */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    return ROWS.map((row) => {
      const { name, desc, key } = row;
      switch (row.type) {
        case "text":
          return { name, desc, control: { type: "text", key, placeholder: row.placeholder } };
        case "secret":
          return { name, desc, control: { type: "secret", key } };
        case "number":
          return { name, desc, control: { type: "number", key, min: row.min } };
        case "toggle":
          return { name, desc, control: { type: "toggle", key } };
      }
    });
  }

  override getControlValue(key: string): unknown {
    return this.plugin.config[key as keyof Settings];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const row = ROWS.find((other) => other.key === key);
    if (row === undefined) {
      return;
    }
    const settings = this.plugin.config;
    if (row.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < row.min) {
        return;
      }
      settings[row.key] = value;
    } else if (row.type === "toggle") {
      settings[row.key] = value === true;
    } else {
      settings[row.key] = typeof value === "string" ? value.trim() : "";
    }
    await this.plugin.saveSettings();
    if (row.key === "everyMinutes") {
      this.plugin.schedule();
    }
  }

  /** The same rows for Obsidian before 1.13, which has to be given each of them. */
  override display(): void {
    const { containerEl } = this;
    const settings = this.plugin.config;
    containerEl.empty();
    for (const row of ROWS) {
      const setting = new Setting(containerEl).setName(row.name).setDesc(row.desc ?? "");
      const change = (value: unknown): Promise<void> => this.setControlValue(row.key, value);
      switch (row.type) {
        case "text":
          setting.addText((input) => input.setPlaceholder(row.placeholder).setValue(settings[row.key]).onChange(change));
          break;
        case "secret":
          setting.addComponent((el) => new SecretComponent(this.app, el).setValue(settings[row.key]).onChange(change));
          break;
        case "number":
          setting.addText((input) => input.setValue(String(settings[row.key])).onChange((value) => change(Number(value))));
          break;
        case "toggle":
          setting.addToggle((toggle) => toggle.setValue(settings[row.key]).onChange(change));
          break;
      }
    }
  }
}
