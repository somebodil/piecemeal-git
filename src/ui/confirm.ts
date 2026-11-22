import { type App, ButtonComponent, Modal } from "obsidian";
import { type Plan } from "../git/sync.ts";
import { files } from "./words.ts";

/** Says what a sync is about to do, and asks if it may. */
export class ConfirmModal extends Modal {
  private readonly plan: Plan;
  private answer: (go: boolean) => void = () => undefined;
  private answered = false;

  constructor(app: App, plan: Plan) {
    super(app);
    this.plan = plan;
  }

  /** Opens the dialog. True if the person said to go on. */
  ask(): Promise<boolean> {
    return new Promise((resolve) => {
      this.answer = resolve;
      this.open();
    });
  }

  override onOpen(): void {
    const { contentEl, plan } = this;
    this.modalEl.addClass("piecemeal-git-modal");
    this.setTitle(plan.first ? "First sync with this repository" : "This sync removes many files");
    if (plan.first) {
      contentEl.createEl("p", {
        text: "This vault and the repository have not been synced before. Nothing is removed on either side: each gets what only the other has.",
      });
    }
    const rows = contentEl.createEl("ul", { cls: "piecemeal-git-plan" });
    const row = (text: string, paths: string[] = []): void => {
      const item = rows.createEl("li", { text });
      if (paths.length > 0) {
        const names = item.createEl("details");
        names.createEl("summary", { text: "Which" });
        const inner = names.createEl("ul");
        for (const path of paths.slice(0, 200)) {
          inner.createEl("li", { text: path });
        }
        if (paths.length > 200) {
          inner.createEl("li", { text: `and ${paths.length - 200} more` });
        }
      }
    };
    /** "1 file comes", "3 files come". */
    const say = (n: number, one: string, many: string): string => `${files(n)} ${n === 1 ? one : many}`;
    if (plan.take > 0) {
      row(`${say(plan.take, "comes", "come")} from the repository into this vault.`);
    }
    if (plan.send > 0) {
      row(`${say(plan.send, "goes", "go")} from this vault to the repository.`);
    }
    if (plan.bothChanged.length > 0) {
      // Without a sync before, there is no text as it was to put two versions together from
      const kept = plan.first
        ? "Your version stays, and the other one is kept beside it as a copy."
        : "Texts are put together where that works out. Otherwise your version stays, and the other one is kept beside it as a copy.";
      row(`${say(plan.bothChanged.length, "differs", "differ")} on the two sides. ${kept}`, plan.bothChanged);
    }
    if (plan.removeHere.length > 0) {
      row(`${say(plan.removeHere.length, "was", "were")} removed from the repository, and will be removed from this vault.`, plan.removeHere);
    }
    if (plan.removeThere.length > 0) {
      row(`${say(plan.removeThere.length, "is", "are")} gone from this vault, and will be removed from the repository.`, plan.removeThere);
    }
    const buttons = contentEl.createDiv({ cls: "piecemeal-git-buttons" });
    new ButtonComponent(buttons).setButtonText("Not now").onClick(() => {
      this.close();
    });
    new ButtonComponent(buttons)
      .setButtonText("Sync")
      .setCta()
      .onClick(() => {
        this.answered = true;
        this.answer(true);
        this.close();
      });
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.answered) {
      this.answer(false);
    }
  }
}
