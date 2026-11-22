export const BLOCK_START = "# >>> Piecemeal Git: too large to send from this device";
export const BLOCK_END = "# <<< Piecemeal Git";

/** Says if `.gitignore` leaves a path out. A folder is asked about with `isDir`. */
export type Ignores = (path: string, isDir: boolean) => boolean;

/**
 * What one `.gitignore` says about a path, which is relative to the folder of
 * that file: true to leave it out, false to keep it after all, and undefined
 * when no line of the file matches. The folders above the path are not looked at.
 */
export type Verdict = (path: string, isDir: boolean) => boolean | undefined;

interface Rule {
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
  /** For a pattern that ends in `/**`: git takes the folder itself to match too */
  folder?: RegExp;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/]/g;

/** One line of `.gitignore` as a rule, or null for a comment or an empty line. */
function compile(raw: string): Rule | null {
  let line = raw.replace(/\r$/, "");
  // Spaces at the end do not count, unless a backslash keeps the last one
  let end = line.length;
  while (end > 0 && line[end - 1] === " " && line[end - 2] !== "\\") {
    end--;
  }
  line = line.slice(0, end);
  if (line === "" || line.startsWith("#")) {
    return null;
  }
  const negated = line.startsWith("!");
  if (negated) {
    line = line.slice(1);
  }
  const dirOnly = line.endsWith("/");
  if (dirOnly) {
    line = line.slice(0, -1);
  }
  // A slash anywhere but at the end ties the pattern to the folder of the file
  const anchored = line.includes("/");
  if (line.startsWith("/")) {
    line = line.slice(1);
  }
  let out = "";
  let folder: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      out += line[++i].replace(REGEX_SPECIAL, "\\$&");
    } else if (c === "*") {
      if (line[i + 1] === "*") {
        const before = i === 0 || line[i - 1] === "/";
        const after = i + 2 === line.length || line[i + 2] === "/";
        if (before && after) {
          if (i + 2 === line.length) {
            if (out.endsWith("\\/")) {
              folder = out.slice(0, -2);
            }
            out += ".*";
            i += 1;
          } else {
            out += "(?:.*/)?";
            i += 2;
          }
          continue;
        }
        i += 1;
      }
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      let j = i + 1;
      if (line[j] === "!" || line[j] === "^") j++;
      if (line[j] === "]") j++;
      while (j < line.length && line[j] !== "]") j++;
      if (j >= line.length) {
        out += "\\[";
        continue;
      }
      let body = line.slice(i + 1, j);
      const not = body.startsWith("!") || body.startsWith("^");
      if (not) {
        body = body.slice(1);
      }
      out += `[${not ? "^" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
      i = j;
    } else {
      out += c.replace(REGEX_SPECIAL, "\\$&");
    }
  }
  const whole = (body: string): RegExp => new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
  return { negated, dirOnly, regex: whole(out), folder: folder === undefined ? undefined : whole(folder) };
}

/** The lines of one `.gitignore`. The last line that matches a path decides. */
export function verdict(gitignore: string): Verdict {
  const rules = gitignore
    .split("\n")
    .map(compile)
    .filter((rule) => rule !== null);
  return (path, isDir) => {
    let ignored: boolean | undefined;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) {
        continue;
      }
      if (rule.regex.test(path) || (isDir && rule.folder?.test(path) === true)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  };
}

/**
 * Reads a `.gitignore` the way git does: the last line that matches decides,
 * and what is inside an ignored folder cannot be brought back.
 */
export function matcher(gitignore: string): Ignores {
  const decide = verdict(gitignore);
  return (path, isDir) => {
    for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) {
      if (decide(path.slice(0, slash), true) === true) {
        return true;
      }
    }
    return decide(path, isDir) === true;
  };
}

/** A line of `.gitignore` that matches this one path and nothing else. */
export function escapePattern(path: string): string {
  const escaped = path.replace(/[\\*?[]/g, "\\$&").replace(/ $/, "\\ ");
  return `/${escaped}`;
}

/**
 * Adds paths to the part of `.gitignore` that the plugin keeps. The rest of
 * the file is left as it is, and so is what the part holds already.
 */
export function addToBlock(gitignore: string, paths: string[]): string {
  const lines = gitignore === "" ? [] : gitignore.replace(/\n$/, "").split("\n");
  let start = lines.indexOf(BLOCK_START);
  let end = start < 0 ? -1 : lines.indexOf(BLOCK_END, start);
  if (start < 0 || end < 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    start = lines.length;
    lines.push(BLOCK_START, BLOCK_END);
    end = start + 1;
  }
  const have = new Set(lines.slice(start + 1, end));
  const added = paths.map(escapePattern).filter((line) => !have.has(line));
  lines.splice(end, 0, ...added);
  return `${lines.join("\n")}\n`;
}
