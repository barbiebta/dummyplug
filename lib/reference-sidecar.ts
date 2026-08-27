import type { AssetAnalysis, AssetRecord, AssetRole, ModelSettings, ProviderProfiles, ReferenceUse } from "./types";

export const REFERENCE_SIDECAR_SCHEMA = "dummyplug.asset.v4";
export const LEGACY_REFERENCE_SIDECAR_SCHEMA = "dummyplug.asset.v3";

export interface ReferenceSidecarSource {
  name: string; size: number; mimeType: string; lastModified?: number; sha256?: string;
  width?: number; height?: number; duration?: number;
}
export interface ReferenceSidecar {
  schema: typeof REFERENCE_SIDECAR_SCHEMA; assetId: string; relativePath: string; importedAt: string;
  source: ReferenceSidecarSource;
  metadata: { canonicalName: string; declaredIdentity: string; role: AssetRole; referenceUse: ReferenceUse; sourceOf: string; note: string; localSourceOf: string; localNote: string };
  analysis?: AssetAnalysis; localAnalysis?: AssetAnalysis; updatedAt: string;
  provider: { kind: ModelSettings["provider"]; visionModel: string };
  localProvider?: { kind: ModelSettings["provider"]; visionModel: string };
}
export interface ReferenceSidecarOptions { relativePath?: string; importedAt?: string; sha256?: string }

export function withoutExtension(name: string) {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const dot = name.lastIndexOf(".");
  return dot > slash + 0 ? name.slice(0, dot) : name;
}
/** Project-local companions retain the complete media filename. */
export function sidecarName(sourceName: string) { return `${sourceName.replaceAll("\\", "/")}.dummyplug.json`; }
/** Legacy browser sidecar name, retained for migration/import callers. */
export function legacySidecarName(sourceName: string) { return `${withoutExtension(sourceName)}.json`; }
export function sidecarMatchKey(name: string) {
  const normalized = name.replaceAll("\\", "/");
  const lower = normalized.toLocaleLowerCase();
  if (lower.endsWith(".dummyplug.json")) return withoutExtension(normalized.slice(0, -".dummyplug.json".length)).toLocaleLowerCase();
  if (lower.endsWith(".json")) return normalized.slice(0, -".json".length).toLocaleLowerCase();
  return withoutExtension(normalized).toLocaleLowerCase();
}

export function makeReferenceSidecar(asset: AssetRecord, settings: ModelSettings | ProviderProfiles, analyzedAt = new Date().toISOString(), options: ReferenceSidecarOptions = {}): ReferenceSidecar | null {
  const strong = "strong" in settings ? settings.strong : settings;
  const local = "local" in settings ? settings.local : undefined;
  return {
    schema: REFERENCE_SIDECAR_SCHEMA, assetId: asset.id, relativePath: options.relativePath || asset.relativePath || asset.name, importedAt: options.importedAt || asset.importedAt || analyzedAt,
    source: { name: asset.name, size: asset.size, mimeType: asset.mimeType,
      ...(asset.lastModified == null ? {} : { lastModified: asset.lastModified }), ...(options.sha256 || asset.sha256 ? { sha256: options.sha256 || asset.sha256 } : {}),
      ...(asset.sourceWidth == null ? {} : { width: asset.sourceWidth }), ...(asset.sourceHeight == null ? {} : { height: asset.sourceHeight }), ...(asset.sourceDuration == null ? {} : { duration: asset.sourceDuration }) },
    metadata: { canonicalName: asset.canonicalName, declaredIdentity: asset.declaredIdentity || "", role: asset.role, referenceUse: asset.referenceUse, sourceOf: asset.sourceOf, note: asset.note, localSourceOf: asset.localSourceOf || "", localNote: asset.localNote || "" },
    analysis: asset.analysis ? { ...asset.analysis, assetId: asset.id, channel: "strong" } : undefined,
    localAnalysis: asset.localAnalysis ? { ...asset.localAnalysis, assetId: asset.id, channel: "local" } : undefined,
    updatedAt: analyzedAt,
    provider: { kind: strong.provider, visionModel: strong.visionModel },
    ...(local ? { localProvider: { kind: local.provider, visionModel: local.visionModel } } : {}),
  };
}
function strings(value: unknown) { return Array.isArray(value) ? value.map(String).filter(Boolean) : []; }
export interface ImportedReferenceSidecar {
  assetId?: string; relativePath?: string; importedAt?: string; analysis?: AssetAnalysis; localAnalysis?: AssetAnalysis; canonicalName?: string; declaredIdentity?: string;
  role?: AssetRole; referenceUse?: ReferenceUse; sourceOf?: string; note?: string; localSourceOf?: string; localNote?: string; source?: ReferenceSidecarSource;
  schema?: typeof REFERENCE_SIDECAR_SCHEMA;
}
/** Reads v4 and v3 into one normalized shape, rebinding analysis to the supplied asset id. */
export function readReferenceSidecar(text: string, assetId: string): ImportedReferenceSidecar | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.schema !== REFERENCE_SIDECAR_SCHEMA && parsed.schema !== LEGACY_REFERENCE_SIDECAR_SCHEMA) return null;
    const candidate = (parsed.analysis && typeof parsed.analysis === "object" ? parsed.analysis : {}) as Record<string, unknown>;
    const localCandidate = (parsed.localAnalysis && typeof parsed.localAnalysis === "object" ? parsed.localAnalysis : {}) as Record<string, unknown>;
    const metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata as Record<string, unknown> : {};
    const role = String(metadata.role || candidate.analysisRole || "general");
    const validRole = ["character", "setting", "style", "motion", "prop", "audio", "general"].includes(role) ? role as AssetRole : "general";
    const use = String(metadata.referenceUse || "subject");
    const validUse = ["subject", "frame-anchor", "video-structure", "video-edit", "video-continuation", "audio-reference", "audio-copy"].includes(use) ? use as ReferenceUse : "subject";
    const hasAnalysis = Boolean(candidate.summary || candidate.subjects || candidate.continuityLocks);
    const hasLocalAnalysis = Boolean(localCandidate.summary || localCandidate.subjects || localCandidate.continuityLocks);
    if (!hasAnalysis && !hasLocalAnalysis && !Object.keys(metadata).length) return null;
    const so = parsed.source && typeof parsed.source === "object" ? parsed.source as Record<string, unknown> : undefined;
    const source = so ? { name: String(so.name || ""), size: Number(so.size || 0), mimeType: String(so.mimeType || ""),
      ...(so.lastModified == null ? {} : { lastModified: Number(so.lastModified) }), ...(so.sha256 == null ? {} : { sha256: String(so.sha256) }),
      ...(so.width == null ? {} : { width: Number(so.width) }), ...(so.height == null ? {} : { height: Number(so.height) }), ...(so.duration == null ? {} : { duration: Number(so.duration) }) } : undefined;
    return { assetId: typeof parsed.assetId === "string" ? parsed.assetId : undefined, relativePath: typeof parsed.relativePath === "string" ? parsed.relativePath : undefined,
      importedAt: typeof parsed.importedAt === "string" ? parsed.importedAt : undefined, schema: REFERENCE_SIDECAR_SCHEMA,
      canonicalName: typeof metadata.canonicalName === "string" ? metadata.canonicalName : undefined, declaredIdentity: typeof metadata.declaredIdentity === "string" ? metadata.declaredIdentity : undefined, role: validRole, referenceUse: validUse,
      sourceOf: typeof metadata.sourceOf === "string" ? metadata.sourceOf : undefined, note: typeof metadata.note === "string" ? metadata.note : undefined,
      localSourceOf: typeof metadata.localSourceOf === "string" ? metadata.localSourceOf : undefined, localNote: typeof metadata.localNote === "string" ? metadata.localNote : undefined, source,
      analysis: hasAnalysis ? { assetId, analysisRole: ["character", "setting", "style", "general"].includes(String(candidate.analysisRole)) ? candidate.analysisRole as AssetAnalysis["analysisRole"] : undefined,
        channel: "strong", summary: String(candidate.summary || "Imported reference analysis."), subjects: strings(candidate.subjects), setting: String(candidate.setting || ""), style: String(candidate.style || ""), composition: String(candidate.composition || ""), motion: String(candidate.motion || ""), continuityLocks: strings(candidate.continuityLocks), usableAs: strings(candidate.usableAs), raw: candidate.raw == null ? undefined : String(candidate.raw) } : undefined,
      localAnalysis: hasLocalAnalysis ? { assetId, analysisRole: ["character", "setting", "style", "general"].includes(String(localCandidate.analysisRole)) ? localCandidate.analysisRole as AssetAnalysis["analysisRole"] : undefined,
        channel: "local", summary: String(localCandidate.summary || "Imported local reference analysis."), subjects: strings(localCandidate.subjects), setting: String(localCandidate.setting || ""), style: String(localCandidate.style || ""), composition: String(localCandidate.composition || ""), motion: String(localCandidate.motion || ""), continuityLocks: strings(localCandidate.continuityLocks), usableAs: strings(localCandidate.usableAs), raw: localCandidate.raw == null ? undefined : String(localCandidate.raw), dirtyFocus: localCandidate.dirtyFocus as AssetAnalysis["dirtyFocus"] } : undefined };
  } catch { return null; }
}
