import { type App, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting } from "obsidian";
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
}

const DEFAULTS: Settings = {
  url: "",
  branch: "",
  tokenSecret: "",
  authorName: "",
  authorEmail: "",
  device: "",
  maxFileMB: 20,
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
  if (result.busy.length > 0) {
    lines.push(`Changed while the sync ran, left for the next one: ${list(result.busy)}.`);
  }
  return [lines.join("\n"), lines.length > 1];
}

export default class PiecemealGitPlugin extends Plugin {
  config: Settings = { ...DEFAULTS };
  private running = false;

  override async onload(): Promise<void> {
    this.config = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
    this.addSettingTab(new SettingsTab(this.app, this));
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

  async sync(): Promise<void> {
    if (this.running) {
      new Notice("A sync is running already.");
      return;
    }
    const { url, branch, tokenSecret, authorName, authorEmail, device, maxFileMB } = this.config;
    if (url === "") {
      new Notice("Give the address of the repository in the settings first.");
      return;
    }
    this.running = true;
    const progress = new Notice("Syncing…", 0);
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
      new Notice(text, attention ? 0 : 5000);
    } catch (error) {
      new Notice(`The sync failed. ${error instanceof Error ? error.message : String(error)}`, 0);
    } finally {
      progress.hide();
      this.running = false;
    }
  }
}

class SettingsTab extends PluginSettingTab {
  private readonly plugin: PiecemealGitPlugin;

  constructor(app: App, plugin: PiecemealGitPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override display(): void {
    const { containerEl } = this;
    const settings = this.plugin.config;
    containerEl.empty();

    const text = (name: string, desc: string, key: "url" | "branch" | "authorName" | "authorEmail" | "device", placeholder: string): void => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((input) =>
          input
            .setPlaceholder(placeholder)
            .setValue(settings[key])
            .onChange(async (value) => {
              settings[key] = value.trim();
              await this.plugin.saveSettings();
            }),
        );
    };

    text("Repository", "The address that git clones over HTTPS.", "url", "https://github.com/you/vault.git");
    new Setting(containerEl)
      .setName("Token")
      .setDesc("A token that may read and write the contents of this one repository. It is kept in the secret storage of Obsidian, not in the vault.")
      .addComponent((el) =>
        new SecretComponent(this.app, el).setValue(settings.tokenSecret).onChange(async (value) => {
          settings.tokenSecret = value ?? "";
          await this.plugin.saveSettings();
        }),
      );
    text("Branch", "Leave empty for the branch that the repository opens with.", "branch", "main");
    new Setting(containerEl)
      .setName("Largest file to send")
      .setDesc("In megabytes. A new file above this is not sent. It is written into .gitignore, and you are told.")
      .addText((input) =>
        input.setValue(String(settings.maxFileMB)).onChange(async (value) => {
          const number = Number(value);
          if (Number.isFinite(number) && number >= 1) {
            settings.maxFileMB = number;
            await this.plugin.saveSettings();
          }
        }),
      );
    text("Name on commits", "Who the commits of this device are by.", "authorName", "Your name");
    text("Email on commits", "", "authorEmail", "you@example.com");
    text("Name of this device", "The message of a commit says where it is from.", "device", "My phone");
  }
}
