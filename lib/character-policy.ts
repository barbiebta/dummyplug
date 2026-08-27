import type { AssetRecord, CharacterPromptPolicy, SubjectSpec } from "./types.ts";

export const CHARACTER_VOCABULARY = {
  man: ["man", "men", "male"],
  woman: ["woman", "women", "female"],
  trans: ["trans", "transgender"],
  futa: ["futa", "futanari"],
} as const;

export function resolveDeclaredIdentity(asset: Pick<AssetRecord, "declaredIdentity" | "role">, policy: CharacterPromptPolicy) {
  const explicit = asset.declaredIdentity.trim();
  if (explicit) return explicit;
  if (asset.role === "character" && policy.allCharactersTransgenderWomen) return "transgender woman; she/her pronouns";
  return "";
}

function termPattern(terms: readonly string[]) {
  return new RegExp(`\\b(?:${terms.join("|")})\\b`, "gi");
}

function subjectDefinition(prompt: string, label: string) {
  const start = prompt.toLocaleLowerCase().indexOf("subject_definitions:");
  const end = prompt.toLocaleLowerCase().indexOf("summary:");
  if (start < 0 || end <= start) return "";
  const definitions = prompt.slice(start + "subject_definitions:".length, end);
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = definitions.match(new RegExp(`^\\s*${escaped}[^\\n]*(?:\\n(?!\\s*<(?:Subject|Picture|Video|Audio)\\s+\\d+>)[^\\n]*)*`, "mi"));
  return match?.[0] || "";
}

export interface CharacterPolicyValidation {
  valid: boolean;
  forbiddenVocabulary: Array<{ group: keyof CharacterPromptPolicy["allowedVocabulary"]; terms: string[] }>;
  missingCastIdentity: string[];
}

export function validateCharacterPolicy(prompt: string, subjects: SubjectSpec[], policy?: CharacterPromptPolicy): CharacterPolicyValidation {
  const resolvedPolicy = policy || { allCharactersTransgenderWomen: false, allowedVocabulary: { man: true, woman: true, trans: true, futa: true } };
  const forbiddenVocabulary = (Object.keys(CHARACTER_VOCABULARY) as Array<keyof typeof CHARACTER_VOCABULARY>).flatMap((group) => {
    if (resolvedPolicy.allowedVocabulary[group]) return [];
    const found = [...new Set([...prompt.matchAll(termPattern(CHARACTER_VOCABULARY[group]))].map((match) => match[0].toLocaleLowerCase()))];
    return found.length ? [{ group, terms: found }] : [];
  });
  const allowedIdentityTerms = [
    ...(resolvedPolicy.allowedVocabulary.trans ? CHARACTER_VOCABULARY.trans : []),
    ...(resolvedPolicy.allowedVocabulary.futa ? CHARACTER_VOCABULARY.futa : []),
  ];
  const missingCastIdentity = resolvedPolicy.allCharactersTransgenderWomen && allowedIdentityTerms.length
    ? subjects.filter((subject) => subject.role === "character" && !subject.declaredIdentity?.trim())
      .filter((subject) => !termPattern(allowedIdentityTerms).test(subjectDefinition(prompt, subject.label)))
      .map((subject) => subject.label)
    : [];
  return { valid: !forbiddenVocabulary.length && !missingCastIdentity.length, forbiddenVocabulary, missingCastIdentity };
}
