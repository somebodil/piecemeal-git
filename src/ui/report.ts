import { type App, ButtonComponent, ExtraButtonComponent, ItemView, Modal, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import type PiecemealGitPlugin from "../main.ts";
import { ago, headline } from "./words.ts";

/** What marks the name of the copy that a sync puts beside a file that both sides changed. */
const COPY = / \(conflict \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)(?=(?:\.[^./]*)?$)/;

/** True for the path of a copy that a sync put beside a file that both sides changed. */
export function isCopy(path: string): boolean {
  // Most paths have no bracket at all, and a look for one costs far less than the pattern
  return path.includes(" (conflict ") && COPY.test(path);
}

/** The paths of the copies among the files of the vault. */
export function conflictCopies(app: App): string[] {
  const copies: string[] = [];
  for (const file of app.vault.getFiles()) {
    if (isCopy(file.path)) {
      copies.push(file.path);
    }
  }
  return copies;
}

/**
 * The state of the sync, drawn into an element: how the last sync went, a
 * button that starts one, the copies that wait to be looked at, each with the
 * two ways to be done with it, and what the last sync did, file by file.
 * The dialog and the panel of the sidebar show the same.
 */
export class Report {
  private readonly app: App;
  private readonly plugin: PiecemealGitPlugin;
  private readonly el: HTMLElement;
  /** Called before a file is opened, so that what covers it can make way */
  private readonly leave: () => void;
  /** Where it says how far a sync is. Null until the report is drawn. */
  private progressEl: HTMLElement | null = null;
  /** Where it says how long ago the last sync was. Null while there is none to tell of. */
  private agoEl: HTMLElement | null = null;
  /** The paths of the changed files that are ticked, to be reverted together */
  private readonly ticked = new Set<string>();

  constructor(app: App, plugin: PiecemealGitPlugin, el: HTMLElement, leave: () => void) {
    this.app = app;
    this.plugin = plugin;
    this.el = el;
    this.leave = leave;
  }

  /** A path that opens its file when it is one that Obsidian shows. */
  private path(parent: HTMLElement, path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const link = parent.createEl("a", { text: path, cls: "piecemeal-git-path" });
      link.addEventListener("click", () => {
        this.leave();
        void this.app.workspace.getLeaf(false).openFile(file);
      });
    } else {
      parent.createSpan({ text: path, cls: "piecemeal-git-path" });
    }
  }

  private section(title: string, paths: string[], note?: string): void {
    if (paths.length === 0) {
      return;
    }
    const details = this.el.createEl("details", { cls: "piecemeal-git-section" });
    details.createEl("summary", { text: `${title} (${paths.length})` });
    if (note !== undefined) {
      details.createEl("p", { text: note, cls: "piecemeal-git-note" });
    }
    // A list of hundreds of files is made when it is looked at, and not with every sync
    let filled = false;
    details.addEventListener("toggle", () => {
      if (filled || !details.open) {
        return;
      }
      filled = true;
      const rows = details.createEl("ul");
      for (const path of paths.slice(0, 500)) {
        this.path(rows.createEl("li"), path);
      }
      if (paths.length > 500) {
        rows.createEl("li", { text: `and ${paths.length - 500} more` });
      }
    });
  }

  /** True if the report is on the screen, and not in a sidebar that is closed. */
  isShown(): boolean {
    return this.el.isShown();
  }

  /**
   * The files that are not as they were at the last sync. A file that is
   * pressed shows what changed in it, line by line.
   */
  private changed(): void {
    const { el, plugin } = this;
    if (!plugin.looked) {
      // Not looked at yet. It is when the report comes onto the screen, and the plugin draws the report anew then.
      return;
    }
    const { changes } = plugin;
    if (changes === null) {
      // Never synced: there is nothing to hold the vault against
      return;
    }
    const head = el.createDiv({ cls: "piecemeal-git-changes-head" });
    head.createEl("h4", { text: `Changed here since the last sync (${changes.length})` });
    new ExtraButtonComponent(head)
      .setIcon("rotate-cw")
      .setTooltip("Look at the vault again")
      .onClick(() => {
        void plugin.look();
      });
    if (changes.length === 0) {
      el.createEl("p", { text: "Nothing. The vault is as the last sync left it.", cls: "piecemeal-git-note" });
      return;
    }
    el.createEl("p", {
      text: "Press a file to see what changed in it. The next sync sends these. To take some back, tick them and revert.",
      cls: "piecemeal-git-note",
    });
    // What is ticked stays ticked while the list is drawn anew, as long as the file is still on it
    const paths = new Set(changes.map((change) => change.path));
    for (const path of this.ticked) {
      if (!paths.has(path)) {
        this.ticked.delete(path);
      }
    }
    const shown = changes.slice(0, 300);
    const bar = el.createDiv({ cls: "piecemeal-git-revert" });
    const all = bar.createEl("label");
    const allBox = all.createEl("input", { type: "checkbox" });
    all.appendText(" All");
    const button = new ButtonComponent(bar).onClick(async () => {
      const chosen = changes.filter((change) => this.ticked.has(change.path));
      if (await plugin.revert(chosen)) {
        this.ticked.clear();
      }
    });
    button.buttonEl.addClass("mod-warning");
    const boxes: HTMLInputElement[] = [];
    /** Brings the button and the box for all up to what is ticked. Costs two texts, however long the list is. */
    const tell = (): void => {
      const count = this.ticked.size;
      button.setButtonText(count === 0 ? "Revert" : `Revert (${count})`).setDisabled(count === 0 || plugin.running);
      allBox.checked = count > 0 && count === shown.length;
      allBox.indeterminate = count > 0 && count < shown.length;
    };
    allBox.addEventListener("change", () => {
      const on = allBox.checked;
      shown.forEach((change, i) => {
        if (on) {
          this.ticked.add(change.path);
        } else {
          this.ticked.delete(change.path);
        }
        boxes[i].checked = on;
      });
      tell();
    });
    const rows = el.createEl("ul", { cls: "piecemeal-git-changes" });
    for (const change of shown) {
      const item = rows.createEl("li");
      const box = item.createEl("input", { type: "checkbox" });
      box.checked = this.ticked.has(change.path);
      box.addEventListener("change", () => {
        if (box.checked) {
          this.ticked.add(change.path);
        } else {
          this.ticked.delete(change.path);
        }
        tell();
      });
      boxes.push(box);
      item.createSpan({ text: change.kind, cls: `piecemeal-git-kind piecemeal-git-kind-${change.kind}` });
      const link = item.createEl("a", { text: change.path, cls: "piecemeal-git-path" });
      link.addEventListener("click", () => {
        plugin.openDiff(change);
      });
    }
    if (changes.length > 300) {
      rows.createEl("li", { text: `and ${changes.length - 300} more. They show when these are done with.` });
    }
    tell();
  }

  /** Says how far the sync is that runs. Costs one text, so it can be told often. */
  progress(text: string): void {
    this.progressEl?.setText(text);
  }

  /** How the last sync went and how long ago it was, in a line. */
  private when(): string {
    const { last } = this.plugin;
    if (last === null) {
      return "";
    }
    return last.ok ? `Synced ${ago(last.at)}.` : `The last sync failed, ${ago(last.at)}.`;
  }

  /** Brings up to date what changes as time goes by. */
  tick(): void {
    this.agoEl?.setText(this.when());
  }

  /** Draws all of it anew. */
  render(): void {
    const { el, plugin } = this;
    el.empty();

    const { last } = plugin;
    const state = el.createDiv({ cls: "piecemeal-git-state" });
    this.agoEl = null;
    if (plugin.config.url === "") {
      state.setText("No repository yet. Give its address in the settings.");
    } else if (last === null) {
      state.setText("Not synced yet.");
    } else {
      this.agoEl = state.createDiv({ text: this.when(), cls: last.ok ? "" : "piecemeal-git-failed-text" });
      // What it did is told below, file by file. Why it failed is told nowhere else.
      state.createDiv({ text: last.ok && plugin.lastResult !== null ? headline(plugin.lastResult) : last.text, cls: "piecemeal-git-note" });
    }
    this.progressEl = el.createDiv({ cls: "piecemeal-git-note piecemeal-git-progress" });
    const top = el.createDiv({ cls: "piecemeal-git-buttons" });
    new ButtonComponent(top).setButtonText("Settings").onClick(() => {
      this.leave();
      plugin.openSettings();
    });
    new ButtonComponent(top)
      .setButtonText(plugin.running ? "Syncing…" : "Sync now")
      .setCta()
      .setDisabled(plugin.running || plugin.config.url === "")
      .onClick(() => {
        // The plugin draws every report anew when a sync starts and when it ends
        void plugin.sync();
      });

    this.changed();

    const copies = [...plugin.copies].sort((a, b) => a.localeCompare(b));
    if (copies.length > 0) {
      el.createEl("h4", { text: `Changed on both sides (${copies.length})` });
      el.createEl("p", {
        text: "Two devices changed these files. The version of the repository took the name, and the one of the device that synced later is beside it as a copy. Compare the two, then keep one. To keep some of each, open the file and put in by hand what you want of the copy, then keep the repository's.",
        cls: "piecemeal-git-note",
      });
      for (const path of copies.slice(0, 200)) {
        const copy = this.app.vault.getAbstractFileByPath(path);
        if (!(copy instanceof TFile)) {
          continue;
        }
        const original = path.replace(COPY, "");
        const box = el.createDiv({ cls: "piecemeal-git-copy" });
        if (this.app.vault.getAbstractFileByPath(original) instanceof TFolder) {
          // A folder here and a file in the repository: the folder kept the name
          const folder = box.createDiv();
          folder.createSpan({ text: "A folder here: ", cls: "piecemeal-git-label" });
          this.path(folder, original);
          const file = box.createDiv();
          file.createSpan({ text: "A file of the repository: ", cls: "piecemeal-git-label" });
          this.path(file, copy.path);
          const only = box.createDiv({ cls: "piecemeal-git-buttons" });
          new ButtonComponent(only).setButtonText("Remove the file").onClick(async () => {
            await this.app.fileManager.trashFile(copy);
            plugin.redraw();
          });
          continue;
        }
        const theirs = box.createDiv();
        theirs.createSpan({ text: "The repository's: ", cls: "piecemeal-git-label" });
        this.path(theirs, original);
        const mine = box.createDiv();
        mine.createSpan({ text: "The copy: ", cls: "piecemeal-git-label" });
        this.path(mine, copy.path);
        const choice = box.createDiv({ cls: "piecemeal-git-buttons" });
        // What the two differ in comes first: it is what a choice between them is made by
        new ButtonComponent(choice)
          .setButtonText("Compare")
          .setCta()
          .onClick(() => {
            plugin.openCopyDiff(copy, original);
          });
        new ButtonComponent(choice).setButtonText("Keep the repository's").onClick(async () => {
          await plugin.dropCopy(copy);
        });
        new ButtonComponent(choice).setButtonText("Take the copy").onClick(async () => {
          await plugin.takeCopy(copy, original);
        });
      }
      if (copies.length > 200) {
        el.createEl("p", { text: `And ${copies.length - 200} more. They show when these are done with.`, cls: "piecemeal-git-note" });
      }
    }

    const result = plugin.lastResult;
    if (result !== null) {
      el.createEl("h4", { text: "What the last sync did" });
      const before = el.childElementCount;
      this.section("Taken from the repository", result.downloaded);
      this.section("Replaced by the version of the repository", result.replaced, "This vault held them otherwise before its first sync. A note that gave way went where Obsidian puts files that you delete.");
      this.section("Sent to the repository", result.uploaded);
      this.section("Put together", result.merged, "Both sides changed different lines of these texts. They hold both changes now.");
      this.section("Removed from this vault", result.deletedHere, "Removed from the repository by another device. They went where Obsidian puts files that you delete.");
      this.section("Removed from the repository", result.deletedThere);
      this.section("Too large to send", [...result.tooLargeIgnored, ...result.tooLargeChanged], "Above the largest size of the settings. They stay in this vault.");
      this.section("Left out of this vault", [...result.tooLargeThere, ...result.sameName], "Too large to get on this device, or named like another file but for capital letters. They stay in the repository.");
      this.section("Left for the next sync", result.busy, "Changed while the sync ran, or could not be written.");
      if (el.childElementCount === before) {
        el.createEl("p", { text: "Nothing. The vault and the repository held the same files.", cls: "piecemeal-git-note" });
      }
    }
  }
}

/** The report as a dialog. */
export class ReportModal extends Modal {
  readonly report: Report;
  private readonly plugin: PiecemealGitPlugin;
  private readonly closed: () => void;

  /** @param closed called when the dialog is gone from the screen */
  constructor(app: App, plugin: PiecemealGitPlugin, closed: () => void) {
    super(app);
    this.plugin = plugin;
    this.report = new Report(app, plugin, this.contentEl, () => this.close());
    this.closed = closed;
  }

  override onOpen(): void {
    this.modalEl.addClass("piecemeal-git-modal");
    this.setTitle("Sync with the repository");
    this.report.render();
    this.plugin.shown();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.closed();
  }
}

/** What Obsidian knows the panel by */
export const VIEW_TYPE = "piecemeal-git";

/**
 * The report as a panel of a sidebar. Its icon stands among the tabs of the
 * sidebar, where it is also seen with the ribbon hidden, and can be put into
 * the other sidebar as any tab can.
 */
export class SyncView extends ItemView {
  readonly report: Report;
  private readonly plugin: PiecemealGitPlugin;
  /** Tells when the panel comes onto the screen: when its sidebar opens, or its tab is the one in front */
  private seen: IntersectionObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PiecemealGitPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.report = new Report(this.app, plugin, this.contentEl, () => undefined);
  }

  override getViewType(): string {
    return VIEW_TYPE;
  }

  override getDisplayText(): string {
    return "piecemeal-git";
  }

  override getIcon(): string {
    return "refresh-cw";
  }

  override onOpen(): Promise<void> {
    this.contentEl.addClass("piecemeal-git-view");
    this.report.render();
    // While the panel is out of sight the vault is not looked at. When it comes into sight, it is.
    this.seen = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        this.plugin.shown();
      }
    });
    this.seen.observe(this.contentEl);
    return Promise.resolve();
  }

  override onClose(): Promise<void> {
    this.seen?.disconnect();
    this.seen = null;
    this.contentEl.empty();
    return Promise.resolve();
  }
}
