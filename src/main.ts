import { Notice, Platform, Plugin, setIcon, TFile } from "obsidian";
import { VerifiedFs } from "./git/fs.ts";
import { githubLargeBlob, githubSizes, parseGitHub } from "./git/github.ts";
import { remoteOf } from "./git/protocol.ts";
import { CancelledError, type Progress, sync, type SyncResult } from "./git/sync.ts";
import { ObsidianFs, obsidianHttp } from "./platform/obsidian.ts";
import { ConfirmModal } from "./ui/confirm.ts";
import { conflictCopies, ReportModal } from "./ui/report.ts";
import { DEFAULTS, type Settings, SettingsTab } from "./ui/settings.ts";
import { ago, concerns, explain, headline, notes, progressText, worthAsking } from "./ui/words.ts";

const MB = 1024 * 1024;
/** Where the plugin keeps the commits, the folders and what it last agreed on */
const STORE_DIR = ".piecemeal";
/** About how much content one request asks for or sends */
const BATCH_BYTES = 4 * MB;

/** How the last sync went. Kept with the settings, so that it is known after Obsidian starts again. */
export interface Last {
  /** When it ended, in milliseconds since 1970 */
  at: number;
  ok: boolean;
  /** What it did, or why it failed, in a line */
  text: string;
  /** True if it left something for a person to look at */
  attention: boolean;
}

export default class PiecemealGitPlugin extends Plugin {
  config: Settings = { ...DEFAULTS };
  /** How the last sync went, or null if there has been none */
  last: Last | null = null;
  /** What the last sync did, file by file. Known until Obsidian closes. */
  lastResult: SyncResult | null = null;
  running = false;
  /** How far the sync is that runs */
  private progress: Progress | null = null;
  /** The timer of the syncs that start by themselves */
  private timer: number | null = null;
  /** True after a sync that nobody asked for failed, so that it is said once and not every few minutes */
  private failedUnasked = false;
  /** How many files had to be written a second time since the plugin was loaded, because the first write left them cut off */
  rewritten = 0;
  private ribbonEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private report: ReportModal | null = null;

  override async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<Settings> & { last?: Last | null };
    const { last, ...config } = data;
    this.config = { ...DEFAULTS, ...config };
    this.last = last ?? null;
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
    this.addCommand({
      id: "report",
      name: "Show what the last sync did",
      callback: () => {
        this.openReport();
      },
    });
    this.ribbonEl = this.addRibbonIcon("refresh-cw", "Sync with the repository", () => {
      void this.sync();
    });
    // The desktop app has a bar at the bottom. The mobile app shows none.
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("piecemeal-git-status", "mod-clickable");
    this.statusEl.addEventListener("click", () => {
      this.openReport();
    });
    this.registerInterval(window.setInterval(() => this.refresh(), 30_000));
    this.refresh();
  }

  override onunload(): void {
    this.report?.close();
  }

  async saveSettings(): Promise<void> {
    await this.saveData({ ...this.config, last: this.last });
    this.refresh();
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

  openReport(): void {
    // One at a time: asked for twice, it is the same list, not one on top of the other
    this.report?.close();
    this.report = new ReportModal(this.app, this);
    this.report.open();
  }

  /** Opens the settings of Obsidian at the tab of this plugin. */
  openSettings(): void {
    // Not a part of what Obsidian promises to plugins, so it is asked for with care
    const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
    setting?.open?.();
    setting?.openTabById?.(this.manifest.id);
  }

  /** Brings the icon of the ribbon and the status bar up to what is known. */
  private refresh(): void {
    const { last } = this;
    let icon = "refresh-cw";
    let words = "Not synced yet";
    if (this.running) {
      words = this.progress === null ? "Syncing…" : progressText(this.progress);
    } else if (this.config.url === "") {
      words = "No repository yet";
    } else if (last !== null) {
      if (!last.ok) {
        icon = "alert-triangle";
        words = `Sync failed ${ago(last.at)}`;
      } else if (last.attention || conflictCopies(this.app).length > 0) {
        icon = "alert-circle";
        words = `Synced ${ago(last.at)}, with something to look at`;
      } else {
        icon = "check";
        words = `Synced ${ago(last.at)}`;
      }
    }
    if (this.ribbonEl !== null) {
      this.ribbonEl.toggleClass("piecemeal-git-syncing", this.running);
      this.ribbonEl.toggleClass("piecemeal-git-failed", !this.running && icon === "alert-triangle");
      this.ribbonEl.toggleClass("piecemeal-git-attention", !this.running && icon === "alert-circle");
      // The mobile app shows this as the name of the action in a list, so there it stays as it is
      if (!Platform.isMobile) {
        this.ribbonEl.setAttribute("aria-label", this.running ? words : `Sync with the repository\n${words}`);
      }
    }
    if (this.statusEl !== null) {
      this.statusEl.empty();
      setIcon(this.statusEl.createSpan(), this.running ? "refresh-cw" : icon);
      this.statusEl.toggleClass("piecemeal-git-syncing", this.running);
      this.statusEl.createSpan({ text: words.replace(/^Syncing… /, "") });
      this.statusEl.setAttribute("aria-label", "Show what the last sync did");
    }
  }

  /** Tells what a sync did. One that left something to look at stays until it is closed, and opens the list. */
  private tell(result: SyncResult, unasked: boolean): void {
    const calm = [headline(result), ...notes(result)];
    const toLookAt = concerns(result);
    const taken = result.downloaded.length + result.deletedHere.length + result.merged.length;
    if (toLookAt.length === 0) {
      if (!unasked || taken > 0) {
        new Notice(calm.join("\n"), 5000);
      }
      return;
    }
    const notice = new Notice("", 0);
    notice.setMessage(
      createFragment((fragment) => {
        for (const line of [...calm, ...toLookAt]) {
          fragment.createDiv({ text: line });
        }
        const button = fragment.createEl("button", { text: "Show the files", cls: "piecemeal-git-notice-button" });
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          notice.hide();
          this.openReport();
        });
      }),
    );
  }

  /**
   * @param unasked true for a sync that started by itself. It says nothing
   *   while it runs, and afterwards only what is worth an interruption: that
   *   something was taken, that something asks for attention, or that it failed.
   * @returns what the sync did, or null if it did not run or failed
   */
  async sync(unasked = false): Promise<SyncResult | null> {
    if (this.running) {
      if (!unasked) {
        new Notice("A sync is running already.");
      }
      return null;
    }
    const { url, branch, tokenSecret, authorName, authorEmail, device, maxFileMB, mergeText } = this.config;
    if (url === "") {
      if (!unasked) {
        new Notice("Give the address of the repository first.");
        this.openSettings();
      }
      return null;
    }
    this.running = true;
    this.progress = null;
    this.refresh();
    let waiting = unasked ? null : new Notice("Syncing…", 0);
    /** True if a sync that nobody asked for stopped because a person should see first what it is about to do */
    let held = false;
    try {
      const token = (tokenSecret === "" ? null : this.app.secretStorage.getSecret(tokenSecret)) ?? undefined;
      const fs = new VerifiedFs(
        new ObsidianFs(this.app.vault.adapter, async (path) => {
          // A file that the remote removed goes where Obsidian puts the files that a person deletes
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) {
            return false;
          }
          await this.app.fileManager.trashFile(file);
          return true;
        }),
      );
      const remote = remoteOf(url, token);
      const github = parseGitHub(remote.url);
      const { configDir } = this.app.vault;
      // What stays on the device: the settings of this plugin, the trash of Obsidian, and the files in
      // which Obsidian keeps what is open on this device, which change whenever a note is opened
      const own = new Set([`${configDir}/plugins/${this.manifest.id}/data.json`, `${configDir}/workspace.json`, `${configDir}/workspace-mobile.json`]);
      const from = device !== "" ? device : Platform.isMobile ? "a phone" : "a computer";
      const result = await sync({
        fs,
        http: obsidianHttp,
        remote,
        branch: branch === "" ? undefined : branch,
        storeDir: STORE_DIR,
        exclude: (path) => own.has(path) || path === ".trash" || path.startsWith(".trash/"),
        author: {
          name: authorName !== "" ? authorName : "Piecemeal Git",
          email: authorEmail !== "" ? authorEmail : "piecemeal-git@users.noreply.github.com",
        },
        message: () => `Sync from ${from}`,
        // An iPhone, an iPad and a Mac keep the letters of a name like "한글.md" in parts
        composeNames: Platform.isIosApp || Platform.isMacOS,
        mergeText,
        maxFileBytes: maxFileMB * MB,
        batchBytes: BATCH_BYTES,
        sizes: github === null ? undefined : githubSizes(obsidianHttp, github, token),
        largeBlob: github === null ? undefined : githubLargeBlob(obsidianHttp, fs, github, token, BATCH_BYTES),
        onProgress: (progress) => {
          this.progress = progress;
          waiting?.setMessage(progressText(progress));
          this.refresh();
        },
        confirm: async (plan) => {
          if (!worthAsking(plan)) {
            return true;
          }
          if (unasked) {
            held = true;
            return false;
          }
          waiting?.hide();
          const go = await new ConfirmModal(this.app, plan).ask();
          if (go) {
            waiting = new Notice("Syncing…", 0);
          }
          return go;
        },
      });
      this.rewritten += fs.rewritten;
      this.lastResult = result;
      const toLookAt = concerns(result);
      this.last = { at: Date.now(), ok: true, text: [headline(result), ...notes(result), ...toLookAt].join(" "), attention: toLookAt.length > 0 };
      this.failedUnasked = false;
      waiting?.hide();
      this.tell(result, unasked);
      return result;
    } catch (error) {
      waiting?.hide();
      if (error instanceof CancelledError) {
        if (held && !this.failedUnasked) {
          new Notice(
            "A sync was held back: it is about to remove many files, or it is the first one with this repository. Start the sync yourself to see what it is about to do.",
            0,
          );
        }
        this.failedUnasked = held;
        return null;
      }
      console.error("Piecemeal Git: the sync failed", error);
      const why = explain(error);
      this.last = { at: Date.now(), ok: false, text: why, attention: true };
      if (!unasked || !this.failedUnasked) {
        new Notice(`The sync failed. ${why}`, 0);
      }
      this.failedUnasked = unasked;
      return null;
    } finally {
      this.running = false;
      this.progress = null;
      await this.saveSettings();
    }
  }
}
