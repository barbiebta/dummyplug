import assert from "node:assert/strict";
import test from "node:test";
import { compileAttachments, validateSingleShotPrompt } from "../lib/single-h3.ts";
import { replaceFilenameReferences } from "../lib/single-provider.ts";

const base = { size: 1, previewUrl: "blob:test", selected: true, note: "", analysis: undefined, missingFile: false };
const assets = [
  { ...base, id: "rabbit-front", name: "rabbit-front.png", kind: "image", mimeType: "image/png", canonicalName: "Rabbit", role: "character", referenceUse: "subject", sourceOf: "face, front view, wardrobe" },
  { ...base, id: "rabbit-side", name: "rabbit-side.png", kind: "image", mimeType: "image/png", canonicalName: "Rabbit", role: "character", referenceUse: "subject", sourceOf: "profile, ears, body proportions" },
  { ...base, id: "rabbit-walk", name: "rabbit-walk.mp4", kind: "video", mimeType: "video/mp4", canonicalName: "Rabbit", role: "motion", referenceUse: "subject", sourceOf: "walking action" },
  { ...base, id: "camera-path", name: "camera-path.mp4", kind: "video", mimeType: "video/mp4", canonicalName: "Lateral camera path", role: "motion", referenceUse: "video-structure", sourceOf: "continuous camera movement and pacing, never its cuts" },
];

test("numbers physical references by type while grouping same-name visible content into one Subject", () => {
  const compiled = compileAttachments(assets);
  assert.deepEqual(compiled.attachments.map((item) => item.label), ["<Picture 1>", "<Picture 2>", "<Video 1>", "<Video 2>"]);
  assert.deepEqual(compiled.attachments.map((item) => item.standaloneEntry), [false, false, false, true]);
  assert.deepEqual(compiled.subjects, [
    { label: "<Subject 1>", canonicalName: "Rabbit", role: "character", assetIds: ["rabbit-front", "rabbit-side", "rabbit-walk"], attachmentLabels: ["<Picture 1>", "<Picture 2>", "<Video 1>"] },
    { label: "<Subject 2>", canonicalName: "Lateral camera path", role: "motion", assetIds: ["camera-path"], attachmentLabels: ["<Video 2>"] },
  ]);
  assert.deepEqual(compiled.taskTypes, ["reference generation"]);
  assert.deepEqual(compiled.warnings, []);
});

test("creates a safe per-asset Subject for an unnamed selected video", () => {
  const unnamedVideo = { ...base, id: "new-video", name: "new-video.mov", kind: "video", mimeType: "", canonicalName: "", role: "general", referenceUse: "subject", sourceOf: "" };
  const compiled = compileAttachments([unnamedVideo]);
  assert.deepEqual(compiled.subjects, [
    { label: "<Subject 1>", canonicalName: "new-video.mov", role: "general", assetIds: ["new-video"], attachmentLabels: ["<Video 1>"] },
  ]);
});

test("obliterates exact filenames into assigned H3 labels", () => {
  const compiled = compileAttachments(assets);
  const cleaned = replaceFilenameReferences("Use rabbit-front.png and RABBIT-WALK.MP4; never expose camera-path.mp4.", compiled.attachments);
  assert.equal(cleaned, "Use <Picture 1> and <Video 1>; never expose <Video 2>.");
});

test("validates source-only labels, structural entries, six sections, and exactly one shot", () => {
  const compiled = compileAttachments(assets);
  const prompt = [
    "subject_definitions:",
    "<Subject 1> is Rabbit, using appearance from <Picture 1> and <Picture 2> and walking action from <Video 1>.",
    "<Subject 2> is the continuous lateral camera movement abstracted from <Video 2>.",
    "<Video 2> provides the whole-take camera path and pacing structure without importing cuts.",
    "summary:",
    "[reference generation] Rabbit walks through one uninterrupted lateral take.",
    "retention_analysis:",
    "<Subject 1> (appears in [Shot 1]): fully_preserved - identity and action stay coherent.",
    "<Subject 2> (applied in [Shot 1]): attribute_transfer - the camera motion is applied continuously.",
    "<Video 2> (camera path): weak_reference - pacing is retained without cuts.",
    "detailed_description:",
    "[Shot 1] One uninterrupted lateral track follows Rabbit in real time.",
    "overall_soundscape:",
    "Continuous ambience and synchronized footsteps.",
    "non_diegetic_music:",
    "N/A",
  ].join("\n");
  assert.equal(validateSingleShotPrompt(prompt, compiled.attachments, compiled.subjects).valid, true);
  const colonDefinition = prompt.replace("<Video 2> provides", "<Video 2>: provides");
  assert.equal(validateSingleShotPrompt(colonDefinition, compiled.attachments, compiled.subjects).valid, true);
  assert.equal(validateSingleShotPrompt(`${prompt}\n[Shot 2] cutaway`, compiled.attachments, compiled.subjects).valid, false);

  const wrongStandalonePicture = prompt.replace("<Subject 1> is Rabbit", "<Picture 1> is a character appearance source.\n<Subject 1> is Rabbit");
  const result = validateSingleShotPrompt(wrongStandalonePicture, compiled.attachments, compiled.subjects);
  assert.deepEqual(result.sourceOnlyStandaloneDefinitions, ["<Picture 1>"]);
  assert.equal(result.valid, false);

  const bareTransfer = prompt.replace("attribute_transfer - the camera motion is applied continuously.", "attribute_transfer");
  const bareResult = validateSingleShotPrompt(bareTransfer, compiled.attachments, compiled.subjects);
  assert.deepEqual(bareResult.retentionDescriptionMissing, ["<Subject 2>"]);
  assert.equal(bareResult.valid, false);

  const wrappedDescription = prompt.replace("attribute_transfer - the camera motion", "attribute_transfer -\nthe camera motion");
  assert.equal(validateSingleShotPrompt(wrappedDescription, compiled.attachments, compiled.subjects).valid, true);
});

test("derives official task types from explicit H3 uses", () => {
  const compiled = compileAttachments([
    { ...assets[0], referenceUse: "frame-anchor" },
    { ...base, id: "audio", name: "voice.wav", kind: "audio", mimeType: "audio/wav", canonicalName: "Rabbit voice", role: "audio", referenceUse: "audio-reference", sourceOf: "voice timbre" },
  ]);
  assert.deepEqual(compiled.taskTypes, ["keyframe completion", "audio reference"]);
  assert.equal(compiled.attachments[0].standaloneEntry, true);
  assert.equal(compiled.attachments[1].standaloneEntry, true);
});
