import { type App, ButtonComponent, Modal } from "obsidian";
import { diffCounts, type DiffRow, diffRows, diffText, sameRows, type TextDiff } from "../git/merge.ts";
import { explain } from "./words.ts";

/** Two versions of a file to compare, and what to say about them. */
export interface Comparison {
  /** The path of the file, which is what the dialog is called */
  title: string;
  /** What the two are, in a sentence: it stands above the comparison */
  what: string;
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
 * The rows are drawn as they come into sight, so that a long comparison is
 * on the screen at once and costs what is looked at of it.
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
      this.actions();
    }
  }

  /** The buttons for what can be done about the two versions. */
  private actions(): void {
    const actions = this.comparison.actions ?? [];
    if (actions.length === 0) {
      return;
    }
    const row = this.contentEl.createDiv({ cls: "piecemeal-git-buttons" });
    for (const action of actions) {
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
    this.draw(diffed, what);
  }

  private draw(diffed: TextDiff, what: string): void {
    const { contentEl } = this;
    contentEl.empty();
    const { added, removed } = diffCounts(diffed);
    const head = contentEl.createDiv({ cls: "piecemeal-git-diff-head" });
    head.createSpan({ text: `${what} ` });
    head.createSpan({ text: `+${added}`, cls: "piecemeal-git-diff-plus" });
    head.createSpan({ text: " " });
    head.createSpan({ text: `−${removed}`, cls: "piecemeal-git-diff-minus" });
    if (diffed.coarse) {
      contentEl.createEl("p", {
        text: "The two are too far apart to be compared line by line. All that lies between what they start and end with alike is shown as one change.",
        cls: "piecemeal-git-note",
      });
    }
    const body = contentEl.createDiv({ cls: "piecemeal-git-diff" });
    const rows = diffRows(diffed);
    let done = false;
    /** Draws the next rows, and goes on while what is drawn does not fill the room that there is. */
    const more = (): void => {
      while (!done && body.scrollHeight - body.scrollTop - body.clientHeight < NEAR_THE_END) {
        for (let i = 0; i < ROWS_AT_A_TIME; i++) {
          const next = rows.next();
          if (next.done === true) {
            done = true;
            break;
          }
          this.row(body, next.value, diffed);
        }
        // Not on the screen, as in a test: there is no room to fill
        if (body.clientHeight === 0) {
          break;
        }
      }
    };
    body.addEventListener("scroll", more, { passive: true });
    this.actions();
    more();
  }

  /** Draws one row at the end of `parent`, or before `before` if that is given. */
  private row(parent: HTMLElement, row: DiffRow, diffed: TextDiff, before: Element | null = null): void {
    const el = createDiv({ cls: `piecemeal-git-diff-row piecemeal-git-diff-${row.kind}` });
    parent.insertBefore(el, before);
    if (row.kind === "fold") {
      el.setText(row.count === 1 ? "1 line that is the same" : `${row.count} lines that are the same`);
      el.addEventListener("click", () => {
        // The first lines of the fold take its place, and what is left of it stays folded after them
        const shown = Math.min(row.count, LINES_OF_A_FOLD);
        for (const line of sameRows(diffed.before, row.oldStart, row.newStart, shown)) {
          this.row(parent, line, diffed, el);
        }
        if (row.count > shown) {
          this.row(parent, { kind: "fold", oldStart: row.oldStart + shown, newStart: row.newStart + shown, count: row.count - shown }, diffed, el);
        }
        el.remove();
      });
      return;
    }
    el.createSpan({ cls: "piecemeal-git-diff-no", text: row.oldLine === null ? "" : String(row.oldLine) });
    el.createSpan({ cls: "piecemeal-git-diff-no", text: row.newLine === null ? "" : String(row.newLine) });
    el.createSpan({ cls: "piecemeal-git-diff-sign", text: row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " " });
    // Without the end of the line: the row is the line
    el.createSpan({ cls: "piecemeal-git-diff-text", text: row.text.replace(/\r?\n$/, "") });
  }
}
