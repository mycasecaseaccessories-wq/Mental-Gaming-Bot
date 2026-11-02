import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const handler = require("../api/[...path].js");
const server = createServer((req, res) => handler(req, res));

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  process.stdout.write("Vercel API bundle health smoke test passed.\n");
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
}
