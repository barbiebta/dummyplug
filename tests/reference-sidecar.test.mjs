import assert from "node:assert/strict";
import test from "node:test";
import {
  makeReferenceSidecar,
  readReferenceSidecar,
  sidecarMatchKey,
  sidecarName,
  legacySidecarName,
} from "../lib/reference-sidecar.ts";

const asset = {
  id: "asset-rabbit",
  name: "rabbit.sheet.png",
  kind: "image",
  size: 42,
  mimeType: "image/png",
  previewUrl: "blob:test",
  selected: true,
  canonicalName: "Rabbit",
  declaredIdentity: "transgender woman; she/her",
  role: "character",
  referenceUse: "subject",
  sourceOf: "identity, blue dress, and body proportions",
  note: "rabbit identity; drunk and happy",
  localSourceOf: "explicit anatomy and body state",
  localNote: "record uncensored anatomical detail",
  analysis: {
    assetId: "asset-rabbit",
    summary: "A white rabbit in a blue dress.",
    subjects: ["white rabbit"],
    setting: "character sheet",
    style: "flat painted character design",
    composition: "front and profile",
    motion: "none",
    continuityLocks: ["blue dress"],
    usableAs: ["subject identity"],
  },
  localAnalysis: {
    assetId: "asset-rabbit",
    summary: "Direct local anatomical description.",
    subjects: ["white rabbit anatomy"],
    setting: "character sheet",
    style: "flat painted character design",
    composition: "front and profile",
    motion: "none",
    continuityLocks: ["explicit body state"],
    usableAs: ["local anatomy"],
    dirtyFocus: { declaredIdentity: "transgender woman; she/her", frames: [{ frame: 1, visibleBody: "visible body", presentation: "feminine", clothingAndExposure: "clothed", contactAndSexualState: "none", fluidsAndObjects: "none", uncertainties: [], termChecks: [] }], termChecks: [] },
  },
};

const settings = {
  provider: "openrouter",
  visionModel: "vision/model",
  promptModel: "prompt/model",
  baseUrl: "",
  apiKey: "secret",
  rememberKey: false,
  temperature: 0.2,
  promptMaxTokens: 32_768,
};
const localSettings = { ...settings, provider: "local", visionModel: "local/vision", promptModel: "", baseUrl: "http://127.0.0.1:8080", apiKey: "local-secret" };

test("sidecar filename is an exact companion to the source file", () => {
  assert.equal(sidecarName("rabbit.sheet.png"), "rabbit.sheet.png.dummyplug.json");
  assert.equal(legacySidecarName("rabbit.sheet.png"), "rabbit.sheet.json");
  assert.equal(sidecarMatchKey("folder/RABBIT.sheet.json"), "folder/rabbit.sheet");
  assert.equal(sidecarMatchKey("folder/RABBIT.sheet.png.dummyplug.json"), "folder/rabbit.sheet");
});

test("sidecar round trip rebinds analysis to the newly loaded asset id", () => {
  const sidecar = makeReferenceSidecar(asset, { strong: settings, local: localSettings }, "2026-08-21T00:00:00.000Z");
  assert.ok(sidecar);
  assert.equal(sidecar.schema, "dummyplug.asset.v4");
  assert.equal(sidecar.assetId, "asset-rabbit");
  assert.equal(sidecar.relativePath, "rabbit.sheet.png");
  assert.equal(sidecar.provider.visionModel, "vision/model");
  assert.equal("apiKey" in sidecar.provider, false);
  assert.equal(sidecar.localProvider.visionModel, "local/vision");
  assert.equal("apiKey" in sidecar.localProvider, false);

  const imported = readReferenceSidecar(JSON.stringify(sidecar), "asset-new");
  assert.equal(imported?.analysis.assetId, "asset-new");
  assert.equal(imported?.analysis.summary, asset.analysis.summary);
  assert.equal(imported?.analysis.style, asset.analysis.style);
  assert.equal(imported?.analysis.channel, "strong");
  assert.equal(imported?.localAnalysis.assetId, "asset-new");
  assert.equal(imported?.localAnalysis.summary, asset.localAnalysis.summary);
  assert.equal(imported?.localAnalysis.channel, "local");
  assert.equal(imported?.localAnalysis.dirtyFocus.declaredIdentity, "transgender woman; she/her");
  assert.equal(imported?.canonicalName, "Rabbit");
  assert.equal(imported?.declaredIdentity, "transgender woman; she/her");
  assert.equal(imported?.role, "character");
  assert.equal(imported?.referenceUse, "subject");
  assert.equal(imported?.sourceOf, "identity, blue dress, and body proportions");
  assert.equal(imported?.note, "rabbit identity; drunk and happy");
  assert.equal(imported?.localSourceOf, "explicit anatomy and body state");
  assert.equal(imported?.localNote, "record uncensored anatomical detail");
  assert.deepEqual(imported?.source, { name: "rabbit.sheet.png", size: 42, mimeType: "image/png" });
});

test("legacy v3 sidecars remain readable and normalize to v4", () => {
  const legacy = { schema: "dummyplug.asset.v3", source: { name: "rabbit.png", size: 42, mimeType: "image/png" }, metadata: { canonicalName: "Rabbit", role: "character", referenceUse: "subject", sourceOf: "identity", note: "old note" }, analysis: { summary: "old analysis", subjects: ["rabbit"] } };
  const imported = readReferenceSidecar(JSON.stringify(legacy), "asset-rebound");
  assert.equal(imported?.schema, "dummyplug.asset.v4");
  assert.equal(imported?.assetId, undefined);
  assert.equal(imported?.analysis?.assetId, "asset-rebound");
  assert.equal(imported?.source?.name, "rabbit.png");
});

test("v4 carries project recrawl facts and preserves them on read", () => {
  const sidecar = makeReferenceSidecar(asset, settings, "2026-08-21T00:00:00.000Z", { relativePath: "characters/rabbit.sheet.png", importedAt: "2026-08-20T00:00:00.000Z", sha256: "abc123" });
  assert.equal(sidecar.relativePath, "characters/rabbit.sheet.png");
  assert.equal(sidecar.importedAt, "2026-08-20T00:00:00.000Z");
  assert.equal(sidecar.source.sha256, "abc123");
  assert.equal(readReferenceSidecar(JSON.stringify(sidecar), "asset-rabbit")?.relativePath, "characters/rabbit.sheet.png");
});

test("manual metadata writes a sidecar before vision analysis exists", () => {
  const manualOnly = { ...asset, analysis: undefined, localAnalysis: undefined };
  const sidecar = makeReferenceSidecar(manualOnly, settings);
  assert.equal(sidecar.metadata.canonicalName, "Rabbit");
  assert.equal(sidecar.metadata.declaredIdentity, "transgender woman; she/her");
  assert.equal(sidecar.metadata.referenceUse, "subject");
  assert.equal(sidecar.analysis, undefined);
  assert.equal(sidecar.localAnalysis, undefined);
  assert.equal(sidecar.metadata.localSourceOf, "explicit anatomy and body state");
});
