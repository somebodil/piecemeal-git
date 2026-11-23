import { type App, ButtonComponent, Modal } from "obsidian";

/** Says what is about to be done, with the files that it is done to, and asks if it may. */
export class AskModal extends Modal {
  private readonly what: { title: string; text: string; paths: string[]; yes: string };
  private answer: (go: boolean) => void = () => undefined;
  private answered = false;

  constructor(app: App, what: { title: string; text: string; paths: string[]; yes: string }) {
    super(app);
    this.what = what;
  }

  /** Opens the dialog. True if the person said to go on. */
  ask(): Promise<boolean> {
    return new Promise((resolve) => {
      this.answer = resolve;
      this.open();
    });
  }

  override onOpen(): void {
    const { contentEl, what } = this;
    this.modalEl.addClass("piecemeal-git-modal");
    this.setTitle(what.title);
    contentEl.createEl("p", { text: what.text });
    const list = contentEl.createEl("ul", { cls: "piecemeal-git-plan" });
    for (const path of what.paths.slice(0, 100)) {
      list.createEl("li", { text: path, cls: "piecemeal-git-path" });
    }
    if (what.paths.length > 100) {
      list.createEl("li", { text: `and ${what.paths.length - 100} more` });
    }
    const buttons = contentEl.createDiv({ cls: "piecemeal-git-buttons" });
    new ButtonComponent(buttons).setButtonText("Not now").onClick(() => {
      this.close();
    });
    // The class that marks a button as one that takes something away, in every version of Obsidian that the plugin runs in
    new ButtonComponent(buttons)
      .setButtonText(what.yes)
      .onClick(() => {
        this.answered = true;
        this.answer(true);
        this.close();
      })
      .buttonEl.addClass("mod-warning");
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.answered) {
      this.answer(false);
    }
  }
}
