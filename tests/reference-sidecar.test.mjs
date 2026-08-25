import assert from "node:assert/strict";
import test from "node:test";
import {
  makeReferenceSidecar,
  readReferenceSidecar,
  sidecarMatchKey,
  sidecarName,
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
  role: "character",
  referenceUse: "subject",
  sourceOf: "identity, blue dress, and body proportions",
  note: "rabbit identity; drunk and happy",
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

test("sidecar filename replaces only the source extension", () => {
  assert.equal(sidecarName("rabbit.sheet.png"), "rabbit.sheet.json");
  assert.equal(sidecarMatchKey("folder/RABBIT.sheet.json"), "folder/rabbit.sheet");
});

test("sidecar round trip rebinds analysis to the newly loaded asset id", () => {
  const sidecar = makeReferenceSidecar(asset, settings, "2026-08-21T00:00:00.000Z");
  assert.ok(sidecar);
  assert.equal(sidecar.provider.visionModel, "vision/model");
  assert.equal("apiKey" in sidecar.provider, false);

  const imported = readReferenceSidecar(JSON.stringify(sidecar), "asset-new");
  assert.equal(imported?.analysis.assetId, "asset-new");
  assert.equal(imported?.analysis.summary, asset.analysis.summary);
  assert.equal(imported?.analysis.style, asset.analysis.style);
  assert.equal(imported?.canonicalName, "Rabbit");
  assert.equal(imported?.role, "character");
  assert.equal(imported?.referenceUse, "subject");
  assert.equal(imported?.sourceOf, "identity, blue dress, and body proportions");
  assert.equal(imported?.note, "rabbit identity; drunk and happy");
  assert.deepEqual(imported?.source, { name: "rabbit.sheet.png", size: 42, mimeType: "image/png" });
});

test("manual metadata writes a sidecar before vision analysis exists", () => {
  const manualOnly = { ...asset, analysis: undefined };
  const sidecar = makeReferenceSidecar(manualOnly, settings);
  assert.equal(sidecar.metadata.canonicalName, "Rabbit");
  assert.equal(sidecar.metadata.referenceUse, "subject");
  assert.equal(sidecar.analysis, undefined);
});
