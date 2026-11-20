import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_JOB_SETTINGS, sealJobZip } from "../lib/job-bundle.ts";
import { compileAttachments } from "../lib/single-h3.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(root, "tests/fixtures/dummyplug-h3-job-v2.dummyjob.zip");

const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAI0lEQVR4nGP8//8/AymAhSTVDKMaiAMsRKqDg1ENxACSQwkAg10DO7J+0fsAAAAASUVORK5CYII=", "base64"));
const mp4 = Uint8Array.from(Buffer.from("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", "base64"));

const base = {
  size: 0, previewUrl: "", selected: true, declaredIdentity: "", note: "",
  analysis: undefined, localAnalysis: undefined, missingFile: false,
  localSourceOf: "", localNote: "",
};
const assets = [
  { ...base, id: "fixture-rabbit", name: "rabbit.png", kind: "image", mimeType: "image/png", canonicalName: "Rabbit", declaredIdentity: "transgender woman", role: "character", referenceUse: "subject", sourceOf: "actor identity and appearance", sourceWidth: 16, sourceHeight: 16, size: png.byteLength },
  { ...base, id: "fixture-rooftop", name: "rooftop.png", kind: "image", mimeType: "image/png", canonicalName: "Rooftop", role: "setting", referenceUse: "frame-anchor", sourceOf: "opening frame and scene", sourceWidth: 16, sourceHeight: 16, size: png.byteLength },
  { ...base, id: "fixture-walk", name: "walk.mp4", kind: "video", mimeType: "video/mp4", canonicalName: "Walking performance", role: "motion", referenceUse: "video-structure", sourceOf: "walking timing and camera path", sourceWidth: 16, sourceHeight: 16, sourceDuration: 1, trimStart: 0.25, trimEnd: 0.75, size: mp4.byteLength },
];
const compiled = compileAttachments(assets);
const prompt = [
  "subject_definitions:",
  "<Subject 1> is Rabbit, a transgender woman whose actor identity and appearance come from <Picture 1>.",
  "<Subject 2> is the rooftop scene derived from <Picture 2>.",
  "<Picture 2>: opening frame anchor for the rooftop composition.",
  "<Subject 3> is the walking performance abstracted from <Video 1>.",
  "<Video 1>: structural reference for walking timing and the continuous camera path.",
  "summary:",
  "[reference generation + keyframe completion] Rabbit crosses the rooftop in one continuous take.",
  "retention_analysis:",
  "<Subject 1> (appears in [Shot 1]): fully_preserved - retain Rabbit's identity, silhouette, and wardrobe.",
  "<Subject 2> (appears in [Shot 1]): fully_preserved - retain the rooftop geometry, horizon, and lighting.",
  "<Picture 2> (anchors [Shot 1]): fully_preserved - retain the opening composition and spatial layout.",
  "<Subject 3> (applied in [Shot 1]): attribute_transfer - transfer the measured walking performance without copying its source actor.",
  "<Video 1> (structures [Shot 1]): attribute_transfer - transfer the trimmed pacing and camera path without copying source scenery.",
  "detailed_description:",
  "[Shot 1] In one uninterrupted take, Rabbit walks across the rooftop while the camera follows at a steady distance.",
  "overall_soundscape:",
  "Continuous rooftop ambience and synchronized footsteps.",
  "non_diegetic_music:",
  "N/A",
].join("\n");

const sidecars = new Map(assets.map((asset) => [asset.id, JSON.stringify({
  schema: "dummyplug.asset.v4",
  assetId: asset.id,
  source: { name: asset.name, size: asset.size, mimeType: asset.mimeType },
  metadata: { canonicalName: asset.canonicalName, declaredIdentity: asset.declaredIdentity, role: asset.role, referenceUse: asset.referenceUse, sourceOf: asset.sourceOf, note: asset.note },
  updatedAt: "2026-11-20T20:00:00.000Z",
}, null, 2)]));

const result = await sealJobZip({
  assets,
  files: new Map([[assets[0].id, png], [assets[1].id, png], [assets[2].id, mp4]]),
  sidecars,
  prompt,
  request: "Manually authored final H3 prompt.",
  duration: 5,
  settings: { ...DEFAULT_JOB_SETTINGS, seed: 123456789 },
  subjects: compiled.subjects,
  now: new Date("2026-11-20T20:00:00.000Z"),
  jobId: "Rabbitcr_89abcdef",
  projectName: "Unit05 compatibility",
  jobDesc: "Rabbit crosses rooftop",
  requireNonDiegeticMusicNA: true,
});

await mkdir(dirname(output), { recursive: true });
await writeFile(output, result.bytes);
process.stdout.write(`${output}\n`);
