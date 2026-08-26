import JSZip from "jszip";
import { compileAttachments, validateSingleShotPrompt } from "./single-h3.ts";
import { DIRECTOR_INPUT_SCALING_OPTIONS } from "./types.ts";
import type { AssetRecord, JobSettings, SubjectSpec } from "./types.ts";

type BinarySource = Blob | ArrayBuffer | Uint8Array;

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
}

export const DEFAULT_JOB_SETTINGS: JobSettings = {
  defaultsVersion: 2,
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
  return { ...DEFAULT_JOB_SETTINGS, ...raw, defaultsVersion: DEFAULT_JOB_SETTINGS.defaultsVersion, refImageSize, inputScaling, outputContainer, audioCodec } as JobSettings;
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
  if (!Number.isInteger(settings.width) || settings.width < 64 || settings.width > 8192) errors.push("Width must be an integer from 64 to 8192.");
  if (!Number.isInteger(settings.height) || settings.height < 64 || settings.height > 8192) errors.push("Height must be an integer from 64 to 8192.");
  if (!Number.isFinite(duration) || duration < 1 || duration > 20) errors.push("Duration must be from 1 to 20 seconds.");
  if (!Number.isFinite(settings.fps) || settings.fps < 1 || settings.fps > 120) errors.push("FPS must be from 1 to 120.");
  if (!Number.isSafeInteger(settings.seed) || settings.seed < 0) errors.push("Seed must be a non-negative safe integer.");
  if (!Number.isInteger(settings.steps) || settings.steps < 1 || settings.steps > 200) errors.push("Steps must be from 1 to 200.");
  if (!Number.isFinite(settings.shiftVideo)) errors.push("shift_video must be a finite number.");
  if (!Number.isFinite(settings.shiftAudio)) errors.push("shift_audio must be a finite number.");
  if (settings.refImageSize !== "match" && settings.refImageSize !== "max") errors.push("Reference image size must be match or max.");
  if (!DIRECTOR_INPUT_SCALING_VALUES.has(settings.inputScaling)) errors.push("Input scaling must be one of Director's supported modes.");
  if (!Number.isFinite(settings.outputQuality) || settings.outputQuality < 0 || settings.outputQuality > 51) errors.push("Video quality (CRF/CQ) must be from 0 to 51; lower values preserve more quality.");
  if (!settings.sampler.trim()) errors.push("Sampler is required.");
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
    ...compiled.warnings,
  ];
  const promptValidation = validateSingleShotPrompt(input.prompt, compiled.attachments, input.subjects);
  if (!promptValidation.valid) errors.push("The six-section H3 prompt is not valid for the current reference snapshot.");
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
    schema: "dummyplug.h3-job.v1",
    job_id: jobId,
    created_at: createdAt,
    ...(input.settings.title.trim() ? { title: input.settings.title.trim() } : {}),
    workflow: { template, version: Number(versionText) },
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
  const referenceMap = { subjects: input.subjects, attachments: compiled.attachments };
  files.set("manifest.json", await bytesOf(JSON.stringify(manifest, null, 2)));
  files.set("prompt.txt", await bytesOf(input.prompt));
  files.set("request.txt", await bytesOf(input.request.trim()));
  files.set("reference-map.json", await bytesOf(JSON.stringify(referenceMap, null, 2)));

  const checksums: Record<string, string> = {};
  for (const [path, bytes] of files) checksums[path] = await sha256Hex(bytes);
  const zip = new JSZip();
  for (const [path, bytes] of files) zip.file(path, bytes);
  zip.file("checksums.json", JSON.stringify(checksums, null, 2));
  return {
    bytes: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } }),
    jobId,
    manifest,
    checksums,
  };
}
