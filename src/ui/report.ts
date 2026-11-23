import { type App, ButtonComponent, Modal, Notice, TFile, TFolder } from "obsidian";
import type PiecemealGitPlugin from "../main.ts";
import { ago, headline } from "./words.ts";

/** What marks the name of the copy that a sync puts beside a file that both sides changed. */
const COPY = / \(conflict \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)(?=(?:\.[^./]*)?$)/;

interface Copy {
  /**
   * The version of this device of a file that both sides changed. Beside a
   * folder it is a file of the repository that has the name of the folder.
   */
  copy: TFile;
  /** The path of the file that it is a copy beside */
  original: string;
}

/** The copies of the vault that wait for a person to choose. */
export function conflictCopies(app: App): Copy[] {
  return app.vault
    .getFiles()
    .filter((file) => COPY.test(file.path))
    .map((file) => ({ copy: file, original: file.path.replace(COPY, "") }))
    .sort((a, b) => a.original.localeCompare(b.original));
}

/**
 * What the last sync did, file by file, and the copies that wait to be
 * looked at, each with the two ways to be done with it.
 */
export class ReportModal extends Modal {
  private readonly plugin: PiecemealGitPlugin;

  constructor(app: App, plugin: PiecemealGitPlugin) {
    super(app);
    this.plugin = plugin;
  }

  override onOpen(): void {
    this.modalEl.addClass("piecemeal-git-modal");
    this.setTitle("Sync with the repository");
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  /** A path that opens its file when it is one that Obsidian shows. */
  private path(parent: HTMLElement, path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const link = parent.createEl("a", { text: path, cls: "piecemeal-git-path" });
      link.addEventListener("click", () => {
        this.close();
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
    const details = this.contentEl.createEl("details", { cls: "piecemeal-git-section" });
    details.createEl("summary", { text: `${title} (${paths.length})` });
    if (note !== undefined) {
      details.createEl("p", { text: note, cls: "piecemeal-git-note" });
    }
    const rows = details.createEl("ul");
    for (const path of paths.slice(0, 500)) {
      this.path(rows.createEl("li"), path);
    }
    if (paths.length > 500) {
      rows.createEl("li", { text: `and ${paths.length - 500} more` });
    }
  }

  private render(): void {
    const { contentEl, plugin } = this;
    contentEl.empty();

    const { last } = plugin;
    const state = contentEl.createDiv({ cls: "piecemeal-git-state" });
    if (plugin.config.url === "") {
      state.setText("No repository yet. Give its address in the settings.");
    } else if (last === null) {
      state.setText("Not synced yet.");
    } else {
      state.createDiv({ text: last.ok ? `Synced ${ago(last.at)}.` : `The last sync failed, ${ago(last.at)}.`, cls: last.ok ? "" : "piecemeal-git-failed-text" });
      // What it did is told below, file by file. Why it failed is told nowhere else.
      state.createDiv({ text: last.ok && plugin.lastResult !== null ? headline(plugin.lastResult) : last.text, cls: "piecemeal-git-note" });
    }
    const top = contentEl.createDiv({ cls: "piecemeal-git-buttons" });
    new ButtonComponent(top).setButtonText("Settings").onClick(() => {
      this.close();
      plugin.openSettings();
    });
    const again = new ButtonComponent(top)
      .setButtonText(plugin.running ? "Syncing…" : "Sync now")
      .setCta()
      .setDisabled(plugin.running || plugin.config.url === "")
      .onClick(async () => {
        again.setDisabled(true).setButtonText("Syncing…");
        await plugin.sync();
        this.render();
      });

    const copies = conflictCopies(this.app);
    if (copies.length > 0) {
      contentEl.createEl("h4", { text: `Changed on both sides (${copies.length})` });
      contentEl.createEl("p", {
        text: "Both this device and another one changed these files. The version of the repository took the name, and yours is beside it as a copy. Look at the two, then keep one.",
        cls: "piecemeal-git-note",
      });
      for (const { copy, original } of copies) {
        const box = contentEl.createDiv({ cls: "piecemeal-git-copy" });
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
            this.render();
          });
          continue;
        }
        const theirs = box.createDiv();
        theirs.createSpan({ text: "The repository's: ", cls: "piecemeal-git-label" });
        this.path(theirs, original);
        const mine = box.createDiv();
        mine.createSpan({ text: "Yours: ", cls: "piecemeal-git-label" });
        this.path(mine, copy.path);
        const choice = box.createDiv({ cls: "piecemeal-git-buttons" });
        new ButtonComponent(choice).setButtonText("Keep the repository's").onClick(async () => {
          await this.app.fileManager.trashFile(copy);
          this.render();
        });
        new ButtonComponent(choice).setButtonText("Take mine back").onClick(async () => {
          const data = await this.app.vault.readBinary(copy);
          const mineNow = this.app.vault.getAbstractFileByPath(original);
          if (mineNow instanceof TFile) {
            await this.app.vault.modifyBinary(mineNow, data);
          } else if (mineNow === null) {
            await this.app.vault.createBinary(original, data);
          } else {
            new Notice(`${original} is a folder now. The copy stays.`);
            return;
          }
          await this.app.fileManager.trashFile(copy);
          this.render();
        });
      }
    }

    const result = plugin.lastResult;
    if (result !== null) {
      contentEl.createEl("h4", { text: "What the last sync did" });
      const before = contentEl.childElementCount;
      this.section("Taken from the repository", result.downloaded);
      this.section("Replaced by the version of the repository", result.replaced, "This vault held them otherwise before its first sync. A note that gave way went where Obsidian puts files that you delete.");
      this.section("Sent to the repository", result.uploaded);
      this.section("Put together", result.merged, "Both sides changed different lines of these texts. They hold both changes now.");
      this.section("Removed from this vault", result.deletedHere, "Removed from the repository by another device. They went where Obsidian puts files that you delete.");
      this.section("Removed from the repository", result.deletedThere);
      this.section("Too large to send", [...result.tooLargeIgnored, ...result.tooLargeChanged], "Above the largest size of the settings. They stay in this vault.");
      this.section("Left out of this vault", [...result.tooLargeThere, ...result.sameName], "Too large to get on this device, or named like another file but for capital letters. They stay in the repository.");
      this.section("Left for the next sync", result.busy, "Changed while the sync ran, or could not be written.");
      if (contentEl.childElementCount === before) {
        contentEl.createEl("p", { text: "Nothing. The vault and the repository held the same files.", cls: "piecemeal-git-note" });
      }
    }
  }
}
