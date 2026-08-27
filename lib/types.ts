export type AssetKind = "image" | "video" | "audio";
export type ProviderKind = "demo" | "openrouter" | "local";
export type AssetRole = "character" | "setting" | "style" | "motion" | "prop" | "audio" | "general";
export type ReferenceUse = "subject" | "frame-anchor" | "video-structure" | "video-edit" | "video-continuation" | "audio-reference" | "audio-copy";

export const DIRECTOR_INPUT_SCALING_OPTIONS = [
  { value: "Off", label: "Off" },
  { value: "Auto", label: "Native (ShortEdge 2048px)" },
  { value: "Target", label: "Target · Selected Aspect & Resolution" },
  { value: "Fit", label: "Fit" },
  { value: "Fill and crop", label: "Fill and crop" },
  { value: "Fit and pad", label: "Fit and pad" },
  { value: "Long side with divisible crop", label: "Long side with divisible crop" },
] as const;

export type DirectorInputScaling = (typeof DIRECTOR_INPUT_SCALING_OPTIONS)[number]["value"];
export type RefImageSize = "match" | "max";

export interface ModelSettings {
  provider: ProviderKind;
  visionModel: string;
  promptModel: string;
  baseUrl: string;
  apiKey: string;
  rememberKey: boolean;
  temperature: number;
  promptMaxTokens: number;
}

export interface ProviderProfiles {
  strong: ModelSettings;
  local: ModelSettings;
}

export interface AssetRecord {
  id: string;
  name: string;
  /** POSIX path relative to the current project's assets directory. */
  relativePath?: string;
  /** Stable import chronology owned by the project library. */
  importedAt?: string;
  sha256?: string;
  kind: AssetKind;
  size: number;
  lastModified?: number;
  mimeType: string;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceDuration?: number;
  trimStart?: number;
  trimEnd?: number;
  previewUrl: string;
  selected: boolean;
  canonicalName: string;
  role: AssetRole;
  referenceUse: ReferenceUse;
  sourceOf: string;
  note: string;
  localSourceOf?: string;
  localNote?: string;
  analysis?: AssetAnalysis;
  localAnalysis?: AssetAnalysis;
  missingFile?: boolean;
}

export interface JobSettings {
  defaultsVersion: number;
  title: string;
  width: number;
  height: number;
  fps: number;
  seed: number;
  steps: number;
  sampler: string;
  shiftVideo: number;
  shiftAudio: number;
  refImageSize: RefImageSize;
  inputScaling: DirectorInputScaling;
  outputContainer: string;
  outputCodec: string;
  outputQuality: number;
  audioCodec: string;
  audioBitrate: string;
  workflowPreset: "dasiwa-ref2va:v1";
}

export interface AssetAnalysis {
  assetId: string;
  /** Identifies which durable evidence channel produced this record. */
  channel?: "strong" | "local";
  analysisRole?: "character" | "setting" | "style" | "general";
  summary: string;
  subjects: string[];
  setting: string;
  style: string;
  composition: string;
  motion: string;
  continuityLocks: string[];
  usableAs: string[];
  raw?: string;
}

export interface PreparedReference {
  assetId: string;
  analysisChannel?: "strong" | "local";
  /** Private local-analysis inspection targets; never supplied to the strong channel. */
  focusTerms?: string[];
  name: string;
  kind: AssetKind;
  canonicalName: string;
  role: AssetRole;
  referenceUse: ReferenceUse;
  sourceOf: string;
  note: string;
  dataUrls: string[];
}

export interface AttachmentSpec {
  assetId: string;
  label: string;
  name: string;
  kind: AssetKind;
  referenceUse: ReferenceUse;
  standaloneEntry: boolean;
}

export interface SubjectSpec {
  label: string;
  canonicalName: string;
  role: AssetRole;
  assetIds: string[];
  attachmentLabels: string[];
}

export interface SingleShotPrompt {
  prompt: string;
  attachments: AttachmentSpec[];
  subjects: SubjectSpec[];
  taskTypes: string[];
  warnings: string[];
}
