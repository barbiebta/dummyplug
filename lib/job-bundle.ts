import JSZip from "jszip";
import { compileAttachments, hasNonDiegeticMusicNA, validateSingleShotPrompt } from "./single-h3.ts";
import { validateCharacterPolicy } from "./character-policy.ts";
import { DIRECTOR_INPUT_SCALING_OPTIONS } from "./types.ts";
import type { AssetRecord, JobSettings, SubjectSpec } from "./types.ts";

type BinarySource = Blob | ArrayBuffer | Uint8Array;

export const DUMMYPLUG_JOB_SCHEMA = "dummyplug.h3-job.v2" as const;
export const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface SealJobInput {
  assets: AssetRecord[];
  files: Map<string, BinarySource>;
  sidecars: Map<string, string>;
  prompt: string;
  request: string;
  duration: number;
  settings: JobSettings;
  subjects: SubjectSpec[];
  now?: Date;
  jobId?: string;
  /** Human-readable project title copied into the immutable manifest. */
  projectName?: string;
  /** Human-readable per-job description used to derive the job ID. */
  jobDesc?: string;
  /** When true, sealing requires the explicit no-music value in the final prompt. */
  requireNonDiegeticMusicNA?: boolean;
}

export const DEFAULT_JOB_SETTINGS: JobSettings = {
  defaultsVersion: 3,
  title: "",
  width: 768,
  height: 1344,
  fps: 24,
  seed: 616271471367168,
  steps: 25,
  sampler: "res_multistep",
  shiftVideo: 12,
  shiftAudio: 3,
  refImageSize: "max",
  inputScaling: "Auto",
  outputContainer: "mp4",
  outputCodec: "Auto",
  outputQuality: 21,
  audioCodec: "aac",
  audioBitrate: "192k",
  workflowPreset: "dasiwa-ref2va:v1",
  characterPolicy: {
    allCharactersTransgenderWomen: true,
    allowedVocabulary: { man: false, woman: true, trans: true, futa: true },
  },
};

const DIRECTOR_INPUT_SCALING_VALUES = new Set<string>(DIRECTOR_INPUT_SCALING_OPTIONS.map((option) => option.value));
const LEGACY_INPUT_SCALING: Record<string, JobSettings["inputScaling"]> = {
  match: "Auto",
  max: "Auto",
  native: "Auto",
  fit: "Fit",
  fill: "Fill and crop",
  "720": "Auto",
  "1024": "Auto",
  "Native (ShortEdge 2048px)": "Auto",
  "Target · Selected Aspect & Resolution": "Target",
};

export function normalizeJobSettings(saved?: unknown): JobSettings {
  const raw = saved && typeof saved === "object" ? saved as Record<string, unknown> : {};
  const migrateOutputDefaults = Number(raw.defaultsVersion || 0) < DEFAULT_JOB_SETTINGS.defaultsVersion;
  const rawScaling = String(raw.inputScaling ?? DEFAULT_JOB_SETTINGS.inputScaling);
  let inputScaling = DIRECTOR_INPUT_SCALING_VALUES.has(rawScaling)
    ? rawScaling as JobSettings["inputScaling"]
    : LEGACY_INPUT_SCALING[rawScaling] || DEFAULT_JOB_SETTINGS.inputScaling;
  const legacyRefImageSize = rawScaling === "match" || rawScaling === "max" ? rawScaling : undefined;
  const rawRefImageSize = String(raw.refImageSize ?? legacyRefImageSize ?? DEFAULT_JOB_SETTINGS.refImageSize);
  let refImageSize: JobSettings["refImageSize"] = rawRefImageSize === "max" ? "max" : "match";
  let outputContainer = String(raw.outputContainer ?? DEFAULT_JOB_SETTINGS.outputContainer);
  let audioCodec = String(raw.audioCodec ?? DEFAULT_JOB_SETTINGS.audioCodec);
  if (migrateOutputDefaults) {
    if (["match", "max", "native", "Auto"].includes(rawScaling)) inputScaling = DEFAULT_JOB_SETTINGS.inputScaling;
    if (raw.refImageSize == null || rawRefImageSize === "match") refImageSize = DEFAULT_JOB_SETTINGS.refImageSize;
    if (raw.outputContainer == null || ["Auto", "webm"].includes(outputContainer)) outputContainer = DEFAULT_JOB_SETTINGS.outputContainer;
    if (raw.audioCodec == null || ["Auto", "opus"].includes(audioCodec)) audioCodec = DEFAULT_JOB_SETTINGS.audioCodec;
  }
  const rawPolicy = raw.characterPolicy && typeof raw.characterPolicy === "object" ? raw.characterPolicy as Record<string, unknown> : {};
  const rawVocabulary = rawPolicy.allowedVocabulary && typeof rawPolicy.allowedVocabulary === "object" ? rawPolicy.allowedVocabulary as Record<string, unknown> : {};
  const characterPolicy = {
    allCharactersTransgenderWomen: rawPolicy.allCharactersTransgenderWomen == null ? DEFAULT_JOB_SETTINGS.characterPolicy.allCharactersTransgenderWomen : rawPolicy.allCharactersTransgenderWomen === true,
    allowedVocabulary: {
      man: rawVocabulary.man == null ? DEFAULT_JOB_SETTINGS.characterPolicy.allowedVocabulary.man : rawVocabulary.man === true,
      woman: rawVocabulary.woman == null ? DEFAULT_JOB_SETTINGS.characterPolicy.allowedVocabulary.woman : rawVocabulary.woman === true,
      trans: rawVocabulary.trans == null ? DEFAULT_JOB_SETTINGS.characterPolicy.allowedVocabulary.trans : rawVocabulary.trans === true,
      futa: rawVocabulary.futa == null ? DEFAULT_JOB_SETTINGS.characterPolicy.allowedVocabulary.futa : rawVocabulary.futa === true,
    },
  };
  return { ...DEFAULT_JOB_SETTINGS, ...raw, defaultsVersion: DEFAULT_JOB_SETTINGS.defaultsVersion, refImageSize, inputScaling, outputContainer, audioCodec, characterPolicy } as JobSettings;
}

export function randomSeed() {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  return words[0] * 0x200000 + (words[1] & 0x1fffff);
}

export function validateVideoTrim(asset: AssetRecord) {
  if (asset.kind !== "video") return null;
  const start = Number(asset.trimStart ?? 0);
  const end = Number(asset.trimEnd ?? asset.sourceDuration ?? 0);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return `${asset.name}: trim must satisfy 0 ≤ start < end.`;
  if (asset.sourceDuration != null && end > asset.sourceDuration + 0.000001) return `${asset.name}: trim end exceeds source duration ${asset.sourceDuration.toFixed(3)}s.`;
  return null;
}

export function validateJobSettings(settings: JobSettings, duration: number) {
  const errors: string[] = [];
  if (!Number.isInteger(settings.width) || settings.width < 64 || settings.width > 8192 || settings.width % 16 !== 0) errors.push("Width must be a multiple of 16 from 64 to 8192.");
  if (!Number.isInteger(settings.height) || settings.height < 64 || settings.height > 8192 || settings.height % 16 !== 0) errors.push("Height must be a multiple of 16 from 64 to 8192.");
  if (!Number.isInteger(duration) || duration < 1 || duration > 20) errors.push("Duration must be a whole number from 1 to 20 seconds.");
  if (!Number.isFinite(settings.fps) || settings.fps < 1 || settings.fps > 120) errors.push("FPS must be from 1 to 120.");
  if (!Number.isSafeInteger(settings.seed) || settings.seed < 0) errors.push("Seed must be a non-negative safe integer.");
  if (!Number.isInteger(settings.steps) || settings.steps < 1 || settings.steps > 200) errors.push("Steps must be from 1 to 200.");
  if (!Number.isFinite(settings.shiftVideo)) errors.push("shift_video must be a finite number.");
  if (!Number.isFinite(settings.shiftAudio)) errors.push("shift_audio must be a finite number.");
  if (settings.refImageSize !== "match" && settings.refImageSize !== "max") errors.push("Reference image size must be match or max.");
  if (!DIRECTOR_INPUT_SCALING_VALUES.has(settings.inputScaling)) errors.push("Input scaling must be one of Director's supported modes.");
  if (!Number.isInteger(settings.outputQuality) || settings.outputQuality < 0 || settings.outputQuality > 51) errors.push("Video quality (CRF/CQ) must be a whole number from 0 to 51; lower values preserve more quality.");
  if (!settings.sampler.trim()) errors.push("Sampler is required.");
  if (!settings.outputContainer.trim()) errors.push("Output container is required.");
  if (!settings.outputCodec.trim()) errors.push("Output codec is required.");
  if (!settings.audioCodec.trim()) errors.push("Audio codec is required.");
  if (!settings.audioBitrate.trim()) errors.push("Audio bitrate is required.");
  return errors;
}

function expectedReferenceLabel(kind: AssetRecord["kind"], index: number) {
  return `<${kind === "image" ? "Picture" : kind === "video" ? "Video" : "Audio"} ${index}>`;
}

/**
 * Validate the sealed v2 manifest independently of the editor UI. Unit05 is
 * expected to enforce the same rules before staging any file into ComfyUI.
 */
export function validateManifestV2(manifest: unknown) {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["Manifest must be an object."];
  const value = manifest as Record<string, unknown>;
  if (value.schema !== DUMMYPLUG_JOB_SCHEMA) errors.push(`Schema must be ${DUMMYPLUG_JOB_SCHEMA}.`);
  if (!JOB_ID_PATTERN.test(String(value.job_id ?? ""))) errors.push("job_id is missing or unsafe.");
  const jobDesc = String(value.job_desc ?? "").trim();
  if (!jobDesc || jobDesc.length > 30) errors.push("job_desc must contain 1 to 30 characters.");
  if (typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) errors.push("created_at must be an ISO-8601 timestamp.");

  const workflow = value.workflow as Record<string, unknown> | undefined;
  if (!workflow || workflow.template !== "dasiwa-ref2va" || workflow.version !== 1) errors.push("workflow must be dasiwa-ref2va version 1.");
  const promptPolicy = value.prompt_policy as Record<string, unknown> | undefined;
  const vocabulary = promptPolicy?.allowedVocabulary as Record<string, unknown> | undefined;
  if (!promptPolicy || typeof promptPolicy.allCharactersTransgenderWomen !== "boolean" || !vocabulary || ["man", "woman", "trans", "futa"].some((key) => typeof vocabulary[key] !== "boolean")) errors.push("prompt_policy must contain the cast-lock boolean and all four vocabulary booleans.");
  const generation = value.generation as Record<string, unknown> | undefined;
  if (!generation) errors.push("generation must be an object.");
  else {
    const output = generation.output && typeof generation.output === "object" && !Array.isArray(generation.output) ? generation.output as Record<string, unknown> : {};
    const stringField = (field: unknown) => typeof field === "string" ? field : "";
    const settings = {
      ...DEFAULT_JOB_SETTINGS,
      width: Number(generation.width),
      height: Number(generation.height),
      fps: Number(generation.fps),
      seed: Number(generation.seed),
      steps: Number(generation.steps),
      sampler: stringField(generation.sampler),
      shiftVideo: Number(generation.shift_video),
      shiftAudio: Number(generation.shift_audio),
      refImageSize: stringField(generation.ref_image_size),
      inputScaling: stringField(generation.input_scaling),
      outputContainer: stringField(output.container),
      outputCodec: stringField(output.codec),
      outputQuality: Number(output.quality),
      audioCodec: stringField(output.audio_codec),
      audioBitrate: stringField(output.audio_bitrate),
    } as JobSettings;
    errors.push(...validateJobSettings(settings, Number(generation.duration)));
  }

  const references = value.references;
  if (!Array.isArray(references) || references.length === 0) errors.push("At least one reference is required.");
  else {
    const paths = new Set<string>();
    const assetIds = new Set<string>();
    const counters: Record<AssetRecord["kind"], number> = { image: 0, video: 0, audio: 0 };
    references.forEach((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`Reference ${index} must be an object.`); return; }
      const reference = raw as Record<string, unknown>;
      const kind = reference.kind as AssetRecord["kind"];
      if (!(["image", "video", "audio"] as string[]).includes(kind)) { errors.push(`Reference ${index} has an unsupported kind.`); return; }
      counters[kind] += 1;
      if (reference.order !== index) errors.push(`Reference ${index} order must equal its zero-based array position.`);
      if (reference.label !== expectedReferenceLabel(kind, counters[kind])) errors.push(`Reference ${index} has an invalid H3 label.`);
      const assetId = String(reference.asset_id ?? "").trim();
      if (!assetId) errors.push(`Reference ${index} asset_id is required.`);
      if (assetIds.has(assetId)) errors.push(`Reference ${index} asset_id is duplicated.`);
      assetIds.add(assetId);
      const path = String(reference.path ?? "");
      if (!/^assets\/[A-Za-z0-9._-]+$/.test(path) || path.includes("..") || path.includes("\\")) errors.push(`Reference ${index} path must be a safe POSIX path directly inside assets/.`);
      if (paths.has(path)) errors.push(`Reference ${index} path is duplicated.`);
      paths.add(path);
      if (!SHA256_PATTERN.test(String(reference.sha256 ?? ""))) errors.push(`Reference ${index} sha256 must be lowercase hexadecimal.`);
      if (!Number.isSafeInteger(reference.size) || Number(reference.size) < 0) errors.push(`Reference ${index} size must be a non-negative safe integer.`);
      if (!String(reference.mime_type ?? "").trim()) errors.push(`Reference ${index} mime_type is required.`);
      if (kind !== "audio") {
        if (!Number.isInteger(reference.source_width) || Number(reference.source_width) <= 0) errors.push(`Reference ${index} source_width must be a positive integer.`);
        if (!Number.isInteger(reference.source_height) || Number(reference.source_height) <= 0) errors.push(`Reference ${index} source_height must be a positive integer.`);
      }
      if (kind === "video") {
        const sourceDuration = Number(reference.source_duration);
        const trimStart = Number(reference.trim_start);
        const trimEnd = Number(reference.trim_end);
        if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) errors.push(`Reference ${index} source_duration must be positive.`);
        if (!Number.isFinite(trimStart) || !Number.isFinite(trimEnd) || trimStart < 0 || trimEnd <= trimStart || trimEnd > sourceDuration + 0.000001) errors.push(`Reference ${index} video trim must satisfy 0 <= trim_start < trim_end <= source_duration.`);
      } else if ("trim_start" in reference || "trim_end" in reference) errors.push(`Reference ${index} contains video-only trim fields.`);
    });
  }
  return errors;
}

function safeName(name: string) {
  const normalized = name.normalize("NFKD").replace(/[^a-z0-9._-]+/gi, "_").replace(/^\.+/, "");
  return normalized || "asset";
}

async function bytesOf(source: BinarySource | string) {
  if (typeof source === "string") return new TextEncoder().encode(source);
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(await source.arrayBuffer());
}

export async function sha256Hex(source: BinarySource | string) {
  const bytes = await bytesOf(source);
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sealJobZip(input: SealJobInput) {
  const compiled = compileAttachments(input.assets);
  const errors = [
    ...validateJobSettings(input.settings, input.duration),
    ...input.assets.map(validateVideoTrim).filter((error): error is string => Boolean(error)),
    ...input.assets.flatMap((asset) => {
      const metadataErrors: string[] = [];
      if (!asset.mimeType.trim()) metadataErrors.push(`${asset.name}: MIME type is required.`);
      if (asset.kind !== "audio" && (!Number.isInteger(asset.sourceWidth) || Number(asset.sourceWidth) <= 0 || !Number.isInteger(asset.sourceHeight) || Number(asset.sourceHeight) <= 0)) metadataErrors.push(`${asset.name}: source width and height are required before sealing.`);
      if (asset.kind === "video" && (!Number.isFinite(asset.sourceDuration) || Number(asset.sourceDuration) <= 0)) metadataErrors.push(`${asset.name}: source duration is required before sealing.`);
      return metadataErrors;
    }),
    ...compiled.warnings,
  ];
  const promptValidation = validateSingleShotPrompt(input.prompt, compiled.attachments, input.subjects);
  if (!promptValidation.valid) errors.push("The six-section H3 prompt is not valid for the current reference snapshot.");
  const characterValidation = validateCharacterPolicy(input.prompt, input.subjects, input.settings.characterPolicy);
  if (!characterValidation.valid) {
    if (characterValidation.forbiddenVocabulary.length) errors.push(`Final prompt uses disallowed character vocabulary: ${characterValidation.forbiddenVocabulary.map((item) => item.terms.join(", ")).join("; ")}.`);
    if (characterValidation.missingCastIdentity.length) errors.push(`Cast lock identity is missing from: ${characterValidation.missingCastIdentity.join(", ")}.`);
  }
  if (input.requireNonDiegeticMusicNA && !hasNonDiegeticMusicNA(input.prompt)) errors.push("non_diegetic_music must be N/A while the job checkbox is on.");
  for (const asset of input.assets) if (!input.files.has(asset.id)) errors.push(`${asset.name}: source file is not loaded.`);
  if (errors.length) throw new Error(errors.join(" "));

  const jobId = input.jobId || crypto.randomUUID();
  const createdAt = (input.now || new Date()).toISOString();
  const files = new Map<string, Uint8Array>();
  const references: Array<Record<string, unknown>> = [];

  for (let order = 0; order < compiled.attachments.length; order += 1) {
    const attachment = compiled.attachments[order];
    const asset = input.assets.find((candidate) => candidate.id === attachment.assetId)!;
    const bytes = await bytesOf(input.files.get(asset.id)!);
    const prefix = attachment.label.replace(/[<>]/g, "").replace(/\s+/g, "-").toLocaleLowerCase();
    const path = `assets/${prefix}__${safeName(asset.name)}`;
    const sha256 = await sha256Hex(bytes);
    files.set(path, bytes);
    const reference: Record<string, unknown> = {
      asset_id: asset.id,
      path,
      kind: asset.kind,
      order,
      label: attachment.label,
      sha256,
      size: bytes.byteLength,
      mime_type: asset.mimeType,
      ...(asset.sourceWidth != null ? { source_width: asset.sourceWidth } : {}),
      ...(asset.sourceHeight != null ? { source_height: asset.sourceHeight } : {}),
      ...(asset.sourceDuration != null ? { source_duration: asset.sourceDuration } : {}),
    };
    if (asset.kind === "video") {
      reference.source_duration = asset.sourceDuration ?? null;
      reference.trim_start = Number(asset.trimStart ?? 0);
      reference.trim_end = Number(asset.trimEnd ?? asset.sourceDuration ?? 0);
    }
    references.push(reference);
    const sidecar = input.sidecars.get(asset.id);
    if (sidecar) files.set(`metadata/${safeName(asset.id)}.json`, await bytesOf(sidecar));
  }

  const [template, versionText] = input.settings.workflowPreset.split(":v");
  const manifest = {
    schema: DUMMYPLUG_JOB_SCHEMA,
    job_id: jobId,
    job_desc: input.jobDesc?.trim() || input.settings.title.trim() || "untitled job",
    created_at: createdAt,
    ...(input.projectName?.trim() || input.settings.title.trim() ? { title: input.projectName?.trim() || input.settings.title.trim() } : {}),
    workflow: { template, version: Number(versionText) },
    prompt_policy: input.settings.characterPolicy,
    generation: {
      width: input.settings.width,
      height: input.settings.height,
      duration: input.duration,
      fps: input.settings.fps,
      seed: input.settings.seed,
      steps: input.settings.steps,
      sampler: input.settings.sampler,
      shift_video: input.settings.shiftVideo,
      shift_audio: input.settings.shiftAudio,
      ref_image_size: input.settings.refImageSize,
      input_scaling: input.settings.inputScaling,
      output: {
        container: input.settings.outputContainer,
        codec: input.settings.outputCodec,
        quality: input.settings.outputQuality,
        audio_codec: input.settings.audioCodec,
        audio_bitrate: input.settings.audioBitrate,
      },
    },
    references,
  };
  const manifestErrors = validateManifestV2(manifest);
  if (manifestErrors.length) throw new Error(manifestErrors.join(" "));
  const referenceMap = { subjects: input.subjects, attachments: compiled.attachments };
  files.set("manifest.json", await bytesOf(JSON.stringify(manifest, null, 2)));
  files.set("prompt.txt", await bytesOf(input.prompt));
  files.set("request.txt", await bytesOf(input.request.trim()));
  files.set("reference-map.json", await bytesOf(JSON.stringify(referenceMap, null, 2)));

  const checksums: Record<string, string> = {};
  for (const [path, bytes] of files) checksums[path] = await sha256Hex(bytes);
  const zip = new JSZip();
  const archiveDate = new Date(2000, 0, 1, 0, 0, 0);
  for (const [path, bytes] of files) zip.file(path, bytes, { date: archiveDate, createFolders: false });
  zip.file("checksums.json", JSON.stringify(checksums, null, 2), { date: archiveDate, createFolders: false });
  return {
    bytes: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } }),
    jobId,
    manifest,
    checksums,
  };
}
