# Piecemeal Git

Working title. An [Obsidian](https://obsidian.md) plugin that syncs a vault with a git repository, built to work on a phone.

It speaks the git protocol itself and needs no git program. What sets it apart is that it never holds more than a few megabytes at a time:

- It first asks for the commits and the folders only, and then for the contents of the files in small batches.
- It keeps no second copy of the files. The vault is the copy.
- A file that is too large to send from the device is not sent. The plugin writes it into `.gitignore` and tells you.

## State

The sync works from a terminal and inside the desktop app of Obsidian, against GitHub and against the git server that comes with git. It has not run on a phone yet. That is the next thing to try.

What has been checked, and how:

- The tests sync a folder with `git http-backend`, and then ask git about the result: `git fsck`, a clone that plays the computer, the sizes of the responses.
- A real vault with a file far above the largest size of the settings came from a private repository on GitHub. No response was above 7.6 MB, and every file had the id that git gives it.
- Inside the desktop app of Obsidian 1.12.7, the plugin synced a vault with the git server that comes with git, both ways: a first sync into an empty repository, changes of both sides, a file that both changed, removals, a file too large to send, a name that is a file on one side and a folder on the other, and a sync that started by itself. A clone made by git had the same files each time, and `git fsck` had nothing to say.
- Also inside Obsidian, a public and a private repository on GitHub came into a folder without anything being sent, and in both one file came in ranges of bytes. Every file was as the repository has it.
- With the mobile emulation of the desktop app, a sync ran and the settings showed. The emulation has the files and the requests of the desktop app, so this says nothing about a phone.

## How it syncs

The device keeps no commits of its own. A sync compares three things for each path: what both sides last agreed on, what the vault holds, and what the remote holds.

- What changed on one side goes to the other.
- A file that both sides changed stays as it is here. The version of the remote is kept beside it, as `name (conflict 2026-11-22 0915).md`.
- A change wins over a removal.
- A name that is a file on one side and a folder on the other is kept on both: what is here keeps the name, and what the remote has goes beside it, as `name (conflict 2026-11-22 0915)`.
- What the device changed becomes commits on top of the remote, each with about 4 MB of content. The history of the branch stays a line.
- A folder that loses its last file to a sync is removed. One that still holds something, such as a file that is not synced, stays.
- A file that was changed in the three seconds before a sync is read again by the next one. Its size and time alone would not tell a second change in the same moment.
- The `.gitignore` of the vault and the `.gitignore` files of its folders say what is left out, read as git reads them. A file that the repository tracks stays tracked.

Files that are too large:

- A new file above the limit (20 MB unless you change it) is not sent. Its path is written into a part of `.gitignore` that the plugin keeps, between two marker lines, and you are told. The file stays in the vault.
- A file of the repository above the limit is asked for in ranges of bytes and written piece by piece. The pieces are added up to the id that git gives the file, and a file with another id is not put into the vault. This works on GitHub. On another host the file is left out of the vault, and stays in the repository.
- A tracked file that grows above the limit on the device is not sent. The repository keeps its version, and every sync says so.

The plugin keeps what it knows in the folder `.piecemeal` of the vault: commits, folders, and one file that says what was agreed on. Neither that folder, nor a `.git` folder, nor the settings of the plugin, nor the trash of Obsidian are ever synced. What the repository has under those names stays there and is not taken.

## Trying it

From a terminal, into any folder:

```bash
TOKEN=... node src/testing/try.ts https://github.com/you/vault.git /some/folder --read-only
```

`--read-only` stops the sync before it would send anything. Without it, what the folder holds and the repository does not is sent.

In Obsidian: build, then copy `main.js` and `manifest.json` to `.obsidian/plugins/piecemeal-git/` of a vault, turn the plugin on, and give it the address of the repository and a token. The token needs to read and write the contents of that one repository. Then run the command "Sync with the repository".

A sync can also start by itself: every so many minutes, and when Obsidian has opened the vault. Both are in the settings and are off at first. Such a sync says nothing while it runs. Afterwards it tells you only that it took something, that something asks for your attention, or that it failed, and a failure is said once and not every few minutes.

The files that Obsidian keeps for one device, `workspace.json` and `workspace-mobile.json` in its settings folder, change whenever you open a note. Put them into `.gitignore`, or every sync sends them.

Try it on a copy of a vault first.

## Not done yet

- It has not run on a phone.
- Links and repositories inside the repository are left alone: they stay in the repository and are not made in the vault.
- A file above the limit that is changed twice in the same moment, to the same size, is not seen as changed. It is too large to read again.
- On a host other than GitHub the sizes of files are not known before they come, so a batch can be larger than meant.
- The settings do not come up in the search of the settings of Obsidian 1.13 and later. That takes the newer way to declare settings, which the Obsidian that the plugin was tried in does not have.

## Development

You need [Node.js](https://nodejs.org) 24 or later, and git.

```bash
npm install
npm run check   # type check, lint, and tests
npm run build   # type check, then the main.js of a release
```

- `src/git` holds the git protocol, the objects, and the sync. It knows nothing about Obsidian, so its tests run with plain Node.js against a git server on the same machine.
- `src/platform` holds what differs between Obsidian and Node.js: files and HTTP.
- `src/testing` holds the git server of the tests and the script that syncs from a terminal.
- `src/main.ts` is the plugin: the settings, the command, and what it tells you after a sync.

## License

[MIT](LICENSE)
