import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import JSZip from "jszip";
import { DEFAULT_JOB_SETTINGS, DUMMYPLUG_JOB_SCHEMA, normalizeJobSettings, randomSeed, sealJobZip, sha256Hex, validateJobSettings, validateManifestV2, validateVideoTrim } from "../lib/job-bundle.ts";
import { compileAttachments } from "../lib/single-h3.ts";
import { DIRECTOR_INPUT_SCALING_OPTIONS } from "../lib/types.ts";

const base = { size: 4, previewUrl: "blob:test", selected: true, note: "", analysis: undefined, missingFile: false, role: "general", referenceUse: "subject", sourceOf: "visual authority" };
const assets = [
  { ...base, id: "portrait", name: "rabbit front.png", kind: "image", mimeType: "image/png", canonicalName: "Rabbit", sourceWidth: 768, sourceHeight: 1344 },
  { ...base, id: "landscape", name: "roof.png", kind: "image", mimeType: "image/png", canonicalName: "Rooftop", sourceWidth: 1344, sourceHeight: 768 },
  { ...base, id: "performance", name: "performance.mov", kind: "video", mimeType: "video/quicktime", canonicalName: "Rabbit motion", sourceWidth: 768, sourceHeight: 1344, sourceDuration: 11.083333, trimStart: 1, trimEnd: 5, referenceUse: "video-structure" },
];

function validPrompt() {
  return [
    "subject_definitions:",
    "<Subject 1> is Rabbit from <Picture 1>.",
    "<Subject 2> is the rooftop from <Picture 2>.",
    "<Subject 3> is motion from <Video 1>.",
    "<Video 1> supplies continuous motion structure.",
    "summary:",
    "[reference generation] Rabbit crosses the rooftop.",
    "retention_analysis:",
    "<Subject 1> (appears in [Shot 1]): fully_preserved - retain Rabbit identity and proportions.",
    "<Subject 2> (appears in [Shot 1]): fully_preserved - retain rooftop geometry and light.",
    "<Subject 3> (applied in [Shot 1]): attribute_transfer - transfer physical walking motion without copying scenery.",
    "<Video 1> (camera structure in [Shot 1]): attribute_transfer - transfer continuous pacing without copying source subjects.",
    "detailed_description:",
    "[Shot 1] One uninterrupted camera take follows Rabbit across the rooftop while all reference labels remain active.",
    "overall_soundscape:",
    "Continuous rooftop ambience and synchronized footsteps.",
    "non_diegetic_music:",
    "N/A",
  ].join("\n");
}

test("fixed and randomized seeds resolve to safe integers", () => {
  assert.equal(DEFAULT_JOB_SETTINGS.seed, 616271471367168);
  for (let index = 0; index < 10; index += 1) {
    const seed = randomSeed();
    assert.equal(Number.isSafeInteger(seed), true);
    assert.ok(seed >= 0);
  }
});

test("input scaling exactly mirrors MiniMax H3 Director", () => {
  assert.deepEqual(DIRECTOR_INPUT_SCALING_OPTIONS.map((option) => option.value), [
    "Off",
    "Auto",
    "Target",
    "Fit",
    "Fill and crop",
    "Fit and pad",
    "Long side with divisible crop",
  ]);
  assert.equal(DEFAULT_JOB_SETTINGS.refImageSize, "max");
  assert.equal(DEFAULT_JOB_SETTINGS.inputScaling, "Auto");
  assert.equal(DEFAULT_JOB_SETTINGS.outputContainer, "mp4");
  assert.equal(DEFAULT_JOB_SETTINGS.audioCodec, "aac");
  for (const { value } of DIRECTOR_INPUT_SCALING_OPTIONS) {
    assert.deepEqual(validateJobSettings({ ...DEFAULT_JOB_SETTINGS, inputScaling: value }, 5), []);
  }
  assert.match(validateJobSettings({ ...DEFAULT_JOB_SETTINGS, inputScaling: "native" }, 5).join(" "), /Input scaling/);
});

test("v2 output geometry and duration match the Unit05 execution contract", () => {
  assert.deepEqual(validateJobSettings({ ...DEFAULT_JOB_SETTINGS, width: 768, height: 1344 }, 5), []);
  assert.match(validateJobSettings({ ...DEFAULT_JOB_SETTINGS, width: 770 }, 5).join(" "), /multiple of 16/);
  assert.match(validateJobSettings({ ...DEFAULT_JOB_SETTINGS, height: 1350 }, 5).join(" "), /multiple of 16/);
  assert.match(validateJobSettings(DEFAULT_JOB_SETTINGS, 5.5).join(" "), /whole number/);
  assert.match(validateJobSettings({ ...DEFAULT_JOB_SETTINGS, outputQuality: 21.5 }, 5).join(" "), /whole number/);
});

test("legacy combined scaling selections migrate to split settings", () => {
  assert.deepEqual(
    { refImageSize: normalizeJobSettings({ inputScaling: "match" }).refImageSize, inputScaling: normalizeJobSettings({ inputScaling: "match" }).inputScaling },
    { refImageSize: "max", inputScaling: "Auto" },
  );
  assert.deepEqual(
    { refImageSize: normalizeJobSettings({ inputScaling: "max" }).refImageSize, inputScaling: normalizeJobSettings({ inputScaling: "max" }).inputScaling },
    { refImageSize: "max", inputScaling: "Auto" },
  );
  assert.equal(normalizeJobSettings({ inputScaling: "native" }).inputScaling, "Auto");
  assert.equal(normalizeJobSettings({ inputScaling: "fit" }).inputScaling, "Fit");
  assert.equal(normalizeJobSettings({ inputScaling: "fill" }).inputScaling, "Fill and crop");
  assert.deepEqual(
    (({ refImageSize, inputScaling, outputContainer, audioCodec }) => ({ refImageSize, inputScaling, outputContainer, audioCodec }))(
      normalizeJobSettings({ defaultsVersion: 1, refImageSize: "match", inputScaling: "Auto", outputContainer: "webm", audioCodec: "opus" }),
    ),
    { refImageSize: "max", inputScaling: "Auto", outputContainer: "mp4", audioCodec: "aac" },
  );
  assert.deepEqual(
    (({ refImageSize, inputScaling, outputContainer, audioCodec }) => ({ refImageSize, inputScaling, outputContainer, audioCodec }))(
      normalizeJobSettings({ defaultsVersion: 2, refImageSize: "match", inputScaling: "Fit", outputContainer: "mov", audioCodec: "opus" }),
    ),
    { refImageSize: "max", inputScaling: "Fit", outputContainer: "mov", audioCodec: "aac" },
  );
});

test("video trim validation enforces known source duration", () => {
  assert.equal(validateVideoTrim(assets[2]), null);
  assert.match(validateVideoTrim({ ...assets[2], trimStart: 5, trimEnd: 5 }), /start < end/);
  assert.match(validateVideoTrim({ ...assets[2], trimEnd: 12 }), /exceeds source duration/);
});

test("the no-music checkbox blocks sealing unless the final section is N/A", async () => {
  const compiled = compileAttachments(assets);
  const input = {
    assets,
    files: new Map(assets.map((asset, index) => [asset.id, new Uint8Array([index, 7, 8, 9])])),
    sidecars: new Map(),
    prompt: validPrompt().replace("non_diegetic_music:\nN/A", "non_diegetic_music:\nlow strings"),
    request: "one take",
    duration: 5,
    settings: DEFAULT_JOB_SETTINGS,
    subjects: compiled.subjects,
    requireNonDiegeticMusicNA: true,
  };
  await assert.rejects(sealJobZip(input), /non_diegetic_music must be N\/A/);
  await assert.doesNotReject(sealJobZip({ ...input, requireNonDiegeticMusicNA: false }));
});

test("cast policy blocks sealing when a character Subject omits its required identity", async () => {
  const characterAssets = assets.map((asset, index) => index === 0 ? { ...asset, role: "character", declaredIdentity: "" } : asset);
  const compiled = compileAttachments(characterAssets);
  const input = {
    assets: characterAssets,
    files: new Map(characterAssets.map((asset, index) => [asset.id, new Uint8Array([index, 7, 8, 9])])),
    sidecars: new Map(), prompt: validPrompt(), request: "one take", duration: 5,
    settings: DEFAULT_JOB_SETTINGS, subjects: compiled.subjects,
  };
  await assert.rejects(sealJobZip(input), /Cast lock identity is missing/);
  await assert.doesNotReject(sealJobZip({ ...input, prompt: validPrompt().replace("<Subject 1> is Rabbit", "<Subject 1> is a transgender woman named Rabbit") }));
});

test("a randomized seed is resolved into the sealed manifest", async () => {
  const seed = randomSeed();
  const compiled = compileAttachments(assets);
  const result = await sealJobZip({
    assets,
    files: new Map(assets.map((asset, index) => [asset.id, new Uint8Array([index, 7, 8, 9])])),
    sidecars: new Map(assets.map((asset) => [asset.id, JSON.stringify({ asset_id: asset.id })])),
    prompt: validPrompt(), request: "one take", duration: 5,
    settings: { ...DEFAULT_JOB_SETTINGS, seed }, subjects: compiled.subjects,
  });
  assert.equal(result.manifest.generation.seed, seed);
  assert.equal(Number.isSafeInteger(result.manifest.generation.seed), true);
});

test("seals an independently verifiable REF2VA job archive", async () => {
  const compiled = compileAttachments(assets);
  assert.deepEqual(compiled.attachments.map(({ assetId, label }) => ({ assetId, label })), [
    { assetId: "portrait", label: "<Picture 1>" },
    { assetId: "landscape", label: "<Picture 2>" },
    { assetId: "performance", label: "<Video 1>" },
  ]);
  const files = new Map(assets.map((asset, index) => [asset.id, new Uint8Array([index, 2, 3, 4])]));
  const sidecars = new Map(assets.map((asset) => [asset.id, JSON.stringify({ schema: "dummyplug.asset.v3", source: { name: asset.name } })]));
  const result = await sealJobZip({
    assets,
    files,
    sidecars,
    prompt: validPrompt(),
    request: "Rabbit crosses the rooftop in one long take.",
    duration: 5,
    settings: { ...DEFAULT_JOB_SETTINGS, width: 768, height: 1344, fps: 24, seed: 123456 },
    subjects: compiled.subjects,
    jobId: "11111111-2222-4333-8444-555555555555",
    projectName: "Rabbit project",
    jobDesc: "Rabbit walk",
    now: new Date("2026-08-25T12:00:00.000Z"),
  });
  const zip = await JSZip.loadAsync(result.bytes);
  const paths = Object.keys(zip.files).filter((path) => !zip.files[path].dir).sort();
  assert.ok(paths.includes("manifest.json"));
  assert.ok(paths.includes("prompt.txt"));
  assert.ok(paths.includes("request.txt"));
  assert.ok(paths.includes("reference-map.json"));
  assert.ok(paths.includes("checksums.json"));
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal(manifest.schema, DUMMYPLUG_JOB_SCHEMA);
  assert.deepEqual(validateManifestV2(manifest), []);
  assert.equal(manifest.job_id, "11111111-2222-4333-8444-555555555555");
  assert.equal(manifest.job_desc, "Rabbit walk");
  assert.equal(manifest.title, "Rabbit project");
  assert.deepEqual(manifest.workflow, { template: "dasiwa-ref2va", version: 1 });
  assert.deepEqual(manifest.prompt_policy, DEFAULT_JOB_SETTINGS.characterPolicy);
  assert.deepEqual(manifest.generation, {
    width: 768, height: 1344, duration: 5, fps: 24, seed: 123456, steps: 25, sampler: "res_multistep", shift_video: 12, shift_audio: 3, ref_image_size: "max", input_scaling: "Auto",
    output: { container: "mp4", codec: "Auto", quality: 21, audio_codec: "aac", audio_bitrate: "192k" },
  });
  assert.deepEqual(manifest.references.map(({ asset_id, order, label }) => ({ asset_id, order, label })), [
    { asset_id: "portrait", order: 0, label: "<Picture 1>" },
    { asset_id: "landscape", order: 1, label: "<Picture 2>" },
    { asset_id: "performance", order: 2, label: "<Video 1>" },
  ]);
  assert.equal(manifest.references[2].trim_start, 1);
  assert.equal(manifest.references[2].trim_end, 5);
  for (const reference of manifest.references) assert.ok(zip.file(reference.path), reference.path);

  const checksums = JSON.parse(await zip.file("checksums.json").async("string"));
  assert.deepEqual(Object.keys(checksums).sort(), paths.filter((path) => path !== "checksums.json").sort());
  for (const [path, checksum] of Object.entries(checksums)) {
    assert.equal(await sha256Hex(await zip.file(path).async("uint8array")), checksum, path);
  }
  const allText = await Promise.all(paths.filter((path) => /\.(json|txt)$/.test(path)).map((path) => zip.file(path).async("string")));
  const archiveText = allText.join("\n");
  assert.doesNotMatch(archiveText, /C:\\Users\\|sk-or-v1-|apiKey|Authorization/i);
});

test("v2 manifest validation enforces sequential H3 labels and executable reference metadata", async () => {
  const compiled = compileAttachments(assets);
  const result = await sealJobZip({
    assets,
    files: new Map(assets.map((asset, index) => [asset.id, new Uint8Array([index, 2, 3, 4])])),
    sidecars: new Map(), prompt: validPrompt(), request: "one take", duration: 5,
    settings: DEFAULT_JOB_SETTINGS, subjects: compiled.subjects,
    jobId: "manifest-test", jobDesc: "Manifest test", now: new Date("2026-11-20T20:00:00.000Z"),
  });
  const invalid = structuredClone(result.manifest);
  invalid.references[0].label = "<Picture 9>";
  invalid.references[2].trim_end = 99;
  assert.match(validateManifestV2(invalid).join(" "), /invalid H3 label/);
  assert.match(validateManifestV2(invalid).join(" "), /trim_start < trim_end <= source_duration/);
  const incomplete = structuredClone(result.manifest);
  delete incomplete.prompt_policy;
  delete incomplete.generation.output;
  assert.match(validateManifestV2(incomplete).join(" "), /prompt_policy/);
  assert.match(validateManifestV2(incomplete).join(" "), /Output container is required/);
});

test("fixed v2 inputs produce byte-identical ZIP archives", async () => {
  const compiled = compileAttachments(assets);
  const input = {
    assets,
    files: new Map(assets.map((asset, index) => [asset.id, new Uint8Array([index, 2, 3, 4])])),
    sidecars: new Map(), prompt: validPrompt(), request: "one take", duration: 5,
    settings: DEFAULT_JOB_SETTINGS, subjects: compiled.subjects,
    jobId: "deterministic-test", jobDesc: "Deterministic test", now: new Date("2026-11-20T20:00:00.000Z"),
  };
  const first = await sealJobZip(input);
  const second = await sealJobZip(input);
  assert.deepEqual(first.bytes, second.bytes);
});

test("committed Unit05 compatibility fixture is a sealed v2 bundle", async () => {
  const bytes = new Uint8Array(await readFile(new URL("./fixtures/dummyplug-h3-job-v2.dummyjob.zip", import.meta.url)));
  assert.equal(await sha256Hex(bytes), "3cd516c17882a607804bfb7b11e004786f0f672cde3dbef7087f6a54e548ec2b");
  const zip = await JSZip.loadAsync(bytes);
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.deepEqual(validateManifestV2(manifest), []);
  assert.equal(manifest.references.length, 3);
  assert.deepEqual(manifest.references.map(({ label, order }) => ({ label, order })), [
    { label: "<Picture 1>", order: 0 },
    { label: "<Picture 2>", order: 1 },
    { label: "<Video 1>", order: 2 },
  ]);
  assert.equal(manifest.references[2].trim_start, 0.25);
  assert.equal(manifest.references[2].trim_end, 0.75);
  assert.equal(await zip.file("request.txt").async("string"), "Manually authored final H3 prompt.");
});
