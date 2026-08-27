import type { AssetRole, CharacterPromptPolicy, DirectorInputScaling, ReferenceUse, RefImageSize } from "./types.ts";

/** The on-disk project format. It deliberately contains no provider credentials. */
export const PROJECT_SCHEMA = "dummyplug.project.v1";
export const PROJECT_DRAFT_SCHEMA = "dummyplug.project-draft.v1";
export const PROJECT_ASSET_SIDECAR_SUFFIX = ".dummyplug.json";

export interface ProjectOutputSettings {
  defaultsVersion: number;
  width: number;
  height: number;
  fps: number;
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
  characterPolicy: CharacterPromptPolicy;
}

export const DEFAULT_PROJECT_OUTPUT_SETTINGS: ProjectOutputSettings = {
  defaultsVersion: 3,
  width: 768,
  height: 1344,
  fps: 24,
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

export interface ProjectManifest {
  schema: typeof PROJECT_SCHEMA;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  outputSettings: ProjectOutputSettings;
}

export interface ProjectDraft {
  schema: typeof PROJECT_DRAFT_SCHEMA;
  projectId: string;
  updatedAt: string;
  simplePrompt: string;
  jobDesc: string;
  selectedAssetIds: string[];
  duration: number;
  seedMode: "fixed" | "random";
  fixedSeed: number;
  generatedPrompt: string;
  generatedPromptHistory: string[];
  requireNonDiegeticMusicNA: boolean;
}

export const DEFAULT_PROJECT_DRAFT = {
  simplePrompt: "",
  jobDesc: "",
  selectedAssetIds: [] as string[],
  duration: 5,
  seedMode: "fixed" as const,
  fixedSeed: 616271471367168,
  generatedPrompt: "",
  generatedPromptHistory: [] as string[],
  requireNonDiegeticMusicNA: true,
};

export interface ProjectAssetSidecar {
  schema: "dummyplug.asset.v4" | string;
  /** v4 fields shared with reference-sidecar.ts. */
  assetId?: string;
  relativePath?: string;
  importedAt?: string;
  source: {
    name: string;
    size: number;
    mimeType: string;
    lastModified?: number;
  };
  /** Read-only tolerance for an early nested bookkeeping prototype. */
  dummyplug?: { assetId?: string; relativePath?: string; importedAt?: string };
  metadata?: Record<string, unknown>;
  analysis?: Record<string, unknown>;
  localAnalysis?: Record<string, unknown>;
  updatedAt: string;
  provider?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProjectAsset {
  id: string;
  relativePath: string;
  name: string;
  kind: "image" | "video" | "audio";
  size: number;
  mimeType: string;
  lastModified: number;
  importedAt: string;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceDuration?: number;
  sha256?: string;
  /** Directly maps to the existing AssetRecord tagging fields in the UI. */
  canonicalName: string;
  declaredIdentity: string;
  role: AssetRole;
  referenceUse: ReferenceUse;
  sourceOf: string;
  note: string;
  localSourceOf: string;
  localNote: string;
  metadata: ProjectAssetMetadata;
  analysis?: Record<string, unknown>;
  localAnalysis?: Record<string, unknown>;
  sidecarPath: string;
}

export interface ProjectAssetMetadata {
  canonicalName: string;
  declaredIdentity: string;
  role: AssetRole;
  referenceUse: ReferenceUse;
  sourceOf: string;
  note: string;
  localSourceOf: string;
  localNote: string;
  [key: string]: unknown;
}

export function projectSidecarPath(relativeAssetPath: string) {
  return `${relativeAssetPath}${PROJECT_ASSET_SIDECAR_SUFFIX}`;
}
