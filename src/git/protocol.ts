import { concat, decode, encode } from "./bytes.ts";
import { type Http, type HttpResponse } from "./http.ts";
import { DELIM, FLUSH, lineText, pkt, readPkts } from "./pktline.ts";

const AGENT = "agent=piecemeal-git/0.1";
export const ZERO_OID = "0".repeat(40);

export interface Remote {
  /** The address of the repository, as `git clone` takes it over HTTPS, without a name or a password in it */
  url: string;
  /** A token that may read and write the repository, or a password */
  token?: string;
  /** The name that goes with the token. Without it, the one that GitHub and GitLab take with any token. */
  username?: string;
}

/**
 * A remote from an address as a person gives it. A name before the host, as
 * in `https://someone@host/vault.git`, is the name that goes with the token:
 * some hosts want the name of the account there. A password in the address
 * is used if there is no token.
 */
export function remoteOf(address: string, token?: string): Remote {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return { url: address, token };
  }
  const username = parsed.username === "" ? undefined : decodeURIComponent(parsed.username);
  const password = parsed.password === "" ? undefined : decodeURIComponent(parsed.password);
  if (username === undefined && password === undefined) {
    return { url: address, token };
  }
  const at = address.indexOf("@");
  const url = address.slice(0, address.indexOf("//") + 2) + address.slice(at + 1);
  const secret = token !== undefined && token !== "" ? token : password;
  return username === undefined ? { url, token: secret } : { url, token: secret, username };
}

export class RemoteError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

function headers(remote: Remote, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {
    // A response that comes compressed a second time has been seen to arrive damaged
    "Accept-Encoding": "identity",
    ...extra,
  };
  if (remote.token !== undefined && remote.token !== "") {
    // The letters go as UTF-8, as git and curl send them
    const pair = encode(`${remote.username ?? "x-access-token"}:${remote.token}`);
    out["Authorization"] = `Basic ${btoa(Array.from(pair, (byte) => String.fromCharCode(byte)).join(""))}`;
  }
  return out;
}

function base(remote: Remote): string {
  return remote.url.replace(/\/+$/, "");
}

function check(response: HttpResponse, what: string, remote: Remote): void {
  if (response.status === 401 || response.status === 403) {
    const reason = remote.token === undefined || remote.token === "" ? "the server wants a token" : "the server refuses the token";
    throw new RemoteError(`${what}: ${reason} (${response.status})`, response.status);
  }
  if (response.status === 404) {
    throw new RemoteError(`${what}: no such repository, or the token may not see it`, 404);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new RemoteError(`${what}: the server answers ${response.status}`, response.status);
  }
}

async function uploadPack(http: Http, remote: Remote, lines: Uint8Array[]): Promise<Uint8Array> {
  const response = await http({
    url: `${base(remote)}/git-upload-pack`,
    method: "POST",
    headers: headers(remote, {
      "Content-Type": "application/x-git-upload-pack-request",
      Accept: "application/x-git-upload-pack-result",
      "Git-Protocol": "version=2",
    }),
    body: concat(lines),
  });
  check(response, "fetch", remote);
  return response.body;
}

/**
 * What the server can do, by name, as it tells before anything is asked of
 * it. Some come with a value, such as "fetch" with "shallow filter".
 */
export async function capabilities(http: Http, remote: Remote): Promise<Map<string, string>> {
  const response = await http({
    url: `${base(remote)}/info/refs?service=git-upload-pack`,
    method: "GET",
    headers: headers(remote, { "Git-Protocol": "version=2" }),
  });
  check(response, "fetch", remote);
  const out = new Map<string, string>();
  for (const packet of readPkts(response.body)) {
    if (packet.type !== "data") {
      continue;
    }
    const line = lineText(packet.data);
    // A server that does not speak version 2 starts with "# service=", and tells nothing of use here
    if (line.startsWith("#")) {
      return new Map();
    }
    const equals = line.indexOf("=");
    out.set(equals < 0 ? line : line.slice(0, equals), equals < 0 ? "" : line.slice(equals + 1));
  }
  return out;
}

/** How many objects one request asks the size of */
const SIZES_PER_REQUEST = 2000;

/**
 * The sizes of objects, by their ids, on a server that tells "object-info"
 * among what it can do. An object that the server does not have is left out.
 */
export async function objectSizes(http: Http, remote: Remote, oids: string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (let start = 0; start < oids.length; start += SIZES_PER_REQUEST) {
    const body = await uploadPack(http, remote, [
      pkt("command=object-info\n"),
      pkt(`${AGENT}\n`),
      pkt("object-format=sha1\n"),
      DELIM,
      pkt("size\n"),
      ...oids.slice(start, start + SIZES_PER_REQUEST).map((oid) => pkt(`oid ${oid}\n`)),
      FLUSH,
    ]);
    for (const packet of readPkts(body)) {
      if (packet.type !== "data") {
        continue;
      }
      const line = lineText(packet.data);
      throwIfError(line);
      const [oid, size] = line.split(" ");
      if (oid.length === 40 && size !== undefined && /^\d+$/.test(size)) {
        sizes.set(oid, Number(size));
      }
    }
  }
  return sizes;
}

function throwIfError(line: string): void {
  if (line.startsWith("ERR ")) {
    throw new RemoteError(`the server says: ${line.slice(4)}`);
  }
}

export interface Refs {
  /** Full names of branches, and their commits */
  heads: Map<string, string>;
  /** The branch that HEAD names, as a full name */
  head?: string;
}

/** The branches of the remote. */
export async function lsRefs(http: Http, remote: Remote): Promise<Refs> {
  const body = await uploadPack(http, remote, [
    pkt("command=ls-refs\n"),
    pkt(`${AGENT}\n`),
    pkt("object-format=sha1\n"),
    DELIM,
    pkt("symrefs\n"),
    pkt("ref-prefix HEAD\n"),
    pkt("ref-prefix refs/heads/\n"),
    FLUSH,
  ]);
  const refs: Refs = { heads: new Map() };
  for (const packet of readPkts(body)) {
    if (packet.type !== "data") {
      continue;
    }
    const line = lineText(packet.data);
    throwIfError(line);
    const [oid, name, ...attributes] = line.split(" ");
    if (oid === undefined || name === undefined) {
      continue;
    }
    if (name === "HEAD") {
      const target = attributes.find((a) => a.startsWith("symref-target:"));
      if (target !== undefined) {
        refs.head = target.slice("symref-target:".length);
      }
    } else if (name.startsWith("refs/heads/") && oid !== "unborn") {
      refs.heads.set(name, oid);
    }
  }
  return refs;
}

export interface FetchOptions {
  /** The objects to get */
  wants: string[];
  /** Commits that are here already, so that what they reach is not sent again */
  haves?: string[];
  /** Commits that are here without their parents */
  shallow?: string[];
  /** How many commits deep to go from each want */
  depth?: number;
  /** For example "blob:none": no contents of files */
  filter?: string;
}

export interface FetchResult {
  pack: Uint8Array;
  /** Commits that the server sent without their parents */
  shallow: string[];
}

/** Asks for objects and returns the pack that holds them. */
export async function fetchPack(
  http: Http,
  remote: Remote,
  options: FetchOptions,
): Promise<FetchResult> {
  const lines = [
    pkt("command=fetch\n"),
    pkt(`${AGENT}\n`),
    pkt("object-format=sha1\n"),
    DELIM,
    pkt("no-progress\n"),
    pkt("ofs-delta\n"),
  ];
  for (const oid of options.shallow ?? []) {
    lines.push(pkt(`shallow ${oid}\n`));
  }
  if (options.depth !== undefined) {
    lines.push(pkt(`deepen ${options.depth}\n`));
  }
  if (options.filter !== undefined) {
    lines.push(pkt(`filter ${options.filter}\n`));
  }
  for (const oid of options.wants) {
    lines.push(pkt(`want ${oid}\n`));
  }
  for (const oid of options.haves ?? []) {
    lines.push(pkt(`have ${oid}\n`));
  }
  lines.push(pkt("done\n"), FLUSH);
  const body = await uploadPack(http, remote, lines);

  const result: FetchResult = { pack: new Uint8Array(0), shallow: [] };
  const packParts: Uint8Array[] = [];
  let section = "";
  for (const packet of readPkts(body)) {
    if (packet.type !== "data") {
      if (packet.type === "delim") {
        section = "";
      }
      continue;
    }
    if (section === "packfile") {
      // Three channels in one: 1 is the pack, 2 is talk for a person, 3 is an error
      const band = packet.data[0];
      if (band === 1) {
        packParts.push(packet.data.subarray(1));
      } else if (band === 3) {
        throw new RemoteError(`the server says: ${decode(packet.data.subarray(1)).trim()}`);
      }
      continue;
    }
    const line = lineText(packet.data);
    throwIfError(line);
    if (section === "") {
      section = line;
    } else if (section === "shallow-info" && line.startsWith("shallow ")) {
      result.shallow.push(line.slice("shallow ".length));
    }
  }
  result.pack = concat(packParts);
  if (result.pack.length === 0) {
    throw new RemoteError("fetch: the server sent no pack");
  }
  return result;
}

export interface PushOptions {
  /** The full name of the branch */
  ref: string;
  /** The commit that the branch is believed to be at, or zeros for a new branch */
  oldOid: string;
  newOid: string;
  pack: Uint8Array;
}

/** Thrown when the branch is no longer where the push took it to be. */
export class RejectedError extends RemoteError {}

/** Sends a pack and moves the branch to its commit. */
export async function push(http: Http, remote: Remote, options: PushOptions): Promise<void> {
  // With side-band-64k the server sends what it has to say to a person beside its report. Without
  // it a push that is turned away comes back with a word like "failed", and the reason stays there.
  const command = `${options.oldOid} ${options.newOid} ${options.ref}\0 report-status side-band-64k ${AGENT}\n`;
  const response = await http({
    url: `${base(remote)}/git-receive-pack`,
    method: "POST",
    headers: headers(remote, {
      "Content-Type": "application/x-git-receive-pack-request",
      Accept: "application/x-git-receive-pack-result",
    }),
    body: concat([pkt(encode(command)), FLUSH, options.pack]),
  });
  check(response, "push", remote);
  const { report, said } = pushReport(response.body);
  /** What the server said about it, for a person to read */
  const reason = said === "" ? "" : `. The server says: ${said}`;
  let unpacked = false;
  let accepted = false;
  for (const packet of readPkts(report)) {
    if (packet.type !== "data") {
      continue;
    }
    const line = lineText(packet.data);
    throwIfError(line);
    if (line === "unpack ok") {
      unpacked = true;
    } else if (line.startsWith("unpack ")) {
      throw new RemoteError(`push: the server could not read the pack (${line.slice(7)})${reason}`);
    } else if (line === `ok ${options.ref}`) {
      accepted = true;
    } else if (line.startsWith(`ng ${options.ref}`)) {
      throw new RejectedError(`push: the server keeps the branch as it is (${line.slice(4 + options.ref.length)})${reason}`);
    }
  }
  if (!unpacked || !accepted) {
    throw new RemoteError(`push: the server did not confirm${reason}`);
  }
}

/**
 * Takes the answer to a push apart: the report on the pack and the branch,
 * and what the server says to a person beside it. A server that does not
 * send the two side by side sends the report alone.
 */
export function pushReport(body: Uint8Array): { report: Uint8Array; said: string } {
  const packets = [...readPkts(body)];
  const first = packets.find((packet) => packet.type === "data");
  // Side by side, every line starts with the number of its band. A report by itself starts with a letter.
  if (first === undefined || first.type !== "data" || first.data.length === 0 || first.data[0] > 3) {
    return { report: body, said: "" };
  }
  const report: Uint8Array[] = [];
  let said = "";
  for (const packet of packets) {
    if (packet.type !== "data" || packet.data.length === 0) {
      continue;
    }
    if (packet.data[0] === 1) {
      report.push(packet.data.subarray(1));
    } else {
      // Band 2 is what git prints after "remote:", and band 3 an error that ends the answer
      said += decode(packet.data.subarray(1));
    }
  }
  const lines = said
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return { report: concat(report), said: lines.join(" ") };
}
