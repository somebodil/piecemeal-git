import { debounce, Notice, Platform, Plugin, setIcon, type TAbstractFile, TFile, type WorkspaceLeaf } from "obsidian";
import { VerifiedFs } from "./git/fs.ts";
import { githubChangedAt, githubLargeBlob, githubSizes, parseGitHub } from "./git/github.ts";
import { parsePack } from "./git/pack.ts";
import { fetchPack, remoteOf } from "./git/protocol.ts";
import { CancelledError, type Entry, type LocalChange, localChanges, type Progress, revert, sync, type SyncOptions, type SyncResult } from "./git/sync.ts";
import { ObsidianFs, obsidianHttp } from "./platform/obsidian.ts";
import { AskModal } from "./ui/ask.ts";
import { ConfirmModal } from "./ui/confirm.ts";
import { DiffModal } from "./ui/diff.ts";
import { conflictCopies, isCopy, type Report, ReportModal, SyncView, VIEW_TYPE } from "./ui/report.ts";
import { SettingsTab } from "./ui/settings.ts";
import { DEFAULTS, type DeviceState, type Last, readStored, type Settings, SETTINGS_KEY, STATE_KEY } from "./ui/stored.ts";
import { ago, concerns, explain, headline, list, notes, progressText, restart, worthAsking } from "./ui/words.ts";

const MB = 1024 * 1024;
/** Where the plugin keeps the commits, the folders and what it last agreed on */
const STORE_DIR = ".piecemeal";
/** About how much content one request asks for or sends */
const BATCH_BYTES = 4 * MB;

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
  /**
   * The paths of the copies that syncs put beside files that both sides
   * changed. Looked for once among all files of the vault, and kept up from
   * then on by what Obsidian tells about files that come and go.
   */
  readonly copies = new Set<string>();
  /** True once the panel was put into a sidebar */
  private panelPlaced = false;
  /** What changed in the vault since the last sync, as of the last look. Null if it was not looked at, or never synced. */
  changes: LocalChange[] | null = null;
  private looking = false;
  /** The notice that says that files could not be reverted, while it is on the screen */
  private revertFailed: Notice | null = null;
  /** What files held at the last sync, by the ids of what they held: the last few that were asked for */
  private readonly befores = new Map<string, Uint8Array>();

  override async onload(): Promise<void> {
    await this.readStored();
    this.addSettingTab(new SettingsTab(this.app, this));
    this.schedule();
    this.registerView(VIEW_TYPE, (leaf) => new SyncView(leaf, this));
    this.app.workspace.onLayoutReady(() => {
      for (const path of conflictCopies(this.app)) {
        this.copies.add(path);
      }
      // Only from here on: while Obsidian opens a vault it tells of every file as one that was made
      /** Shows that a copy came or went. While a sync runs, all is drawn anew when it ends. */
      const changed = (): void => {
        this.refresh();
        if (!this.running) {
          this.redraw();
        }
      };
      const gone = (file: TAbstractFile): void => {
        if (this.copies.delete(file.path)) {
          changed();
        }
      };
      const came = (file: TAbstractFile): void => {
        if (file instanceof TFile && isCopy(file.path)) {
          this.copies.add(file.path);
          changed();
        }
      };
      this.registerEvent(this.app.vault.on("create", came));
      this.registerEvent(this.app.vault.on("delete", gone));
      // What changed since the last sync is shown where a report is on the screen, and follows the vault
      for (const what of ["create", "modify", "delete", "rename"] as const) {
        this.registerEvent(this.app.vault.on(what as "modify", () => this.changedSince()));
      }
      this.registerEvent(
        this.app.vault.on("rename", (file, before) => {
          if (this.copies.delete(before)) {
            changed();
          }
          came(file);
        }),
      );
      this.refresh();
      void this.placePanel();
      // A tab that Obsidian kept for the panel may show after this. Then there is one too many.
      this.registerEvent(
        this.app.workspace.on("layout-change", () => {
          this.onePanel();
        }),
      );
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
    this.addCommand({
      id: "panel",
      name: "Open the panel in the sidebar",
      callback: () => {
        void this.openPanel();
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

  /**
   * Reads the settings, and what else is kept, from the storage that Obsidian
   * gives the vault on this device. A device that had them in the file
   * `data.json` of the plugin, as before, takes them from there once, and the
   * file goes: left there, it would look as if the settings were in it.
   */
  private async readStored(): Promise<void> {
    const settings: unknown = this.app.loadLocalStorage(SETTINGS_KEY);
    const state: unknown = this.app.loadLocalStorage(STATE_KEY);
    const path = this.manifest.dir === undefined ? null : `${this.manifest.dir}/data.json`;
    const { adapter } = this.app.vault;
    /** True if the settings are in the storage of the app, so that the file of before has nothing to say */
    const kept = typeof settings === "object" && settings !== null;
    let file: unknown = null;
    let fileIsThere = false;
    try {
      fileIsThere = path !== null && (await adapter.exists(path));
      if (fileIsThere && !kept) {
        // Not what Obsidian reads the file with: that takes a file that is cut off for no file at all
        file = JSON.parse(await adapter.read(path!));
      }
    } catch (error) {
      // There, and not to be read. The settings start as the plugin comes, and the file stays for a person to look at.
      console.error("piecemeal-git: the settings of before could not be read", error);
      fileIsThere = false;
    }
    const stored = readStored(settings, state, file);
    this.config = stored.config;
    this.last = stored.state.last;
    this.panelPlaced = stored.state.panelPlaced;
    if (stored.fromFile) {
      this.app.saveLocalStorage(SETTINGS_KEY, this.config);
      this.app.saveLocalStorage(STATE_KEY, { last: this.last, panelPlaced: this.panelPlaced } satisfies DeviceState);
    }
    if (fileIsThere && path !== null && (stored.fromFile || kept)) {
      try {
        await adapter.remove(path);
      } catch (error) {
        console.error("piecemeal-git: the file of the settings of before could not be removed", error);
      }
    }
  }

  /** Keeps the settings, after one of them changed. */
  saveSettings(): void {
    this.app.saveLocalStorage(SETTINGS_KEY, this.config);
    this.refresh();
    // What the reports say depends on the settings too: without an address there is nothing to sync with
    this.redraw();
  }

  /** Keeps how the last sync went and that the panel has its place, and shows it. */
  private saveState(): void {
    this.app.saveLocalStorage(STATE_KEY, { last: this.last, panelPlaced: this.panelPlaced } satisfies DeviceState);
    this.refresh();
    this.redraw();
  }

  /**
   * Puts the panel into the right sidebar the first time the plugin runs in
   * a vault, without opening the sidebar. Its icon is then among the tabs
   * there, also where the ribbon is hidden or folded into a menu.
   */
  private async placePanel(): Promise<void> {
    this.onePanel();
    if (this.panelPlaced) {
      return;
    }
    if (this.panels().length === 0) {
      await this.app.workspace.getRightLeaf(false)?.setViewState({ type: VIEW_TYPE, active: false });
    }
    this.panelPlaced = true;
    this.saveState();
  }

  /**
   * The tabs of the sidebars that are the panel, by what each of them is to
   * show. That finds one that Obsidian has not made yet too, and one that it
   * kept while the plugin was taken out and put in again, as for an update.
   */
  private panels(): WorkspaceLeaf[] {
    const found: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.getViewState().type === VIEW_TYPE) {
        found.push(leaf);
      }
    });
    return found;
  }

  /**
   * Closes every panel but one. A second one came to be where the plugin was
   * updated while Obsidian ran and no longer knew that the panel had its
   * place: the tab that Obsidian kept for it showed only after the plugin had
   * put in another. Two panels say the same, so one of them goes.
   */
  private onePanel(): void {
    for (const extra of this.panels().slice(1)) {
      extra.detach();
    }
  }

  /** Shows the panel, and puts it into the right sidebar first if it is in neither. */
  async openPanel(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = this.panels()[0] ?? null;
    if (leaf === null) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf !== null) {
      await workspace.revealLeaf(leaf);
    }
  }

  /** The reports that are on the screen: the panels of the sidebars, and the dialog while it is open. */
  private reports(): Report[] {
    const shown: Report[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      // A panel that was not looked at yet is not made yet
      if (leaf.view instanceof SyncView) {
        shown.push(leaf.view.report);
      }
    }
    if (this.report !== null) {
      shown.push(this.report.report);
    }
    return shown;
  }

  /** Draws every report anew: after a sync started or ended, and after a copy was done with. */
  redraw(): void {
    for (const report of this.reports()) {
      report.render();
    }
    if (this.running) {
      this.refresh();
    }
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
    const report = new ReportModal(this.app, this, () => {
      if (this.report === report) {
        this.report = null;
      }
    });
    this.report = report;
    report.open();
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
      } else if (last.attention || this.copies.size > 0) {
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
    for (const report of this.reports()) {
      if (this.running) {
        report.progress(words);
      } else {
        // How long ago the last sync was changes by itself as time goes by
        report.tick();
      }
    }
  }

  /** Tells what a sync did. One that left something to look at stays until it is closed, and opens the list. */
  private tell(result: SyncResult, unasked: boolean): void {
    const again = restart(result, this.app.vault.configDir);
    const calm = [headline(result), ...notes(result), ...again];
    const toLookAt = concerns(result);
    const taken = result.downloaded.length + result.deletedHere.length + result.merged.length;
    if (toLookAt.length === 0) {
      if (!unasked || taken > 0) {
        // What asks a person to do something stays until it is closed
        new Notice(calm.join("\n"), again.length > 0 ? 0 : 5000);
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
   * True if what Obsidian deletes goes into a trash, its own or the one of
   * the system, and not away for good. That is a setting of Obsidian.
   */
  private trashKeeps(): boolean {
    // Not a part of what Obsidian promises to plugins, so it is asked for with care. Not known counts as no.
    const option = (this.app.vault as unknown as { getConfig?: (key: string) => unknown }).getConfig?.("trashOption");
    return option === "system" || option === "local";
  }

  /**
   * What a sync and a look at the vault are told alike: where the vault and
   * the repository are, who the commits are by, and what is left out.
   */
  private common(): { fs: VerifiedFs; options: SyncOptions } {
    const { url, branch, tokenSecret, authorName, authorEmail, device, maxFileMB, mergeText, onConflict } = this.config;
    const token = (tokenSecret === "" ? null : this.app.secretStorage.getSecret(tokenSecret)) ?? undefined;
    const fs = new VerifiedFs(
      new ObsidianFs(
        this.app.vault.adapter,
        // A file that the remote removed goes where Obsidian puts the files that a person deletes
        async (path) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) {
            return false;
          }
          await this.app.fileManager.trashFile(file);
          return true;
        },
        // Obsidian keeps the size and time of every note in mind, which saves a look at the disk for each
        (path) => {
          const file = this.app.vault.getAbstractFileByPath(path);
          return file instanceof TFile ? { size: file.stat.size, mtime: file.stat.mtime } : null;
        },
        // A file that Obsidian deletes can be had back if it is one that Obsidian puts into a trash, and the settings name one
        (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile && this.trashKeeps(),
      ),
    );
    const remote = remoteOf(url, token);
    const github = parseGitHub(remote.url);
    const { configDir } = this.app.vault;
    // What stays on the device: the settings of this plugin, the trash of Obsidian, and the files in
    // which Obsidian keeps what is open on this device, which change whenever a note is opened
    const own = new Set([`${configDir}/plugins/${this.manifest.id}/data.json`, `${configDir}/workspace.json`, `${configDir}/workspace-mobile.json`]);
    const from = device !== "" ? device : Platform.isTablet ? "a tablet" : Platform.isMobile ? "a phone" : "a computer";
    return {
      fs,
      options: {
        fs,
        http: obsidianHttp,
        remote,
        branch: branch === "" ? undefined : branch,
        storeDir: STORE_DIR,
        exclude: (path) => own.has(path) || path === ".trash" || path.startsWith(".trash/"),
        author: {
          name: authorName !== "" ? authorName : "piecemeal-git",
          email: authorEmail !== "" ? authorEmail : "piecemeal-git@users.noreply.github.com",
        },
        message: () => `Sync from ${from}`,
        // An iPhone, an iPad and a Mac keep the letters of a name like "한글.md" in parts
        composeNames: Platform.isIosApp || Platform.isMacOS,
        mergeText,
        onConflict,
        changedAt: github === null ? undefined : githubChangedAt(obsidianHttp, github, token),
        maxFileBytes: maxFileMB * MB,
        batchBytes: BATCH_BYTES,
        wait: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
        sizes: github === null ? undefined : githubSizes(obsidianHttp, github, token),
        largeBlob: github === null ? undefined : githubLargeBlob(obsidianHttp, fs, github, token, BATCH_BYTES),
      },
    };
  }

  /**
   * Looks at what changed in the vault since the last sync, and shows it.
   * Only the vault is asked. Not while a sync runs: that changes what is
   * looked at, and looks again by itself when it ends.
   */
  async look(): Promise<void> {
    if (this.running || this.looking || this.config.url === "") {
      return;
    }
    this.looking = true;
    this.stale = false;
    try {
      const local = await localChanges(this.common().options);
      this.changes = local.synced ? local.changes : null;
    } catch (error) {
      console.error("piecemeal-git: the vault could not be looked at", error);
      this.changes = null;
    } finally {
      this.looking = false;
    }
    this.looked = true;
    this.redraw();
  }

  /**
   * Looks at the vault if a report is on the screen to show what is found.
   * Called for every change of a file, so it waits for a quiet moment. With
   * no report on the screen nothing is looked at: `stale` is kept, and the
   * report looks when it comes onto the screen.
   */
  private readonly lookSoon = debounce(
    () => {
      if (this.stale && this.reports().some((report) => report.isShown())) {
        void this.look();
      }
    },
    2000,
    true,
  );

  /** True if the vault may have changed since it was looked at */
  private stale = true;

  /** Called when a file of the vault changed, or a sync ended that left something unsent. */
  private changedSince(): void {
    this.stale = true;
    this.lookSoon();
  }

  /** Called when a report comes onto the screen: it shows what is true now, and not what was true when it was last seen. */
  shown(): void {
    if (this.stale || !this.looked) {
      void this.look();
    }
  }

  /** True once the vault was looked at, whatever was found */
  looked = false;

  /**
   * What a file held when the vault was last synced. The device does not
   * keep it, so the repository is asked. The last few are kept in mind, for a
   * comparison that is opened a second time.
   */
  async contentBefore(entry: Entry): Promise<Uint8Array> {
    const kept = this.befores.get(entry.oid);
    if (kept !== undefined) {
      return kept;
    }
    const { options } = this.common();
    const fetched = await fetchPack(options.http, options.remote, { wants: [entry.oid] });
    const object = (await parsePack(fetched.pack)).find((candidate) => candidate.oid === entry.oid);
    if (object === undefined || object.type !== "blob") {
      throw new Error("The server did not send the file as it was.");
    }
    this.befores.set(entry.oid, object.data);
    if (this.befores.size > 4) {
      this.befores.delete(this.befores.keys().next().value!);
    }
    return object.data;
  }

  /** What a file of the vault holds now, or null if it is not there. */
  async contentNow(path: string): Promise<Uint8Array | null> {
    return this.common().fs.read(path);
  }

  /** Shows what changed in a file since the last sync, with what takes the change back: all of it, or some of it. */
  openDiff(change: LocalChange): void {
    const nothing = new Uint8Array(0);
    new DiffModal(this.app, {
      title: change.path,
      what: change.kind === "new" ? "A new file." : change.kind === "removed" ? "Removed from this vault." : "Changed since the last sync.",
      legend:
        change.kind === "changed"
          ? "− is a line as it was at the last sync, + one as it is now. For each change, what is green is kept. Saving puts that into the file."
          : undefined,
      waiting: change.kind === "new" ? "Reading the file…" : "Asking the repository for the file as it was…",
      beforeSize: change.beforeSize,
      afterSize: change.size,
      before: async () => (change.before === null ? nothing : await this.contentBefore(change.before)),
      after: async () => (change.kind === "removed" ? nothing : ((await this.contentNow(change.path)) ?? nothing)),
      actions: [
        {
          text: change.kind === "new" ? "Revert: remove the file" : change.kind === "removed" ? "Revert: bring the file back" : "Revert the whole file",
          run: async () => {
            await this.revert([change], false);
          },
        },
      ],
      choose:
        change.kind === "changed"
          ? {
              before: "As it was",
              after: "Mine",
              start: 1,
              save: async (text) => {
                await this.put(change.path, new TextEncoder().encode(text));
                new Notice(`${change.path} holds what you chose. What it held went where Obsidian puts files that you delete.`);
              },
            }
          : undefined,
    }).open();
  }

  /** Writes a file of the vault in place of what it holds. What it held goes where Obsidian puts files that are deleted, where it has a place for it. */
  private async put(path: string, data: Uint8Array): Promise<void> {
    const { fs } = this.common();
    if ((await fs.stat(path)) !== null) {
      await fs.discard?.(path);
    }
    await fs.write(path, data);
    this.changedSince();
  }

  /**
   * Takes changes back to what the vault held at the last sync, after
   * asking: a changed file holds again what it held, a new file goes, and a
   * removed one is there again.
   *
   * @param ask false where the person has pressed a button that says what is done
   * @returns true if it was done
   */
  async revert(changes: LocalChange[], ask = true): Promise<boolean> {
    if (changes.length === 0 || this.running) {
      return false;
    }
    if (
      ask &&
      !(await new AskModal(this.app, {
        title: changes.length === 1 ? "Revert this file?" : `Revert these ${changes.length} files?`,
        text: "They are put back to what they were at the last sync: a changed file holds what it held then, a new file is removed, and a removed file is there again. What a note holds now goes where Obsidian puts files that you delete.",
        paths: changes.map((change) => `${change.kind}: ${change.path}`),
        yes: "Revert",
      }).ask())
    ) {
      return false;
    }
    // What was said of a try that failed holds no more once another one is made
    this.revertFailed?.hide();
    this.revertFailed = null;
    try {
      const { reverted, left } = await revert(this.common().options, changes);
      const said = [`Reverted ${reverted.length === 1 ? reverted[0] : `${reverted.length} files`}.`];
      if (left.length > 0) {
        said.push(`Left as it is, too large to be had back in one piece: ${list(left)}.`);
      }
      new Notice(said.join(" "));
    } catch (error) {
      console.error("piecemeal-git: the files could not be reverted", error);
      this.revertFailed = new Notice(`The files could not be reverted. ${explain(error)}`, 0);
      return false;
    } finally {
      this.changedSince();
      void this.look();
    }
    return true;
  }

  /**
   * Shows how the two versions of a file that two devices changed differ:
   * the one of the repository, which has the name, and the copy beside it.
   * Both are in the vault, so nothing is asked of the repository. What can
   * be done about the two is under the comparison.
   */
  openCopyDiff(copy: TFile, original: string): void {
    const theirs = this.app.vault.getAbstractFileByPath(original);
    const nothing = new Uint8Array(0);
    new DiffModal(this.app, {
      title: original,
      what: "The version of the repository, and the copy beside it.",
      legend: "− is a line of the repository, + one of the copy. For each change, what is green is kept. Saving puts that into the file, and the copy goes.",
      waiting: "Reading the two…",
      beforeSize: theirs instanceof TFile ? theirs.stat.size : null,
      afterSize: copy.stat.size,
      before: async () => (theirs instanceof TFile ? new Uint8Array(await this.app.vault.readBinary(theirs)) : nothing),
      after: async () => new Uint8Array(await this.app.vault.readBinary(copy)),
      // The dialog closes when one of these is done, so each says what it did
      actions: [
        {
          text: "Keep the repository's",
          run: async () => {
            await this.dropCopy(copy);
            new Notice(`${original} is as the repository has it. The copy is gone.`);
          },
        },
        {
          text: "Take the copy",
          run: async () => {
            if (await this.takeCopy(copy, original)) {
              new Notice(`${original} holds what the copy held. The next sync sends it.`);
            }
          },
        },
      ],
      choose: {
        before: "Repository's",
        after: "The copy's",
        start: 0,
        save: async (text) => {
          if (await this.takeCopy(copy, original, new TextEncoder().encode(text).buffer)) {
            new Notice(`${original} holds what you chose, and the copy is gone. The next sync sends it.`);
          }
        },
      },
    }).open();
  }

  /** Is done with a copy by keeping the version of the repository: the copy goes where Obsidian puts files that are deleted. */
  async dropCopy(copy: TFile): Promise<void> {
    await this.app.fileManager.trashFile(copy);
    this.redraw();
  }

  /**
   * Is done with a copy by putting it in the place of the file that it is beside. False if that cannot be done.
   * @param put what to put there in place of what the copy holds: the text that was made of the two
   */
  async takeCopy(copy: TFile, original: string, put?: ArrayBuffer): Promise<boolean> {
    const data = put ?? (await this.app.vault.readBinary(copy));
    const now = this.app.vault.getAbstractFileByPath(original);
    if (now instanceof TFile) {
      await this.app.vault.modifyBinary(now, data);
    } else if (now === null) {
      await this.app.vault.createBinary(original, data);
    } else {
      new Notice(`${original} is a folder now. The copy stays.`);
      return false;
    }
    await this.app.fileManager.trashFile(copy);
    this.redraw();
    return true;
  }

  /**
   * The list of the plugins that are on is a file of the vault like any other,
   * and a sync takes the one of the repository. One that came from a device
   * without this plugin would turn it off when Obsidian starts again, and with
   * it the sync. So this plugin is put back on the list, and the next sync
   * sends the list with it.
   */
  private async stayOn(result: SyncResult): Promise<void> {
    const path = `${this.app.vault.configDir}/community-plugins.json`;
    if (!result.downloaded.includes(path) && !result.merged.includes(path)) {
      return;
    }
    try {
      const { adapter } = this.app.vault;
      const on: unknown = JSON.parse(await adapter.read(path));
      if (Array.isArray(on) && !on.includes(this.manifest.id)) {
        // Written as Obsidian writes it, so that the file does not change when Obsidian writes it again
        await adapter.write(path, JSON.stringify([...(on as unknown[]), this.manifest.id], null, 2));
      }
    } catch (error) {
      console.error("piecemeal-git: the list of plugins could not be read", error);
    }
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
    if (this.config.url === "") {
      if (!unasked) {
        new Notice("Give the address of the repository first.");
        this.openSettings();
      }
      return null;
    }
    this.running = true;
    this.progress = null;
    this.refresh();
    this.redraw();
    let waiting = unasked ? null : new Notice("Syncing…", 0);
    /** True if a sync that nobody asked for stopped because a person should see first what it is about to do */
    let held = false;
    /** When the notice and the icon last said how far the sync is */
    let shownAt = 0;
    try {
      const { fs, options } = this.common();
      const result = await sync({
        ...options,
        onProgress: (progress) => {
          this.progress = progress;
          // Told for every file. What is shown follows a few times a second, which is all that an eye takes in.
          const now = Date.now();
          if (now - shownAt >= 150 || progress.done === 0 || progress.done === progress.total) {
            shownAt = now;
            waiting?.setMessage(progressText(progress));
            this.refresh();
          }
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
      if (result.busy.length === 0 && result.tooLargeChanged.length === 0) {
        // All that was changed here is sent, so there is nothing left that differs: known without a look at the vault
        this.changes = [];
        this.looked = true;
        this.stale = false;
      } else {
        this.changedSince();
      }
      await this.stayOn(result);
      const toLookAt = concerns(result);
      this.last = {
        at: Date.now(),
        ok: true,
        text: [headline(result), ...notes(result), ...restart(result, this.app.vault.configDir), ...toLookAt].join(" "),
        attention: toLookAt.length > 0,
      };
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
      console.error("piecemeal-git: the sync failed", error);
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
      // Draws every report anew as well
      this.saveState();
    }
  }
}
