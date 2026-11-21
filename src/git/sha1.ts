import { toHex } from "./bytes.ts";

/** SHA-1 of the bytes, as 40 hex digits. Web Crypto is in Node.js and in every web view. */
export async function sha1(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>);
  return toHex(new Uint8Array(digest));
}
