import { type App, PluginSettingTab, SecretComponent, Setting, type SettingDefinition, type SettingDefinitionItem } from "obsidian";
import { lsRefs, remoteOf } from "../git/protocol.ts";
import type PiecemealGitPlugin from "../main.ts";
import { obsidianHttp } from "../platform/obsidian.ts";
import { type Settings } from "./stored.ts";
import { ago, explain, httpsAddress } from "./words.ts";

/** A row of the settings: what it is called, and which of the settings it holds. */
type Row = { name: string; desc?: string } & (
  | { type: "text"; key: "url" | "branch" | "authorName" | "authorEmail" | "device"; placeholder: string }
  | { type: "secret"; key: "tokenSecret" }
  | { type: "number"; key: "maxFileMB" | "everyMinutes"; min: number }
  | { type: "toggle"; key: "onStart" | "mergeText" }
  /** One of a few: `choices` has what each of them is called, by the word that is kept for it */
  | { type: "choice"; key: "onConflict"; choices: Record<Settings["onConflict"], string> }
  /** A row that holds none of the settings, and is drawn by the tab */
  | { type: "drawn"; key: "state" | "check" }
);

/** The rows in the order and under the headings in which they are shown. */
const GROUPS: { heading?: string; rows: Row[] }[] = [
  { rows: [{ type: "drawn", key: "state", name: "Sync" }] },
  {
    heading: "Repository",
    rows: [
      {
        type: "text",
        key: "url",
        name: "Address",
        desc: "The address that git clones over HTTPS. If the host wants the name of your account with the token, put it before the host: https://name@host/you/vault.git",
        placeholder: "https://github.com/you/vault.git",
      },
      {
        type: "secret",
        key: "tokenSecret",
        name: "Token",
        desc: "A token that may read and write the contents of this one repository. It is kept in the secret storage of Obsidian, not in the vault.",
      },
      { type: "text", key: "branch", name: "Branch", desc: "Leave empty for the branch that the repository opens with. A branch that the repository does not have is made.", placeholder: "main" },
      { type: "drawn", key: "check", name: "Connection", desc: "Asks the server for its branches, with the address and the token above. Nothing is changed." },
    ],
  },
  {
    heading: "When to sync",
    rows: [
      {
        type: "number",
        key: "everyMinutes",
        name: "Sync every",
        desc: "In minutes. 0 to sync only when you ask for it. A sync that starts by itself tells you only when it took something, when something asks for your attention, or when it failed.",
        min: 0,
      },
      { type: "toggle", key: "onStart", name: "Sync when Obsidian starts" },
    ],
  },
  {
    heading: "What is synced",
    rows: [
      {
        type: "toggle",
        key: "mergeText",
        name: "Put texts together",
        desc: "When this device and another one changed different lines of the same text, both changes are kept in it, as git does. Turned off, or when both changed the same lines, one of the two versions takes the name, as the next setting says.",
      },
      {
        type: "choice",
        key: "onConflict",
        name: "When both sides changed a file",
        desc: "For a file that this device and another one both changed, and that was not put together. Always keep both: the version of the repository takes the name, and yours is kept beside it as a copy. Keep mine if it is later: the same, but for one case. If yours was changed later than the one of the repository, yours keeps the name and is sent, and no copy is made. The version of the repository is then in the history of the repository only. Which one is later goes by the time at which the file was last written on this device, and by the time at which the other device synced its change. That is not when the file was edited there. So the wrong one can be taken for the later one where a device synced long after a change, where a program wrote a file again, and where a clock is wrong. Both are always kept for the settings of Obsidian and its plugins, for a file that both sides made anew, and where a time is not known or is ahead of the present.",
        choices: { later: "Keep mine if it is later", both: "Always keep both" },
      },
      {
        type: "number",
        key: "maxFileMB",
        name: "Largest file to send",
        desc: "In megabytes. A new file above this is not sent. It is written into .gitignore, and you are told. A file of the repository that was left out for its size comes once this lets it in.",
        min: 1,
      },
    ],
  },
  {
    heading: "Commits of this device",
    rows: [
      { type: "text", key: "authorName", name: "Name", desc: "Who the commits of this device are by.", placeholder: "Your name" },
      { type: "text", key: "authorEmail", name: "Email", placeholder: "you@example.com" },
      { type: "text", key: "device", name: "Name of this device", desc: "The message of a commit says where it is from.", placeholder: "My phone" },
    ],
  },
];

const ROWS = GROUPS.flatMap((group) => group.rows);

export class SettingsTab extends PluginSettingTab {
  private readonly plugin: PiecemealGitPlugin;

  constructor(app: App, plugin: PiecemealGitPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Draws a row that holds none of the settings. */
  private draw(row: Row & { type: "drawn" }, setting: Setting): void {
    const { plugin } = this;
    setting.setName(row.name);
    if (row.key === "state") {
      const { last } = plugin;
      const said = (): string => {
        if (plugin.config.url === "") {
          return "Give the address of a repository below, and a token if it is not open to everyone. Try it on a copy of a vault first.";
        }
        if (plugin.last === null) {
          return "Not synced yet.";
        }
        return plugin.last.ok ? `Synced ${ago(plugin.last.at)}. ${plugin.last.text}` : `The last sync failed, ${ago(plugin.last.at)}. ${plugin.last.text}`;
      };
      setting.setDesc(said());
      setting.addButton((button) =>
        button
          .setButtonText("What it did")
          .setDisabled(last === null)
          .onClick(() => {
            plugin.openReport();
          }),
      );
      setting.addButton((button) =>
        button
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true).setButtonText("Syncing…");
            await plugin.sync();
            button.setDisabled(false).setButtonText("Sync now");
            setting.setDesc(said());
          }),
      );
      return;
    }
    setting.setDesc(row.desc ?? "");
    setting.addButton((button) =>
      button.setButtonText("Check").onClick(async () => {
        const { url, tokenSecret } = plugin.config;
        if (url === "") {
          setting.setDesc("Give the address of the repository first.");
          return;
        }
        button.setDisabled(true);
        setting.setDesc("Asking the server…");
        try {
          const token = (tokenSecret === "" ? null : this.app.secretStorage.getSecret(tokenSecret)) ?? undefined;
          const refs = await lsRefs(obsidianHttp, remoteOf(url, token));
          const names = [...refs.heads.keys()].map((name) => name.slice("refs/heads/".length));
          const opens = refs.head?.slice("refs/heads/".length);
          setting.setDesc(
            names.length === 0
              ? "It works. The repository is empty: the first sync sends this vault to it."
              : `It works. ${names.length === 1 ? "Branch" : "Branches"}: ${names.slice(0, 12).join(", ")}${names.length > 12 ? " and more" : ""}.${opens !== undefined && names.length > 1 ? ` It opens with ${opens}.` : ""}`,
          );
        } catch (error) {
          setting.setDesc(explain(error));
        }
        button.setDisabled(false);
      }),
    );
  }

  private definition(row: Row): SettingDefinition {
    const { name, desc } = row;
    switch (row.type) {
      case "text":
        return { name, desc, control: { type: "text", key: row.key, placeholder: row.placeholder } };
      case "secret":
        return { name, desc, control: { type: "secret", key: row.key } };
      case "number":
        return { name, desc, control: { type: "number", key: row.key, min: row.min } };
      case "toggle":
        return { name, desc, control: { type: "toggle", key: row.key } };
      case "choice":
        return { name, desc, control: { type: "dropdown", key: row.key, options: row.choices } };
      case "drawn":
        return {
          name,
          desc,
          render: (setting) => {
            this.draw(row, setting);
          },
        };
    }
  }

  /**
   * What Obsidian 1.13 and later makes the rows from. Rows that are told this
   * way are found by the search of the settings.
   */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    return GROUPS.map((group) => ({ type: "group", heading: group.heading, items: group.rows.map((row) => this.definition(row)) }));
  }

  override getControlValue(key: string): unknown {
    return this.plugin.config[key as keyof Settings];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const row = ROWS.find((other) => other.key === key);
    if (row === undefined || row.type === "drawn") {
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
    } else if (row.type === "choice") {
      if (typeof value !== "string" || !Object.hasOwn(row.choices, value)) {
        return;
      }
      settings[row.key] = value as Settings[typeof row.key];
    } else if (row.key === "url") {
      // The address that a host shows for SSH is taken for the one over HTTPS
      settings.url = typeof value === "string" ? httpsAddress(value) : "";
    } else {
      settings[row.key] = typeof value === "string" ? value.trim() : "";
    }
    this.plugin.saveSettings();
    if (row.key === "everyMinutes") {
      this.plugin.schedule();
    }
  }

  /** The same rows for Obsidian before 1.13, which has to be given each of them. */
  override display(): void {
    const { containerEl } = this;
    const settings = this.plugin.config;
    containerEl.empty();
    for (const group of GROUPS) {
      if (group.heading !== undefined) {
        new Setting(containerEl).setName(group.heading).setHeading();
      }
      for (const row of group.rows) {
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
          case "choice":
            setting.addDropdown((dropdown) => dropdown.addOptions(row.choices).setValue(settings[row.key]).onChange(change));
            break;
          case "drawn":
            this.draw(row, setting);
            break;
        }
      }
    }
  }
}
