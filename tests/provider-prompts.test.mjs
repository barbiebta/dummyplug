import assert from "node:assert/strict";
import test from "node:test";
import { buildSingleShotPrompt, buildVisionPrompt, EXPOSED_PROMPT_TEMPLATES, selectVisionAnalysisRole, visionTemplateId } from "../lib/single-prompts.ts";

test("exposes only vision, single-shot, and connection recipes", () => {
  assert.deepEqual(EXPOSED_PROMPT_TEMPLATES.map((item) => item.id), ["vision-character", "vision-setting", "vision-style", "vision-general", "single-shot", "connection-probe"]);
});

test("manual role and source-of metadata route and enter the vision recipe", () => {
  const reference = { assetId: "rabbit", name: "rabbit.png", kind: "image", canonicalName: "Rabbit", role: "character", referenceUse: "subject", sourceOf: "face, body, wardrobe, drunk happy expression", note: "main character", dataUrls: [] };
  assert.equal(selectVisionAnalysisRole(reference), "character");
  assert.equal(visionTemplateId("character"), "vision-character");
  const prompt = buildVisionPrompt(reference);
  assert.match(prompt, /Canonical name: Rabbit/);
  assert.match(prompt, /source of: face, body, wardrobe, drunk happy expression/i);
  assert.match(prompt, /minute visible identity evidence/i);
  assert.doesNotMatch(prompt, /{{\w+}}/);
});

test("local vision channel gets its own manual authority and direct adult-evidence instruction", () => {
  const prompt = buildVisionPrompt({ assetId: "rabbit", analysisChannel: "local", name: "rabbit.png", kind: "image", canonicalName: "Rabbit", role: "character", referenceUse: "subject", sourceOf: "explicit anatomy", note: "local-only body-state detail", dataUrls: [] });
  assert.match(prompt, /Analysis channel: local/);
  assert.match(prompt, /NSFW, anatomical, sexual-state/);
  assert.match(prompt, /do not euphemize, moralize, or omit/i);
  assert.match(prompt, /Use this asset as the source of: explicit anatomy/);
});

test("single-shot recipe embeds durable metadata and categorically forbids edited coverage", () => {
  const prompt = buildSingleShotPrompt(
    "Rabbit walks left to right through the landscape.",
    10,
    [{ id: "rabbit", name: "rabbit.png", kind: "image", canonicalName: "Rabbit", role: "character", referenceUse: "subject", sourceOf: "identity and wardrobe", note: "drunk and happy", localSourceOf: "explicit anatomy", localNote: "use direct anatomical language" }],
    [{ assetId: "rabbit", channel: "strong", summary: "Precise identity.", subjects: [], setting: "", style: "", composition: "", motion: "", continuityLocks: [], usableAs: [] }, { assetId: "rabbit", channel: "local", summary: "Direct anatomical evidence.", subjects: [], setting: "", style: "", composition: "", motion: "", continuityLocks: [], usableAs: [] }],
    [{ assetId: "rabbit", label: "<Picture 1>", name: "rabbit.png", kind: "image", referenceUse: "subject", standaloneEntry: false }],
    [{ label: "<Subject 1>", canonicalName: "Rabbit", role: "character", assetIds: ["rabbit"], attachmentLabels: ["<Picture 1>"] }],
    ["reference generation"],
  );
  assert.match(prompt, /one uninterrupted camera take/i);
  assert.match(prompt, /No cuts, cutaways, inserts, reaction shots, reverse angles, coverage, montage/);
  assert.match(prompt, /Use exactly one structural marker, \[Shot 1\], exactly once/);
  assert.match(prompt, /"canonicalName": "Rabbit"/);
  assert.match(prompt, /"localSourceOf": "explicit anatomy"/);
  assert.match(prompt, /"channel": "strong"/);
  assert.match(prompt, /"channel": "local"/);
  assert.match(prompt, /Neither channel overwrites the other/);
  assert.match(prompt, /NSFW observations/);
  assert.match(prompt, /<Picture 1>/);
  assert.match(prompt, /Create a separate <Picture N> definition and retention line ONLY/);
  assert.match(prompt, /A marker is never sufficient by itself/);
  assert.match(prompt, /For attribute_transfer, state exactly which attributes transfer/);
  assert.match(prompt, /Begin summary with exactly \[reference generation\]/);
  assert.match(prompt, /normally 350-500 English words/);
  assert.doesNotMatch(prompt, /scene planner|neighboring generation|\{\{\w+\}\}/i);
});
