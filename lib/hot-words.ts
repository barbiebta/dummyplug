import type { AssetRecord } from "./types.ts";

function normalized(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

export function parseHotWords(value: string) {
  const seen = new Set<string>();
  return value.split(/\r?\n/).map((term) => term.trim()).filter((term) => {
    const key = normalized(term);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function missingTerms(terms: string[], source: string, output: string) {
  const normalizedSource = normalized(source);
  const normalizedOutput = normalized(output);
  if (!normalizedSource || !normalizedOutput) return [];
  return terms.filter((term) => {
    const key = normalized(term);
    return normalizedSource.includes(key) && !normalizedOutput.includes(key);
  });
}

function assetMetadataText(asset: AssetRecord) {
  return [
    asset.canonicalName,
    asset.declaredIdentity,
    asset.role,
    asset.referenceUse,
    asset.sourceOf,
    asset.note,
    asset.localSourceOf,
    asset.localNote,
    asset.analysis ? JSON.stringify(asset.analysis) : "",
    asset.localAnalysis ? JSON.stringify(asset.localAnalysis) : "",
  ].filter(Boolean).join("\n");
}

export function auditHotWords(terms: string[], simplePrompt: string, assets: AssetRecord[], outputPrompt: string) {
  return {
    missingFromMetadata: missingTerms(terms, assets.map(assetMetadataText).join("\n"), outputPrompt),
    missingFromSimplePrompt: missingTerms(terms, simplePrompt, outputPrompt),
  };
}
