import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalDirtyProbePrompt, buildLocalDirtyScanPrompt, buildSingleShotPrompt, buildVisionPrompt, EXPOSED_PROMPT_TEMPLATES, selectVisionAnalysisRole, visionTemplateId } from "../lib/single-prompts.ts";

test("exposes strong vision, local dirty-focus, single-shot, and connection recipes", () => {
  assert.deepEqual(EXPOSED_PROMPT_TEMPLATES.map((item) => item.id), ["vision-character", "vision-setting", "vision-style", "vision-general", "vision-local-dirty", "vision-local-probe", "single-shot", "connection-probe"]);
});

test("manual role and source-of metadata route and enter the vision recipe", () => {
  const reference = { assetId: "rabbit", name: "rabbit.png", kind: "image", canonicalName: "Rabbit", declaredIdentity: "transgender woman; she/her", role: "character", referenceUse: "subject", sourceOf: "face, body, wardrobe, drunk happy expression", note: "main character", dataUrls: [] };
  assert.equal(selectVisionAnalysisRole(reference), "character");
  assert.equal(visionTemplateId("character"), "vision-character");
  const prompt = buildVisionPrompt(reference);
  assert.match(prompt, /Canonical name: Rabbit/);
  assert.match(prompt, /Declared identity.*transgender woman; she\/her/);
  assert.match(prompt, /source of: face, body, wardrobe, drunk happy expression/i);
  assert.match(prompt, /minute visible identity evidence/i);
  assert.doesNotMatch(prompt, /{{\w+}}/);
});

test("local dirty scan is narrow and preserves authored identity authority", () => {
  const prompt = buildLocalDirtyScanPrompt({ assetId: "rabbit", analysisChannel: "local", name: "rabbit.png", kind: "image", canonicalName: "Rabbit", declaredIdentity: "transgender woman; she/her", role: "character", referenceUse: "subject", sourceOf: "explicit anatomy", note: "local-only body-state detail", dataUrls: [], focusTerms: ["target one"] }, 1, 1);
  assert.match(prompt, /Do not write a general caption/);
  assert.match(prompt, /Declared identity.*transgender woman; she\/her/);
  assert.match(prompt, /location, appearance, and qualities/i);
  assert.match(prompt, /Local source authority: explicit anatomy/);
});

test("Dirty Focus terms become deterministic local targets but never enter the strong vision prompt", () => {
  const shared = { assetId: "rabbit", name: "rabbit.png", kind: "image", canonicalName: "Rabbit", declaredIdentity: "transgender woman", role: "character", referenceUse: "subject", sourceOf: "identity", note: "", dataUrls: [], focusTerms: ["private target", "specific phrase"] };
  const localPrompt = buildLocalDirtyScanPrompt({ ...shared, analysisChannel: "local" }, 1, 1);
  const strongPrompt = buildVisionPrompt({ ...shared, analysisChannel: "strong" });
  assert.match(localPrompt, /Dirty Focus terms/);
  assert.match(localPrompt, /"private target"/);
  assert.match(localPrompt, /location, appearance, and qualities/i);
  assert.doesNotMatch(strongPrompt, /private target|specific phrase|dirty-focus inspection/i);
  assert.match(buildLocalDirtyProbePrompt({ ...shared, analysisChannel: "local" }, "private target", 1, 1), /Target term: private target/);
});

test("single-shot recipe embeds durable metadata and categorically forbids edited coverage", () => {
  const prompt = buildSingleShotPrompt(
    "Rabbit walks left to right through the landscape.",
    10,
    [{ id: "rabbit", name: "rabbit.png", kind: "image", canonicalName: "Rabbit", declaredIdentity: "", resolvedDeclaredIdentity: "transgender woman; she/her", role: "character", referenceUse: "subject", sourceOf: "identity and wardrobe", note: "drunk and happy", localSourceOf: "explicit anatomy", localNote: "use direct anatomical language" }],
    [{ assetId: "rabbit", channel: "strong", summary: "Precise identity.", subjects: [], setting: "", style: "", composition: "", motion: "", continuityLocks: [], usableAs: [] }, { assetId: "rabbit", channel: "local", summary: "Direct anatomical evidence.", subjects: [], setting: "", style: "", composition: "", motion: "", continuityLocks: [], usableAs: [] }],
    [{ assetId: "rabbit", label: "<Picture 1>", name: "rabbit.png", kind: "image", referenceUse: "subject", standaloneEntry: false }],
    [{ label: "<Subject 1>", canonicalName: "Rabbit", role: "character", assetIds: ["rabbit"], attachmentLabels: ["<Picture 1>"] }],
    ["reference generation"],
    undefined,
    { allCharactersTransgenderWomen: true, allowedVocabulary: { man: false, woman: true, trans: true, futa: true } },
  );
  assert.match(prompt, /one uninterrupted camera take/i);
  assert.match(prompt, /No cuts, cutaways, inserts, reaction shots, reverse angles, coverage, montage/);
  assert.match(prompt, /Use exactly one structural marker, \[Shot 1\], exactly once/);
  assert.match(prompt, /"canonicalName": "Rabbit"/);
  assert.match(prompt, /"localSourceOf": "explicit anatomy"/);
  assert.match(prompt, /"allCharactersTransgenderWomen": true/);
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
