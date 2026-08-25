export type AssetKind = "image" | "video" | "audio";
export type ProviderKind = "demo" | "openrouter" | "local";
export type AssetRole = "character" | "setting" | "style" | "motion" | "prop" | "audio" | "general";
export type ReferenceUse = "subject" | "frame-anchor" | "video-structure" | "video-edit" | "video-continuation" | "audio-reference" | "audio-copy";

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

export interface AssetRecord {
  id: string;
  name: string;
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
  analysis?: AssetAnalysis;
  missingFile?: boolean;
}

export interface JobSettings {
  title: string;
  width: number;
  height: number;
  fps: number;
  seed: number;
  steps: number;
  sampler: string;
  shiftVideo: number;
  shiftAudio: number;
  inputScaling: string;
  outputContainer: string;
  outputCodec: string;
  outputQuality: number;
  audioCodec: string;
  audioBitrate: string;
  workflowPreset: "dasiwa-ref2va:v1";
}

export interface AssetAnalysis {
  assetId: string;
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
