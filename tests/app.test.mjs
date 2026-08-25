import assert from "node:assert/strict";
import test from "node:test";

async function worker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const context = { waitUntil() {}, passThroughOnException() {} };

test("server-renders the dummyplug workspace", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), env, context);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>dummyplug — MiniMax H3 prompt studio<\/title>/i);
  assert.match(html, /dummyplug/);
  assert.match(html, /settings/);
  assert.match(html, /asset library/i);
  assert.match(html, /one continuous take/i);
});

test("exposes the local provider bridge health route", async () => {
  const app = await worker();
  const response = await app.fetch(new Request("http://localhost/api/provider"), env, context);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "dummyplug provider bridge" });
});
