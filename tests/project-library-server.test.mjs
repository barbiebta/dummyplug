import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectLibrary, ProjectLibraryError } from "../lib/project-library-server.ts";

async function withLibrary(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dummyplug-project-library-"));
  try { await run(new ProjectLibrary(root), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("creates, lists, and persists a project and its settings", async () => withLibrary(async (library) => {
  const project = await library.createProject("rabbit apartment");
  assert.match(project.id, /^[0-9a-f-]{36}$/i);
  assert.equal(project.outputSettings.outputContainer, "mp4");
  assert.equal((await library.listProjects())[0].name, "rabbit apartment");
  const changed = await library.updateProject(project.id, { outputSettings: { width: 1024, height: 576 } });
  assert.equal(changed.outputSettings.width, 1024);
  assert.equal((await library.getProject(project.id)).outputSettings.height, 576);
}));

test("imports bytes into preserved folders, writes exact sidecars, and avoids destructive conflicts", async () => withLibrary(async (library, root) => {
  const project = await library.createProject("film test");
  const first = await library.importAsset(project.id, { relativePath: "characters/rabbit.png", bytes: new TextEncoder().encode("rabbit"), sidecar: { schema: "dummyplug.asset.v4", assetId: "old-browser-id", metadata: { canonicalName: "Rabbit" }, analysis: { assetId: "old-browser-id", summary: "Rabbit" }, localAnalysis: { assetId: "old-browser-id", summary: "Local Rabbit" } } });
  const second = await library.importAsset(project.id, { relativePath: "characters/rabbit.png", bytes: new TextEncoder().encode("rabbit 2") });
  assert.equal(first.relativePath, "characters/rabbit.png");
  assert.equal(second.relativePath, "characters/rabbit (2).png");
  assert.equal(second.conflictRenamed, true);
  assert.notEqual(first.id, "old-browser-id");
  assert.equal(first.analysis?.assetId, first.id);
  assert.equal(first.localAnalysis?.assetId, first.id);
  const sidecar = path.join(root, "film test", "assets", "characters", "rabbit.png.dummyplug.json");
  const sidecarText = await (await import("node:fs/promises")).readFile(sidecar, "utf8");
  assert.match(sidecarText, /dummyplug/);
}));

test("recrawl discovers external assets and ignores sidecars and trash", async () => withLibrary(async (library, root) => {
  const project = await library.createProject("crawl test");
  const assets = path.join(root, "crawl test", "assets", "outside");
  await mkdir(assets, { recursive: true });
  await writeFile(path.join(assets, "setting.jpg"), "image");
  await writeFile(path.join(assets, "setting.jpg.dummyplug.json"), "{}");
  await writeFile(path.join(assets, "setting.jpg.dummyplug.json.tmp-deadbeef"), "partial json");
  await mkdir(path.join(root, "crawl test", ".trash", "old"), { recursive: true });
  await writeFile(path.join(root, "crawl test", ".trash", "old", "ignored.jpg"), "image");
  const found = await library.recrawl(project.id);
  assert.deepEqual(found.map((asset) => asset.relativePath), ["outside/setting.jpg"]);
  assert.ok(found[0].id);
}));

test("moves, renames, and trashes files together with their sidecars", async () => withLibrary(async (library) => {
  const project = await library.createProject("organize test");
  await library.createFolder(project.id, "characters");
  const imported = await library.importAsset(project.id, { relativePath: "rabbit.png", bytes: Buffer.from("rabbit") });
  const moved = await library.moveAsset(project.id, imported.relativePath, "characters");
  assert.equal(moved.relativePath, "characters/rabbit.png");
  const renamed = await library.renameAsset(project.id, moved.relativePath, "rabbit hero.png");
  assert.equal(renamed.relativePath, "characters/rabbit hero.png");
  await library.trashAsset(project.id, renamed.relativePath);
  assert.deepEqual((await library.recrawl(project.id)).map((asset) => asset.relativePath), []);
  await library.createFolder(project.id, "sets");
  await library.createFolder(project.id, "archive");
  await library.moveFolder(project.id, "sets", "archive");
  await library.renameFolder(project.id, "archive/sets", "locations");
  assert.deepEqual(await library.listFolders(project.id), ["archive", "archive/locations", "characters"]);
  await library.removeEmptyFolder(project.id, "archive/locations");
}));

test("manual and vision metadata updates rewrite the v4 companion without changing identity", async () => withLibrary(async (library, root) => {
  const project = await library.createProject("metadata test");
  const imported = await library.importAsset(project.id, { relativePath: "rabbit.png", bytes: Buffer.from("rabbit") });
  const updated = await library.updateAssetMetadata(project.id, imported.relativePath, {
    metadata: { canonicalName: "Rabbit", role: "character", note: "drunk and happy", localSourceOf: "explicit anatomy", localNote: "local-only instruction" },
    analysis: { assetId: imported.id, summary: "A very specific rabbit." },
    localAnalysis: { assetId: imported.id, summary: "A direct local description." },
    sourceFacts: { width: 768, height: 1344 },
  });
  assert.equal(updated.id, imported.id);
  assert.equal(updated.canonicalName, "Rabbit");
  assert.equal(updated.analysis?.summary, "A very specific rabbit.");
  assert.equal(updated.localAnalysis?.summary, "A direct local description.");
  assert.equal(updated.localSourceOf, "explicit anatomy");
  const sidecar = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(root, "metadata test", "assets", "rabbit.png.dummyplug.json"), "utf8"));
  assert.equal(sidecar.schema, "dummyplug.asset.v4");
  assert.equal(sidecar.assetId, imported.id);
  assert.equal(sidecar.dummyplug, undefined);
  assert.equal(sidecar.source.width, 768);
  await writeFile(path.join(root, "metadata test", "assets", "rabbit.png"), "changed rabbit bytes");
  const [changed] = await library.recrawl(project.id);
  assert.equal(changed.id, imported.id);
  assert.equal(changed.analysis, undefined);
  assert.equal(changed.localAnalysis, undefined);
}));

test("draft state persists while path traversal and symlink-like paths are rejected", async () => withLibrary(async (library) => {
  const project = await library.createProject("draft test");
  const draft = await library.updateDraft(project.id, { simplePrompt: "Rabbit walks", selectedAssetIds: ["a", "a", "b"], seedMode: "random" });
  assert.deepEqual(draft.selectedAssetIds, ["a", "b"]);
  assert.equal((await library.getDraft(project.id)).simplePrompt, "Rabbit walks");
  await assert.rejects(() => library.importAsset(project.id, { relativePath: "../outside.png", bytes: Buffer.from("x") }), ProjectLibraryError);
  await assert.rejects(() => library.createFolder(project.id, "C:\\outside"), ProjectLibraryError);
}));
