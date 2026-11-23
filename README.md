# piecemeal-git

An [Obsidian](https://obsidian.md) plugin that syncs a vault with a git repository, built to work on a phone.

It speaks the git protocol itself and needs no git program. What sets it apart is that it never holds more than a few megabytes at a time:

- It first asks for the commits and the folders only, and then for the contents of the files in small batches.
- It keeps no second copy of the files. The vault is the copy.
- A file that is too large to send from the device is not sent. The plugin writes it into `.gitignore` and tells you.

## Installing

In Obsidian, open the settings, go to "Community plugins", look for "piecemeal-git", install it and turn it on. Then give it the address of a repository and a token, as told under "Trying it" below.

Try it on a copy of a vault first. It has run on an emulated phone, and on a device that a person holds in a hand only once: the first sync of a tablet.

## What it sends, and where

- It needs a repository on a git host that it can reach over HTTPS, such as GitHub. With most hosts that means an account there, and a token of it. The plugin itself wants no account and no payment.
- It talks to the server of the repository that you name, and to nothing else, with one exception.
- For a repository on github.com it also asks `api.github.com` for the sizes of the files and for the parts of files that are too large for one answer. It sends the token there too, since a private repository answers to nothing else.
- The token is kept in the secret storage of Obsidian. It is not written into the vault and not into the settings of the plugin.
- The settings, and how the last sync went, are kept on the device, in the storage that Obsidian gives a vault there. None of it is in a file of the vault. So nothing that syncs the vault takes the settings of one device to another, and no write that goes wrong loses them. They are gone when the data of the app is cleared or Obsidian is installed anew, as the token is: then the address and the token are given again. The app writes this storage a moment after a change, so a setting that was changed in the second before the app is stopped by force is as it was before.
- Up to 0.1.4 they were in the file `data.json` of the plugin, which a sync wrote every time. A device that still has that file takes its settings from there once, and removes the file.
- It counts nothing and reports nothing to anyone.

## State

The sync works from a terminal, inside the desktop app of Obsidian, and inside the mobile app on an emulated Android phone and tablet. On a device that one holds in a hand it has run once, on an Android tablet, and not on an iPhone or iPad.

What has been checked, and how:

- The tests sync a folder with `git http-backend`, and then ask git about the result: `git fsck`, a clone that plays the computer, the sizes of the responses.
- What puts two texts together is held against `git merge-file` on texts that are made and changed at random. In 8000 of them it never gave another text than git. In one it put together what git left to a person: both sides had given the last line its missing end.
- A real vault with a file far above the largest size of the settings came from a private repository on GitHub. No response was above 7.6 MB, and every file had the id that git gives it.
- Inside the desktop app of Obsidian 1.12.7, the plugin synced a vault with the git server that comes with git, both ways: a first sync into an empty repository, changes of both sides, a file that both changed, removals, a file too large to send, a name that is a file on one side and a folder on the other, and a sync that started by itself. A clone made by git had the same files each time, and `git fsck` had nothing to say.
- Also inside Obsidian, a public and a private repository on GitHub came into a folder without anything being sent, and in both one file came in ranges of bytes. Every file was as the repository has it.
- Inside the mobile app of Obsidian 1.15.1, on an emulated phone and an emulated tablet with Android 17, the plugin synced a vault with the git server that comes with git: a first sync, changes of both sides, a file that both changed, removals, binary files of several megabytes each way, a name that is a file on one side and a folder on the other, a sync when the app starts, and a sync without a network. After every step a clone made by git had the same files as the device, and `git fsck` had nothing to say.
- On the emulated phone again, with what came later. A text that both sides changed was put together. One that both changed in the same lines got its copy, and so did an image. A server that asks for a name and a password turned the plugin away without them and with a wrong password, and let it in with the right one, kept in the secret storage of Obsidian. A sync that the timer started took a change of the computer. A server that tells sizes was asked for them, and a file of 3 MB stayed out under a limit of 1 MB. A link came as a file that holds where it points, and went back as a link after another place was written into it. From GitHub, a public repository of 324 files came in 5.5 seconds, each as a clone made by git has it. A folder that got another name on the phone went to the remote in one small request, and a branch that the remote did not have was made from the one before, with a note that the other branch then did not get. A private repository on GitHub, with a token, was not tried there.
- That run showed that the app on Android loses a write now and then: it says that a file is written, and the file is there and empty. In 45 syncs this happened to 3 files. Since then every write is looked at afterwards, as told below.
- On an Android tablet that a person holds in a hand, a real vault came from a private repository on GitHub in a first sync, with a token, and one file of it in ranges of bytes. Every file had the id that git gives it. That sync also showed what a first sync did wrong then: the settings that Obsidian had made for the new vault stayed and went to the repository, and so did a file that the `.gitignore` of the repository leaves out. Since then the repository is right at a first sync, as told below.
- On the emulated tablet again, with what came after the sync of the real one: a new vault, with the settings that Obsidian 1.15.1 makes for it, met a repository that holds settings and notes. The dialog named the files that give way. Afterwards the settings were those of the repository, there was no copy, what the `.gitignore` of the repository leaves out was not sent, and a note that gave way was in the trash of Obsidian. The notice stayed and told to open Obsidian again. Later a note that both sides changed in the same line had the version of the repository, with the one of the tablet beside it and in the repository, and both buttons of the list did what they say. A list of plugins that came without this plugin got it back, and the next sync sent it.
- On the emulated tablet once more, and the panel on the emulated phone too, with what asks the vault a few things at once: forty rounds in which a computer and the tablet each changed, made, removed and renamed files and folders, changed the same lines and other lines of a note, and added binary files of several megabytes. After every round a clone made by git had the same files as the tablet, and `git fsck` had nothing to say. A write had to be done again as often as before. In a vault of some seven hundred files in a good hundred folders, with the git server on the same machine, a sync that found nothing to do took a quarter of a second, where it took 0.37 seconds before. One that sent a note took 0.38 seconds, where it took 0.83, and so did the sync after it. The first sync took its thirteen seconds as before: files are written one after the other.
- On the emulated tablet, with the settings kept on the device: Obsidian was stopped and started again, and the settings, the token, how the last sync went and the place of the panel were as before. No file was written for them in forty syncs. A device with the file of before took its settings from it and removed it, and with a file that was cut off the plugin started as it comes and left the file alone.
- A vault that held a `.git` folder inside one of its folders, as a repository inside the vault leaves it, sent that folder with its files, and GitHub turned the commit away with one word. From a terminal, against a git server that checks what it gets, a copy of that vault showed why: no server takes a commit with that name in it. Such a folder is left out now wherever it is. On the emulated tablet, with a server that checks what it gets, a vault with such folders synced, and none of their files went. A server that turned a push away by a rule of its own had what it said shown in the notice, after three tries in five seconds.
- On a Mac, from a terminal, through a file system that keeps names as an iPhone does: a vault of some hundred files, many of them with Korean names, came from the git server that comes with git. Every file had the id that git gives it, and a second sync sent nothing. Then both sides changed, added, removed and renamed files, and both changed one. A clone made by git had the same files, `git fsck` had nothing to say, and no name had reached the repository with its letters apart. How an iPhone keeps names was found by asking the file functions of Apple on the Mac, not on an iPhone.

## How it syncs

The device keeps no commits of its own. A sync compares three things for each path: what both sides last agreed on, what the vault holds, and what the remote holds.

- What changed on one side goes to the other.
- A text that both sides changed in different places gets both changes, line by line, as `git merge-file` does. The device does not keep the text as it was, so it asks the remote for it.
- For any other file that both sides changed, the repository is right: its version takes the name. Yours is kept beside it, as `name (conflict 2026-11-22 0915).md`, and goes to the repository as well. This is so for a file that is not a text, for a text in which both changed the same lines or lines next to each other, and for every file if you turn the putting together off in the settings.
- At the first sync of a vault with a repository, nothing has been agreed on yet. Each side gets what only the other has, and a file that both have is as the repository has it afterwards, with no copy. A note of yours that gives way goes where Obsidian puts the files that you delete. So the settings that Obsidian makes for a new vault do not stand in the way of the settings that the repository holds. A first sync that was cut off goes on as a first sync.
- A change wins over a removal.
- A name that is a file on one side and a folder on the other is kept on both: what is here keeps the name, and what the remote has goes beside it, as `name (conflict 2026-11-22 0915)`.
- What the device changed becomes commits on top of the remote, each with about 4 MB of content. The history of the branch stays a line.
- If another device sends something while a sync runs, the remote refuses what this one sends. The sync then looks at the remote again and goes on from there, up to three times.
- A file or a folder that gets another name is a removal and a new file to the sync, as it is to git. What it holds is not sent again: the remote has it already.
- A folder that loses its last file to a sync is removed. One that still holds something, such as a file that is not synced, stays.
- A file that was changed in the three seconds before a sync is read again by the next one. Its size and time alone would not tell a second change in the same moment.
- The `.gitignore` of the vault and the `.gitignore` files of its folders say what is left out, read as git reads them. A file that the repository tracks stays tracked.
- A `.gitignore` that a sync is about to take from the repository counts in that sync already. So a vault that meets a repository for the first time does not send what the repository leaves out, and a rule that another device added holds for what this one made in the meantime.
- A phone and most computers take `Note.md` and `note.md` for the same file, and git does not. A file of the repository whose path differs only in capital letters from one that the vault holds is left out of the vault, and you are told. It stays in the repository as it is. A name that changes only its capital letters, on either side, is a change of name like any other.
- An iPhone, an iPad and a Mac keep a name like `한글.md` or `é.md` with each letter taken apart into its parts, whatever the name was written as, and git keeps a name as it is given. On those devices a file of the vault has the name that the repository has for it, and a new file is sent with the letters of its name in one piece, as git does on a Mac. So a name does not change in the repository by going through such a device.
- A sync that finds nothing to do is short. For a note that Obsidian knows to be as it was, the disk is not asked. While the remote has not moved, its files are known from one file, also after this device moved it by what it sent. On an emulated phone such a sync of a hundred notes took a tenth of a second.
- What the vault has to be asked, it is asked a few things at once: which files a folder holds, how large a file is that Obsidian keeps no list of, what a file holds that is not as it was. A phone takes its time for each answer, whatever is asked, and the answers do not wait for one another. The asking starts while the remote is still asked where its branch is. Files are written one after the other, as before.
- A file and a folder are asked for once, and a second time only when that fails, to tell one that is not there from one that cannot be read. A file that was written and looked at is not asked for its size again. A sync that changed nothing writes nothing: what was agreed on stays in its file as it is.
- A note that is changed behind the back of Obsidian, by another app while Obsidian does not look, is sent once Obsidian has seen the change, which it does when it comes to the front again.
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
- A tracked file above the limit that gets another name on the device keeps what the repository has for it, under the new name. It is too large to be read, so it is known by its size: a new file above the limit that has, to the byte, the size of a tracked file that is gone is taken for that file.
- A file above the limit that the vault holds before it was ever synced, and that the repository has under the same name, is no new file. If it has the size of the one of the repository to the byte, it is taken for that file. If it has another size, the one of the repository takes its place at a first sync, where its size is known. Otherwise both stay as they are, and every sync says so.

The plugin keeps what it knows in the folder `.piecemeal` of the vault: commits, folders, one file that says what was agreed on, and one that lists the files of the commit that the remote was at. Without that folder, the vault meets the repository as at a first sync. With a file in it that cannot be read, the vault joins the remote anew: nothing is removed on either side, each side gets what only the other has, and a file that differs is as the repository has it, with your version kept beside it as a copy. Neither that folder, nor what git keeps under the name `.git`, at the top of the vault or in any folder of it, nor the file in which the plugin kept its settings before, nor the trash of Obsidian, nor the two files in which Obsidian keeps what is open on a device are ever synced. What the repository has under those names stays there and is not taken.

## Trying it

From a terminal, into any folder:

```bash
TOKEN=... node tests/try.ts https://github.com/you/vault.git /some/folder --read-only
```

`--read-only` stops the sync before it would send anything. Without it, what the folder holds and the repository does not is sent.

For a phone to sync with a repository on your computer, with no host and no token in between, `node tests/serve.ts <folder> [port]` serves the repositories of a folder to the devices of your network. The top of that file says how to make a repository there.

In Obsidian: build, then copy `main.js`, `manifest.json` and `styles.css` to `.obsidian/plugins/piecemeal-git/` of a vault, turn the plugin on, and give it the address of the repository and a token. The token needs to read and write the contents of that one repository. "Check" in the settings asks the server for its branches and changes nothing, so you see that the address and the token are right. Then run the command "Sync with the repository", or press the icon of the ribbon.

The token goes to the server as git sends it, as a password. GitHub and GitLab take it under any name. A host that wants the name of your account with it gets the name from the address: `https://name@host/you/vault.git`.

A sync can also start by itself: every so many minutes, and when Obsidian has opened the vault. Both are in the settings and are off at first. Such a sync says nothing while it runs. Afterwards it tells you only that it took something, that something asks for your attention, or that it failed, and a failure is said once and not every few minutes.

The files that Obsidian keeps for one device, `workspace.json` and `workspace-mobile.json` in its settings folder, change whenever you open a note. The plugin never syncs them.

Try it on a copy of a vault first.

## What you see

- While a sync runs, a notice says how far it is, and the icon of the ribbon turns. The desktop app also says it in the bar at the bottom, and there it says afterwards how long ago the last sync was.
- The plugin has a panel in the right sidebar, with its icon among the tabs there. It is there also where the ribbon is hidden or folded into a menu, as on a phone and a tablet. The panel says how the last sync went and how far one is that runs, has a button that starts a sync, and lists what the dialog "Show what the last sync did" lists. It is put there once, the first time the plugin runs in a vault. You can drag it into the left sidebar or close it, and "Open the panel in the sidebar" brings it back.
- A sync that went well says in a line what it took and sent, and the line goes away by itself. One that left something to look at stays until you close it, and has a button that shows the files. The icon then has a dot.
- "Show what the last sync did" lists the files of the last sync by what was done with them, and a file opens when you press its name.
- The same list shows every file of the vault that has a copy beside it, with two buttons: "Keep the repository's" removes the copy, and "Take the copy" puts the copy in the place of the file. The next sync sends what you chose. The copy goes to the other devices as well, so the list is the same on each of them, and any of them can choose.
- Before the first sync of a vault that holds files with a repository that holds files, and before a sync that removes ten files or more that are a quarter of all, a dialog says what is about to happen and waits for you. Before a first sync it names the files that give way to those of the repository. A sync that started by itself does not do such a thing: it stops, and tells you to start one yourself.
- Obsidian reads its settings and its plugins when it starts. After a sync that took some of them, the notice stays and tells you to close Obsidian and open it again. Until then Obsidian goes on with what it read, and writes that back when you change a setting.
- The list of the plugins that are on is a file of the settings too, and a sync takes the one of the repository. If that list does not name this plugin, the plugin adds itself to it again, and the next sync sends the list. Otherwise the plugin would be off the next time Obsidian starts.
- A file that another device removed goes where Obsidian puts the files that you delete, as its settings say: its trash, the one of the system, or nowhere.
- A sync that failed says what to do where that is known: give a token, look at the address, connect the device. If the server turned away what was sent, it says what the server said about it.
- What the server turns away is sent again after a moment, up to three times: a server that is still at work on what it got turns away what comes right after.

## Not done yet

- On a real device it has run once, the first sync of an Android tablet. It has not run on a real phone, and not on iOS. Inside Obsidian on a Mac it has not run either.
- The dialogs, the notices and the settings were looked at on the emulated Android phone only, and the panel of the sidebar on the emulated phone and tablet.
- How long a sync takes was measured with a git server on the same machine. With a host that takes its time for each request, where the look at the vault goes on while the host answers, it was not. The bar at the bottom of the desktop app was not seen at all.
- All that the plugin says is in English.
- What came after the runs inside Obsidian on a computer and with a private repository on GitHub has not run there: texts that are put together, links, branches, the look at every write. It ran in the tests and on the emulated phone.
- That the repository is right about a file that both sides changed, and at a first sync, came after the sync of the tablet. It ran in the tests, from a terminal against a copy of that vault with the files of the tablet as they were, and inside Obsidian on an emulated tablet. On a device that one holds in a hand and inside the desktop app it has not run yet.
- Files that a repository keeps with Git LFS come as the small files that stand for them, as they do for a git without LFS.
- The server has to speak version 2 of the git protocol, which git has done since 2018, and name its objects with SHA-1.
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

A release is made by a tag with the version of `manifest.json` as its name. GitHub then checks and builds the plugin, attests that `main.js`, `manifest.json` and `styles.css` were built there from this source, and puts them into the release. The directory of Obsidian finds a new release by itself in time, and at once when "Check for new releases" is pressed on the page of the plugin at community.obsidian.md. It then reviews the release.

- `src/git` holds the git protocol, the objects, and the sync. It knows nothing about Obsidian, so its tests run with plain Node.js against a git server on the same machine.
- `src/platform` holds how the plugin reads and writes files and talks to a server inside Obsidian.
- `tests` holds what runs on Node.js only and is no part of the plugin: files and HTTP for the tests, the git server that they talk to, the script that syncs from a terminal, and file systems that play a phone: one that does not tell capital letters from small ones, one that takes the letters of a name apart, and one that loses a write now and then.
- `src/main.ts` is the plugin: the commands, the icon, and what it tells you while a sync runs and after it.
- `src/ui` holds the settings and how they are kept, the two dialogs, the panel of the sidebar, and the words that the plugin says. `styles.css` is how they look.
- `node tests/bench.ts [notes]` times the kinds of sync on a vault of that many notes, against the git server of the tests.

## License

[MIT](LICENSE)

The `main.js` of a release includes [pako](https://github.com/nodeca/pako), which reads and writes what git keeps compressed. It is under the MIT license and the Zlib license.
