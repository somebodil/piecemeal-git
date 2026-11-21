# Piecemeal Git

Working title. An [Obsidian](https://obsidian.md) plugin that syncs a vault with a git repository, built to work on a phone.

It speaks the git protocol itself and needs no git program. What sets it apart is that it never holds more than a few megabytes at a time:

- It first asks for the commits and the folders only, and then for the contents of the files in small batches.
- It keeps no second copy of the files. The vault is the copy.
- A file that is too large to send from the device is not sent. The plugin writes it into `.gitignore` and tells you.

## State

The sync works from a terminal against GitHub and against the git server that comes with git. It has not run inside Obsidian on a phone yet. That is the next thing to try.

What has been checked, and how:

- The tests sync a folder with `git http-backend`, and then ask git about the result: `git fsck`, a clone that plays the computer, the sizes of the responses.
- A real vault with a file far above the largest size of the settings came from a private repository on GitHub. No response was above 7.6 MB, and every file had the id that git gives it.

## How it syncs

The device keeps no commits of its own. A sync compares three things for each path: what both sides last agreed on, what the vault holds, and what the remote holds.

- What changed on one side goes to the other.
- A file that both sides changed stays as it is here. The version of the remote is kept beside it, as `name (conflict 2026-11-22 0915).md`.
- A change wins over a removal.
- What the device changed becomes commits on top of the remote, each with about 4 MB of content. The history of the branch stays a line.

Files that are too large:

- A new file above the limit (20 MB unless you change it) is not sent. Its path is written into a part of `.gitignore` that the plugin keeps, between two marker lines, and you are told. The file stays in the vault.
- A file of the repository above the limit is asked for in ranges of bytes and written piece by piece. This works on GitHub. On another host it is left out of the vault, and stays in the repository.
- A tracked file that grows above the limit on the device is not sent. The repository keeps its version, and every sync says so.

The plugin keeps what it knows in the folder `.piecemeal` of the vault: commits, folders, and one file that says what was agreed on. Neither that folder, nor a `.git` folder, nor the settings of the plugin are ever synced.

## Trying it

From a terminal, into any folder:

```bash
TOKEN=... node src/testing/try.ts https://github.com/you/vault.git /some/folder --read-only
```

`--read-only` stops the sync before it would send anything. Without it, what the folder holds and the repository does not is sent.

In Obsidian: build, then copy `main.js` and `manifest.json` to `.obsidian/plugins/piecemeal-git/` of a vault, turn the plugin on, and give it the address of the repository and a token. The token needs to read and write the contents of that one repository. Then run the command "Sync with the repository".

Try it on a copy of a vault first.

## Not done yet

- It has not run on a phone.
- Only the `.gitignore` at the top of the vault is read.
- Links and repositories inside the repository are left alone: they stay in the repository and are not made in the vault.
- A folder that becomes empty stays in the vault.
- A path that is a file on one side and a folder on the other is not handled.
- A file that is changed twice within the resolution of the clock of the device, to the same size, is not seen as changed.
- A file that came in pieces is checked by its size only, not by its id.
- On a host other than GitHub the sizes of files are not known before they come, so a batch can be larger than meant.
- There is no sync on a timer. You run the command.

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
