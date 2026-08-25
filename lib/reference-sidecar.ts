import type { AssetAnalysis, AssetRecord, AssetRole, ModelSettings, ReferenceUse } from "./types";

export const REFERENCE_SIDECAR_SCHEMA = "dummyplug.asset.v3";

export interface ReferenceSidecar {
  schema: typeof REFERENCE_SIDECAR_SCHEMA;
  source: {
    name: string;
    size: number;
    mimeType: string;
  };
  metadata: {
    canonicalName: string;
    role: AssetRole;
    referenceUse: ReferenceUse;
    sourceOf: string;
    note: string;
  };
  analysis?: AssetAnalysis;
  updatedAt: string;
  provider: {
    kind: ModelSettings["provider"];
    visionModel: string;
  };
}

export function withoutExtension(name: string) {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const dot = name.lastIndexOf(".");
  return dot > slash + 0 ? name.slice(0, dot) : name;
}

export function sidecarName(sourceName: string) {
  return `${withoutExtension(sourceName)}.json`;
}

export function sidecarMatchKey(name: string) {
  return withoutExtension(name).replaceAll("\\", "/").toLocaleLowerCase();
}

export function makeReferenceSidecar(asset: AssetRecord, settings: ModelSettings, analyzedAt = new Date().toISOString()): ReferenceSidecar | null {
  return {
    schema: REFERENCE_SIDECAR_SCHEMA,
    source: { name: asset.name, size: asset.size, mimeType: asset.mimeType },
    metadata: {
      canonicalName: asset.canonicalName,
      role: asset.role,
      referenceUse: asset.referenceUse,
      sourceOf: asset.sourceOf,
      note: asset.note,
    },
    analysis: asset.analysis ? { ...asset.analysis, assetId: asset.id } : undefined,
    updatedAt: analyzedAt,
    provider: { kind: settings.provider, visionModel: settings.visionModel },
  };
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function readReferenceSidecar(text: string, assetId: string): { analysis?: AssetAnalysis; canonicalName?: string; role?: AssetRole; referenceUse?: ReferenceUse; sourceOf?: string; note?: string; source?: ReferenceSidecar["source"] } | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.schema !== REFERENCE_SIDECAR_SCHEMA) return null;
    const candidate = (parsed.analysis && typeof parsed.analysis === "object" ? parsed.analysis : {}) as Record<string, unknown>;
    const metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata as Record<string, unknown> : {};
    const role = String(metadata.role || candidate.analysisRole || "general");
    const validRole = ["character", "setting", "style", "motion", "prop", "audio", "general"].includes(role) ? role as AssetRole : "general";
    const referenceUse = String(metadata.referenceUse || "subject");
    const validReferenceUse = ["subject", "frame-anchor", "video-structure", "video-edit", "video-continuation", "audio-reference", "audio-copy"].includes(referenceUse) ? referenceUse as ReferenceUse : "subject";
    const hasAnalysis = Boolean(candidate.summary || candidate.subjects || candidate.continuityLocks);
    if (!hasAnalysis && !Object.keys(metadata).length) return null;
    return {
      canonicalName: typeof metadata.canonicalName === "string" ? metadata.canonicalName : undefined,
      role: validRole,
      referenceUse: validReferenceUse,
      sourceOf: typeof metadata.sourceOf === "string" ? metadata.sourceOf : undefined,
      note: typeof metadata.note === "string" ? metadata.note : undefined,
      source: parsed.source && typeof parsed.source === "object" ? {
        name: String((parsed.source as Record<string, unknown>).name || ""),
        size: Number((parsed.source as Record<string, unknown>).size || 0),
        mimeType: String((parsed.source as Record<string, unknown>).mimeType || ""),
      } : undefined,
      analysis: hasAnalysis ? {
        assetId,
        analysisRole: ["character", "setting", "style", "general"].includes(String(candidate.analysisRole)) ? candidate.analysisRole as AssetAnalysis["analysisRole"] : undefined,
        summary: String(candidate.summary || "Imported reference analysis."),
        subjects: strings(candidate.subjects),
        setting: String(candidate.setting || ""),
        style: String(candidate.style || ""),
        composition: String(candidate.composition || ""),
        motion: String(candidate.motion || ""),
        continuityLocks: strings(candidate.continuityLocks),
        usableAs: strings(candidate.usableAs),
        raw: candidate.raw == null ? undefined : String(candidate.raw),
      } : undefined,
    };
  } catch {
    return null;
  }
}
