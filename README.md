# Piecemeal Git

Working title. An [Obsidian](https://obsidian.md) plugin that syncs a vault with a git repository, built to work on a phone.

It speaks the git protocol itself and needs no git program. What sets it apart is that it never holds more than a few megabytes at a time:

- It first asks for the commits and the folders only, and then for the contents of the files in small batches.
- It keeps no second copy of the files. The vault is the copy.
- A file that is too large to send from the device is not sent. The plugin writes it into `.gitignore` and tells you.

Nothing here works yet. Development has just started.

## Development

You need [Node.js](https://nodejs.org) 24 or later.

```bash
npm install
npm run check   # type check, lint, and tests
npm run build   # type check, then the main.js of a release
```

- `src/git` holds the git protocol, the objects, and the sync. It knows nothing about Obsidian, so its tests run with plain Node.js against a git server on the same machine.
- `src/platform` holds what differs between Obsidian and Node.js: files and HTTP.

## License

[MIT](LICENSE)
