// Serves the repositories of a folder to the devices of the network, to try the plugin from a real phone:
//   node testing/serve.ts <folder> [port]
// Make a repository in the folder first:
//   git init --bare -b main <folder>/vault.git
//   git -C <folder>/vault.git config http.receivepack true
//   git -C <folder>/vault.git config uploadpack.allowFilter true
//   git -C <folder>/vault.git config uploadpack.allowAnySHA1InWant true
//   git -C <folder>/vault.git config transfer.advertiseObjectInfo true   (to tell the sizes of files)
// The phone then syncs with http://<address of this machine>:<port>/vault.git, without a token.
// Anyone on the network can read and write these repositories while this runs.
// With CREDENTIALS=name:password before the command, only who gives these can:
// the phone then syncs with http://name@<address>:<port>/vault.git and the password as its token.
import { TestServer } from "./server.ts";

const [root, port] = process.argv.slice(2);
if (root === undefined) {
  console.error("usage: node testing/serve.ts <folder> [port]");
  process.exit(2);
}
const server = new TestServer(root);
server.credentials = process.env["CREDENTIALS"] ?? null;
server.onResponse = (method, path, status, bytes) => {
  console.log(`${new Date().toISOString().slice(11, 19)} ${method} ${path} ${status} ${bytes} bytes`);
};
await server.start("0.0.0.0", Number(port ?? 8765));
console.log(`serving ${root} on port ${port ?? 8765}`);
