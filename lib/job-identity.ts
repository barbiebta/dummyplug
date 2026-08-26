/** Pure, browser-safe helpers for human-readable job names and stable IDs. */

export type JobAssetName = {
  canonicalName?: string | null;
  name?: string | null;
  path?: string | null;
};

export type VerbFamily = { lemma: string; forms: string[] };

// Deliberately editable: the UI can replace this list without changing the matcher.
// Forms are kept explicit for irregular verbs; regular families are expanded below.
const LEMMAS = `add allow answer appear apply arrive ask avoid bake become begin believe belong break bring build buy call carry catch change choose clean climb close come compare complete continue cook copy cost create cross cry cut dance decide deliver describe develop die discover do draw dream drink drive drop eat enable end enjoy enter explain fall feel fight fill find finish fix fly follow forget forgive freeze get give go grab grow guess happen hate have hear help hide hit hold hope identify imagine improve include increase indicate invite join jump keep kick kill know laugh learn leave lend let lie lift like listen live look lose love make manage marry mean meet melt mention mind miss move need notice offer open order organize own paint pass pay perform pick place plan play point prefer prepare present prevent produce promise protect prove pull push put read realize receive recognize record reduce remain remember remove repeat replace reply report require rest return ride ring rise run save say see sell send serve set shake share shoot show shut sing sit sleep slide smile solve spend stand start stay steal step stick stop study succeed suggest swim take talk teach tear tell thank think throw touch train travel treat try turn understand use visit wait walk want watch wear win wish wonder work write`.split(/\s+/);
const IRREGULAR: Record<string, string[]> = {
  be: ["be", "am", "is", "are", "was", "were", "been", "being"], become: ["become", "became", "become", "becoming"], begin: ["begin", "began", "begun", "beginning"], break: ["break", "broke", "broken", "breaking"], bring: ["bring", "brought", "bringing"], buy: ["buy", "bought", "buying"], catch: ["catch", "caught", "catching"], choose: ["choose", "chose", "chosen", "choosing"], come: ["come", "came", "coming"], cost: ["cost", "costing"], cut: ["cut", "cutting"], do: ["do", "does", "did", "done", "doing"], draw: ["draw", "drew", "drawn", "drawing"], drink: ["drink", "drank", "drunk", "drinking"], drive: ["drive", "drove", "driven", "driving"], eat: ["eat", "ate", "eaten", "eating"], fall: ["fall", "fell", "fallen", "falling"], feel: ["feel", "felt", "feeling"], fight: ["fight", "fought", "fighting"], find: ["find", "found", "finding"], fly: ["fly", "flew", "flown", "flying"], forget: ["forget", "forgot", "forgotten", "forgetting"], forgive: ["forgive", "forgave", "forgiven", "forgiving"], freeze: ["freeze", "froze", "frozen", "freezing"], get: ["get", "gets", "got", "gotten", "getting"], give: ["give", "gave", "given", "giving"], go: ["go", "goes", "went", "gone", "going"], grow: ["grow", "grew", "grown", "growing"], have: ["have", "has", "had", "having"], hear: ["hear", "heard", "hearing"], hold: ["hold", "held", "holding"], keep: ["keep", "kept", "keeping"], know: ["know", "knew", "known", "knowing"], leave: ["leave", "left", "leaving"], lend: ["lend", "lent", "lending"], let: ["let", "letting"], lie: ["lie", "lay", "lain", "lying"], lose: ["lose", "lost", "losing"], make: ["make", "made", "making"], mean: ["mean", "meant", "meaning"], meet: ["meet", "met", "meeting"], pay: ["pay", "paid", "paying"], put: ["put", "putting"], read: ["read", "reading"], ride: ["ride", "rode", "ridden", "riding"], ring: ["ring", "rang", "rung", "ringing"], rise: ["rise", "rose", "risen", "rising"], run: ["run", "ran", "running"], say: ["say", "says", "said", "saying"], see: ["see", "saw", "seen", "seeing"], sell: ["sell", "sold", "selling"], send: ["send", "sent", "sending"], set: ["set", "setting"], shake: ["shake", "shook", "shaken", "shaking"], shoot: ["shoot", "shot", "shooting"], show: ["show", "showed", "shown", "showing"], shut: ["shut", "shutting"], sing: ["sing", "sang", "sung", "singing"], sit: ["sit", "sat", "sitting"], sleep: ["sleep", "slept", "sleeping"], spend: ["spend", "spent", "spending"], stand: ["stand", "stood", "standing"], steal: ["steal", "stole", "stolen", "stealing"], stick: ["stick", "stuck", "sticking"], swim: ["swim", "swam", "swum", "swimming"], take: ["take", "took", "taken", "taking"], teach: ["teach", "taught", "teaching"], tear: ["tear", "tore", "torn", "tearing"], tell: ["tell", "told", "telling"], think: ["think", "thought", "thinking"], throw: ["throw", "threw", "thrown", "throwing"], understand: ["understand", "understood", "understanding"], wear: ["wear", "wore", "worn", "wearing"], win: ["win", "won", "winning"], write: ["write", "wrote", "written", "writing"]
};

function regularForms(lemma: string): string[] {
  const ending = lemma.slice(-1);
  const past = ending === "e" ? `${lemma}d` : `${lemma}${/[sxz]|ch|sh$/.test(lemma) ? "ed" : "ed"}`;
  const ing = ending === "e" && lemma !== "be" ? `${lemma.slice(0, -1)}ing` : `${lemma}ing`;
  const third = /[sxz]|ch|sh$/.test(lemma) ? `${lemma}es` : lemma.endsWith("y") ? `${lemma.slice(0, -1)}ies` : `${lemma}s`;
  return [lemma, third, past, ing];
}

export const DEFAULT_VERB_FAMILIES: VerbFamily[] = LEMMAS.filter((lemma) => lemma !== "be").map((lemma) => ({ lemma, forms: IRREGULAR[lemma] ?? regularForms(lemma) }));
export const DEFAULT_VERB_VOCABULARY = DEFAULT_VERB_FAMILIES.flatMap((family) => family.forms);

export function detectVerbs(text: string, vocabulary: VerbFamily[] | string[] = DEFAULT_VERB_FAMILIES): Array<{ word: string; index: number; lemma: string }> {
  const families = vocabulary.map((item) => typeof item === "string" ? { lemma: item, forms: [item] } : item);
  const lookup = new Map<string, string>();
  for (const family of families) for (const form of family.forms) if (form.toLowerCase() !== "be") lookup.set(form.toLowerCase(), family.lemma);
  const result: Array<{ word: string; index: number; lemma: string }> = [];
  for (const match of text.matchAll(/[A-Za-z]+(?:'[A-Za-z]+)?/g)) {
    const word = match[0]; const lemma = lookup.get(word.toLowerCase());
    if (lemma) result.push({ word, index: match.index ?? 0, lemma });
  }
  return result;
}

function pathlessName(asset: JobAssetName, preferCanonical = true): string {
  const source = (preferCanonical ? asset.canonicalName?.trim() : "") || asset.name?.trim() || asset.path?.trim() || asset.canonicalName?.trim() || "asset";
  const base = source.replace(/[\\/]/g, "/").split("/").pop() ?? source;
  return base.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim();
}

export function normalizeJobDesc(value: string | null | undefined): string {
  return (value ?? "").trim().slice(0, 30);
}

export function deriveJobDesc(simplePrompt: string, selectedAssets: JobAssetName[], manualDescription = "", vocabulary: VerbFamily[] | string[] = DEFAULT_VERB_FAMILIES): string {
  const manual = normalizeJobDesc(manualDescription);
  if (manual) return manual;
  const assetHits = selectedAssets.map((asset, order) => {
    const label = pathlessName(asset);
    const candidates = [asset.canonicalName?.trim(), pathlessName(asset, false)].filter((value): value is string => Boolean(value));
    const indexes = candidates.map((candidate) => simplePrompt.toLocaleLowerCase().indexOf(candidate.toLocaleLowerCase())).filter((index) => index >= 0);
    const index = indexes.length ? Math.min(...indexes) : -1;
    return index < 0 ? null : { label, index, order };
  }).filter(Boolean) as Array<{ label: string; index: number; order: number }>;
  assetHits.sort((a, b) => a.index - b.index || a.order - b.order);
  const verbs = detectVerbs(simplePrompt, vocabulary);
  const pieces: string[] = [];
  for (let i = 0; i < assetHits.length; i += 1) {
    pieces.push(assetHits[i].label);
    if (verbs[i]) pieces.push(verbs[i].lemma);
  }
  const fallback = pieces.join(" ") || "job";
  return fallback.length > 30 ? `${fallback.slice(0, 27).trimEnd()}...` : fallback;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createJobId(jobDesc: string, resolvedSnapshot: unknown): Promise<string> {
  const safe = normalizeJobDesc(jobDesc).replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "job";
  return `${safe}_${(await sha256Hex(stableStringify(resolvedSnapshot))).slice(0, 8)}`;
}

export const jobId = createJobId;
