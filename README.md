# Piecemeal Git

Working title. An [Obsidian](https://obsidian.md) plugin that syncs a vault with a git repository, built to work on a phone.

It speaks the git protocol itself and needs no git program. What sets it apart is that it never holds more than a few megabytes at a time:

- It first asks for the commits and the folders only, and then for the contents of the files in small batches.
- It keeps no second copy of the files. The vault is the copy.
- A file that is too large to send from the device is not sent. The plugin writes it into `.gitignore` and tells you.

## State

The sync works from a terminal, inside the desktop app of Obsidian, and inside the mobile app on an emulated Android phone and tablet. It has not run on a device that one holds in a hand, and not on an iPhone or iPad.

What has been checked, and how:

- The tests sync a folder with `git http-backend`, and then ask git about the result: `git fsck`, a clone that plays the computer, the sizes of the responses.
- What puts two texts together is held against `git merge-file` on texts that are made and changed at random. In 8000 of them it never gave another text than git. In one it put together what git left to a person: both sides had given the last line its missing end.
- A real vault with a file far above the largest size of the settings came from a private repository on GitHub. No response was above 7.6 MB, and every file had the id that git gives it.
- Inside the desktop app of Obsidian 1.12.7, the plugin synced a vault with the git server that comes with git, both ways: a first sync into an empty repository, changes of both sides, a file that both changed, removals, a file too large to send, a name that is a file on one side and a folder on the other, and a sync that started by itself. A clone made by git had the same files each time, and `git fsck` had nothing to say.
- Also inside Obsidian, a public and a private repository on GitHub came into a folder without anything being sent, and in both one file came in ranges of bytes. Every file was as the repository has it.
- Inside the mobile app of Obsidian 1.15.1, on an emulated phone and an emulated tablet with Android 17, the plugin synced a vault with the git server that comes with git: a first sync, changes of both sides, a file that both changed, removals, binary files of several megabytes each way, a name that is a file on one side and a folder on the other, a sync when the app starts, and a sync without a network. After every step a clone made by git had the same files as the device, and `git fsck` had nothing to say.
- On the emulated phone again, with what came later. A text that both sides changed was put together. One that both changed in the same lines got its copy, and so did an image. A server that asks for a name and a password turned the plugin away without them and with a wrong password, and let it in with the right one, kept in the secret storage of Obsidian. A sync that the timer started took a change of the computer. A server that tells sizes was asked for them, and a file of 3 MB stayed out under a limit of 1 MB. A link came as a file that holds where it points, and went back as a link after another place was written into it. From GitHub, a public repository of 324 files came in 5.5 seconds, each as a clone made by git has it. A private repository on GitHub, with a token, was not tried there.
- That run showed that the app on Android loses a write now and then: it says that a file is written, and the file is there and empty. In 45 syncs this happened to 3 files. Since then every write is looked at afterwards, as told below.
- On a Mac, from a terminal, through a file system that keeps names as an iPhone does: a vault of some hundred files, many of them with Korean names, came from the git server that comes with git. Every file had the id that git gives it, and a second sync sent nothing. Then both sides changed, added, removed and renamed files, and both changed one. A clone made by git had the same files, `git fsck` had nothing to say, and no name had reached the repository with its letters apart. How an iPhone keeps names was found by asking the file functions of Apple on the Mac, not on an iPhone.

## How it syncs

The device keeps no commits of its own. A sync compares three things for each path: what both sides last agreed on, what the vault holds, and what the remote holds.

- What changed on one side goes to the other.
- A text that both sides changed in different places gets both changes, line by line, as `git merge-file` does. The device does not keep the text as it was, so it asks the remote for it.
- Any other file that both sides changed stays as it is here: one that is not a text, a text in which both changed the same lines or lines next to each other, and every file if you turn this off in the settings. The version of the remote is kept beside it, as `name (conflict 2026-11-22 0915).md`.
- A change wins over a removal.
- A name that is a file on one side and a folder on the other is kept on both: what is here keeps the name, and what the remote has goes beside it, as `name (conflict 2026-11-22 0915)`.
- What the device changed becomes commits on top of the remote, each with about 4 MB of content. The history of the branch stays a line.
- If another device sends something while a sync runs, the remote refuses what this one sends. The sync then looks at the remote again and goes on from there, up to three times.
- A folder that loses its last file to a sync is removed. One that still holds something, such as a file that is not synced, stays.
- A file that was changed in the three seconds before a sync is read again by the next one. Its size and time alone would not tell a second change in the same moment.
- The `.gitignore` of the vault and the `.gitignore` files of its folders say what is left out, read as git reads them. A file that the repository tracks stays tracked.
- A phone and most computers take `Note.md` and `note.md` for the same file, and git does not. A file of the repository whose path differs only in capital letters from one that the vault holds is left out of the vault, and you are told. It stays in the repository as it is. A name that changes only its capital letters, on either side, is a change of name like any other.
- An iPhone, an iPad and a Mac keep a name like `한글.md` or `é.md` with each letter taken apart into its parts, whatever the name was written as, and git keeps a name as it is given. On those devices a file of the vault has the name that the repository has for it, and a new file is sent with the letters of its name in one piece, as git does on a Mac. So a name does not change in the repository by going through such a device.
- Every file that a sync writes is looked at afterwards, and written again if it does not have the size it should have. A file that cannot be written at all is taken out again and asked for by the next sync, so that a file that is cut off is never taken for a change of yours. A commit or a folder that the plugin kept and cannot read any more is asked for again.
- A link of the repository is a file in the vault that holds where the link points. This is how git keeps a link where links cannot be made, as on a phone. It stays a link in the repository, also when you write another place into it. From a terminal the sync makes real links, and sends a link as a link, without going into a folder that it points to.
- A file that was left out of the vault is looked at again by every sync, and comes when what kept it out is gone: the other file of its name was removed or renamed, or the limit was raised above its size. As long as it stays out, a sync asks the repository nothing about it and tells you nothing more.

Branches:

- The sync is with one branch: the one that the settings name, or else the one of the last sync, or else the one that the repository opens with.
- When you name another branch that the remote has, the vault goes over to it: it takes what that branch has otherwise, and what you had not sent yet goes onto that branch.
- When you name a branch that the remote does not have, the branch is made where the last sync left off, with the history up to there, as `git switch -c` and a push would.
- When the branch of the last sync got another name on the remote and the settings name none, the sync goes on with the branch that the repository opens with now.
- When the branch is gone from the remote, the vault stays as it is and is sent anew, as a branch without a history. Nothing is removed from the vault because of it.

Files that are too large:

- A new file above the limit (20 MB unless you change it) is not sent. Its path is written into a part of `.gitignore` that the plugin keeps, between two marker lines, and you are told. The file stays in the vault.
- A file of the repository above the limit is asked for in ranges of bytes and written piece by piece. The pieces are added up to the id that git gives the file, and a file with another id is not put into the vault. This works on GitHub, which has a way of its own to tell sizes and to give a part of a file.
- Another server is asked for the sizes as git asks for them (`object-info`). Where it answers, batches are made up by the real sizes, and a file above the limit is left out of the vault, and you are told. It cannot come in pieces there. The server that comes with git answers once `transfer.advertiseObjectInfo` is set.
- A server that does not answer does not tell how large a file is before it sends it, so there a file comes in one piece, however large it is. The size of a file is then guessed from the files of the same kind that came before it, by the ending of its name, and a batch is made up by these guesses. The first file of a kind that is rarely text is asked for by itself.
- A tracked file that grows above the limit on the device is not sent. The repository keeps its version, and every sync says so.

The plugin keeps what it knows in the folder `.piecemeal` of the vault: commits, folders, and one file that says what was agreed on. Neither that folder, nor a `.git` folder, nor the settings of the plugin, nor the trash of Obsidian are ever synced. What the repository has under those names stays there and is not taken.

## Trying it

From a terminal, into any folder:

```bash
TOKEN=... node src/testing/try.ts https://github.com/you/vault.git /some/folder --read-only
```

`--read-only` stops the sync before it would send anything. Without it, what the folder holds and the repository does not is sent.

For a phone to sync with a repository on your computer, with no host and no token in between, `node src/testing/serve.ts <folder> [port]` serves the repositories of a folder to the devices of your network. The top of that file says how to make a repository there.

In Obsidian: build, then copy `main.js` and `manifest.json` to `.obsidian/plugins/piecemeal-git/` of a vault, turn the plugin on, and give it the address of the repository and a token. The token needs to read and write the contents of that one repository. Then run the command "Sync with the repository".

The token goes to the server as git sends it, as a password. GitHub and GitLab take it under any name. A host that wants the name of your account with it gets the name from the address: `https://name@host/you/vault.git`.

A sync can also start by itself: every so many minutes, and when Obsidian has opened the vault. Both are in the settings and are off at first. Such a sync says nothing while it runs. Afterwards it tells you only that it took something, that something asks for your attention, or that it failed, and a failure is said once and not every few minutes.

The files that Obsidian keeps for one device, `workspace.json` and `workspace-mobile.json` in its settings folder, change whenever you open a note. Put them into `.gitignore`, or every sync sends them.

Try it on a copy of a vault first.

## Not done yet

- It has not run on a real phone or tablet, and not on iOS. Inside Obsidian on a Mac it has not run either.
- A device that keeps the letters of a name apart cannot hold two files whose names differ in this only. The second one is left out of the vault, like one that differs in capital letters only.
- Inside Obsidian on a computer a link is not made as a link either, though it could be there. A link that you make in such a vault yourself is followed: what it points to is sent as files of the vault.
- A repository inside the repository is left alone, as git leaves it unless it is told otherwise: it stays in the repository and is not made in the vault.
- A file above the limit that is changed twice in the same moment, to the same size, is not seen as changed. It is too large to read again.
- GitLab and Codeberg do not answer when git asks for sizes, and have no way that the plugin knows to give a part of a file. So there a batch can be larger than meant, and a file above the limit comes whole.

## Development

You need [Node.js](https://nodejs.org) 24 or later, and git.

```bash
npm install
npm run check   # type check, lint, and tests
npm run build   # type check, then the main.js of a release
```

- `src/git` holds the git protocol, the objects, and the sync. It knows nothing about Obsidian, so its tests run with plain Node.js against a git server on the same machine.
- `src/platform` holds what differs between Obsidian and Node.js: files and HTTP.
- `src/testing` holds the git server of the tests, the script that syncs from a terminal, and file systems that play a phone: one that does not tell capital letters from small ones, one that takes the letters of a name apart, and one that loses a write now and then.
- `src/main.ts` is the plugin: the settings, the command, and what it tells you after a sync.

## License

[MIT](LICENSE)
