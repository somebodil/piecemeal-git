import { type App, ButtonComponent, Modal, Platform } from "obsidian";
import { chosenText, diffCounts, type DiffRow, diffRows, diffText, sameRows, type TextDiff } from "../git/merge.ts";
import { explain } from "./words.ts";

/** Two versions of a file to compare, and what to say about them. */
export interface Comparison {
  /** The path of the file, which is what the dialog is called */
  title: string;
  /** What the two are, in a sentence: it stands above the comparison */
  what: string;
  /** What − and + stand for, where that is not what they stand for in any comparison. Said only with a comparison. */
  legend?: string;
  /** What is said while the two are read */
  waiting: string;
  /** How large each is, where that is known before it is read. One that is too large is not read. */
  beforeSize: number | null;
  afterSize: number | null;
  /** Reads the version whose lines are shown as taken away, and the one whose lines are shown as added */
  before: () => Promise<Uint8Array>;
  after: () => Promise<Uint8Array>;
  /** What can be done about the two, as buttons under the comparison. The dialog closes when one is done. */
  actions?: { text: string; cta?: boolean; run: () => Promise<void> }[];
  /**
   * Lets a person say for each change which of the two versions to keep
   * there, and saves the text that comes of it.
   */
  choose?: {
    /** What the two versions are called on the buttons of a change: the one before, and the one after */
    before: string;
    after: string;
    /** Which version every change starts with: 0 for the one before, 1 for the one after */
    start: 0 | 1;
    save: (text: string) => Promise<void>;
  };
}

/** A file larger than this, as it was or as it is, is not compared */
export const DIFF_MAX_BYTES = 5 * 1024 * 1024;
/** How many rows are drawn at a time. The next ones are drawn when the end of these comes near. */
const ROWS_AT_A_TIME = 200;
/** How many lines a fold shows when it is opened. A longer one keeps the rest folded. */
const LINES_OF_A_FOLD = 400;
/** How near the end of what is drawn has to come, in pixels, for more to be drawn */
const NEAR_THE_END = 600;

/**
 * Two versions of a file, compared line by line: a file as it was at the
 * last sync and as it is, or the two versions of a file that two devices
 * changed.
 *
 * Only what changed is shown, with a few lines around it. The lines that are
 * the same on both sides are folded, and a fold opens when it is pressed.
 * The rows are drawn as they come into sight, a few hundred at a time and
 * each lot in one go, so that a long comparison is on the screen at once and
 * costs what is looked at of it.
 */
export class DiffModal extends Modal {
  private readonly comparison: Comparison;
  /** False once the dialog is closed, so that what comes late is not drawn into it */
  private open_ = true;

  constructor(app: App, comparison: Comparison) {
    super(app);
    this.comparison = comparison;
  }

  override onOpen(): void {
    this.modalEl.addClass("piecemeal-git-modal", "piecemeal-git-diff-modal");
    this.setTitle(this.comparison.title);
    void this.load();
  }

  override onClose(): void {
    this.open_ = false;
    this.contentEl.empty();
  }

  /** Says one thing in place of the comparison. What can be done about the two stays under it. */
  private say(text: string, cls = "piecemeal-git-note", withActions = true): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text, cls });
    if (withActions) {
      this.actions(this.contentEl.createDiv({ cls: "piecemeal-git-buttons" }));
    }
  }

  /** The buttons for what can be done about the two versions. */
  private actions(row: HTMLElement): void {
    for (const action of this.comparison.actions ?? []) {
      const button = new ButtonComponent(row).setButtonText(action.text).onClick(async () => {
        await action.run();
        this.close();
      });
      if (action.cta === true) {
        button.setCta();
      }
    }
  }

  private async load(): Promise<void> {
    const { what } = this.comparison;
    if ((this.comparison.afterSize ?? 0) > DIFF_MAX_BYTES || (this.comparison.beforeSize ?? 0) > DIFF_MAX_BYTES) {
      this.say(`${what} Diff not supported: the file is larger than 5 MB.`);
      return;
    }
    this.say(this.comparison.waiting, "piecemeal-git-note", false);
    let before: Uint8Array;
    let after: Uint8Array;
    try {
      // What is on the device is read first: without it there is nothing to ask the repository for
      after = await this.comparison.after();
      before = await this.comparison.before();
    } catch (error) {
      if (this.open_) {
        this.say(`The two could not be read. ${explain(error)}`, "piecemeal-git-failed-text");
      }
      return;
    }
    if (!this.open_) {
      return;
    }
    if (before.length > DIFF_MAX_BYTES || after.length > DIFF_MAX_BYTES) {
      this.say(`${what} Diff not supported: the file is larger than 5 MB.`);
      return;
    }
    const diffed = diffText(before, after);
    if (diffed === null) {
      this.say(`${what} Diff not supported: the file is not a text, or has too many lines.`);
      return;
    }
    if (diffed.changes.length === 0) {
      this.say("The two hold the same.");
      return;
    }
    this.draw(diffed);
  }

  private draw(diffed: TextDiff): void {
    const { contentEl, comparison } = this;
    const { choose } = comparison;
    contentEl.empty();
    const { added, removed } = diffCounts(diffed);
    const head = contentEl.createDiv({ cls: "piecemeal-git-diff-head" });
    head.createSpan({ text: `${comparison.what} ` });
    head.createSpan({ text: `+${added}`, cls: "piecemeal-git-diff-plus" });
    head.createSpan({ text: " " });
    head.createSpan({ text: `−${removed}`, cls: "piecemeal-git-diff-minus" });
    if (comparison.legend !== undefined) {
      contentEl.createEl("p", { text: comparison.legend, cls: "piecemeal-git-note" });
    }
    if (diffed.coarse) {
      contentEl.createEl("p", {
        text: "A part of the two is too far apart to be compared line by line. It is shown as one change, with all its lines taken away and added.",
        cls: "piecemeal-git-note",
      });
    }
    const body = contentEl.createDiv({ cls: "piecemeal-git-diff" });
    body.toggleClass("piecemeal-git-diff-choosing", choose !== undefined);

    // --- Which version to keep, change by change ------------------------------
    /** For each change: 0 for the version before, 1 for the one after, 2 for both */
    const choices = new Uint8Array(diffed.changes.length).fill(choose?.start ?? 0);
    /** How many changes take the version before, how many the one after, and how many both */
    const taken = [0, 0, 0];
    taken[choose?.start ?? 0] = diffed.changes.length;
    /** The box of each change that is drawn: its rows are in it, so that a choice restyles them in one step */
    const boxes = new Map<number, HTMLElement>();
    let tally: HTMLElement | null = null;
    const tell = (): void => {
      tally?.setText(
        `Of ${diffed.changes.length} ${diffed.changes.length === 1 ? "change" : "changes"}: ${taken[0]} as ${choose?.before ?? ""}, ${taken[1]} as ${choose?.after ?? ""}, ${taken[2]} with both.`,
      );
    };
    const pick = (change: number, choice: number, box: HTMLElement): void => {
      taken[choices[change]]--;
      choices[change] = choice;
      taken[choice]++;
      box.dataset["choice"] = String(choice);
      tell();
    };
    /** The box of a change, made when the first of its rows is drawn. */
    const boxOf = (change: number, into: Node): HTMLElement => {
      let box = boxes.get(change);
      if (box === undefined) {
        box = createDiv({ cls: "piecemeal-git-diff-change" });
        box.dataset["choice"] = String(choices[change]);
        boxes.set(change, box);
        into.appendChild(box);
        if (choose !== undefined) {
          const made = box;
          const bar = made.createDiv({ cls: "piecemeal-git-diff-pick" });
          [choose.before, choose.after, "Both"].forEach((text, choice) => {
            const button = bar.createEl("button", { text, cls: `piecemeal-git-diff-pick-${choice}` });
            button.addEventListener("click", () => pick(change, choice, made));
          });
        }
      }
      return box;
    };

    // --- The rows, a lot at a time --------------------------------------------
    const rows = diffRows(diffed);
    let done = false;
    /** Draws the next rows, and goes on while what is drawn does not fill the room that there is. */
    const more = (): void => {
      while (!done && body.scrollHeight - body.scrollTop - body.clientHeight < NEAR_THE_END) {
        // Into a piece of its own first, and from there into the page in one go
        const lot = createFragment();
        for (let i = 0; i < ROWS_AT_A_TIME; i++) {
          const next = rows.next();
          if (next.done === true) {
            done = true;
            break;
          }
          const row = next.value;
          this.row(row.kind !== "fold" && row.change !== null ? boxOf(row.change, lot) : lot, row, diffed);
        }
        body.appendChild(lot);
        // Not on the screen, as in a test: there is no room to fill
        if (body.clientHeight === 0) {
          break;
        }
      }
    };
    body.addEventListener("scroll", more, { passive: true });

    const foot = contentEl.createDiv({ cls: "piecemeal-git-diff-foot" });
    if (choose !== undefined) {
      tally = foot.createDiv({ cls: "piecemeal-git-note" });
      tell();
    }
    const buttons = foot.createDiv({ cls: "piecemeal-git-buttons" });
    this.actions(buttons);
    if (choose !== undefined) {
      new ButtonComponent(buttons)
        .setButtonText("Save what is chosen")
        .setCta()
        .onClick(async () => {
          await choose.save(chosenText(diffed, choices));
          this.close();
        });
    }
    more();
  }

  /** Draws one row at the end of `parent`, or before `before` if that is given. */
  private row(parent: Node, row: DiffRow, diffed: TextDiff, before: Node | null = null): void {
    const el = createDiv({ cls: `piecemeal-git-diff-row piecemeal-git-diff-${row.kind}` });
    parent.insertBefore(el, before);
    if (row.kind === "fold") {
      el.setText(row.count === 1 ? "1 line that is the same" : `${row.count} lines that are the same`);
      el.addEventListener("click", () => {
        // The first lines of the fold take its place, and what is left of it stays folded after them
        const shown = Math.min(row.count, LINES_OF_A_FOLD);
        const lot = createFragment();
        for (const line of sameRows(diffed.before, row.oldStart, row.newStart, shown)) {
          this.row(lot, line, diffed);
        }
        if (row.count > shown) {
          this.row(lot, { kind: "fold", oldStart: row.oldStart + shown, newStart: row.newStart + shown, count: row.count - shown }, diffed);
        }
        el.replaceWith(lot);
      });
      return;
    }
    if (Platform.isPhone) {
      // No room for two numbers: the one of the text that has the line
      el.createSpan({ cls: "piecemeal-git-diff-no", text: String(row.newLine ?? row.oldLine ?? "") });
    } else {
      el.createSpan({ cls: "piecemeal-git-diff-no", text: row.oldLine === null ? "" : String(row.oldLine) });
      el.createSpan({ cls: "piecemeal-git-diff-no", text: row.newLine === null ? "" : String(row.newLine) });
    }
    el.createSpan({ cls: "piecemeal-git-diff-sign", text: row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " " });
    // Without the end of the line: the row is the line
    el.createSpan({ cls: "piecemeal-git-diff-text", text: row.text.replace(/\r?\n$/, "") });
  }
}
