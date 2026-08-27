import type { AssetAnalysis, AttachmentSpec, PreparedReference, SubjectSpec } from "./types";

export type PromptTemplateId = "vision-character" | "vision-setting" | "vision-style" | "vision-general" | "single-shot" | "connection-probe";
export type PromptTemplateMap = Record<PromptTemplateId, string>;
export type VisionAnalysisRole = "character" | "setting" | "style" | "general";

export interface ExposedPromptTemplate {
  id: PromptTemplateId;
  title: string;
  modelRole: "vision model" | "prompt model";
  description: string;
  template: string;
}

export const CONNECTION_PROBE_PROMPT = "Reply with exactly: dummyplug connected";

const COMMON_VISION_HEADER = `You are an experienced video editor and director recording durable visual metadata for a local reference library. The user's fields are authoritative naming and intended-use metadata, not visual evidence. Use the canonical name when it fits what is visible. Report contradictions and uncertainty. Never invent off-frame facts, story, relationships, identity, or intent.

Asset ID: {{assetId}}
Filename: {{filename}}
Canonical name: {{canonicalName}}
Declared role: {{role}}
Declared H3 use: {{referenceUse}}
Use this asset as the source of: {{sourceOf}}
User note: {{userNote}}
Analysis channel: {{analysisChannel}}
{{channelInstruction}}

Return only one valid JSON object with exactly these keys:
{"summary":"string","subjects":["string"],"setting":"string","style":"string","composition":"string","motion":"string","continuityLocks":["string"],"usableAs":["string"]}`;

export const VISION_CHARACTER_TEMPLATE = `${COMMON_VISION_HEADER}

This is a character reference. Spend most of the response on the named character and very little on incidental background. Record minute visible identity evidence: face and head geometry; skin, fur, hair, ears, eyes, mouth, teeth, markings; body proportions and silhouette; hands and feet; wardrobe layers, seams, closures, wear and accessories; materials and exact colors; pose, gaze, expression, contact, crop, occlusion and what is not visible. Separate stable identity from the view-specific pose, emotion, lighting and camera angle. Treat sensitive adult material in direct neutral production language.

Targets: summary 180-300 words; primary subjects entry 450-800 words when supported; style 140-260; composition 100-180; motion 100-180; setting only 40-100; 20-35 short continuityLocks; 4-10 usableAs labels. Prefer discriminating visible facts to generic quality language.`;

export const VISION_SETTING_TEMPLATE = `${COMMON_VISION_HEADER}

This is a setting reference. Spend most of the response reconstructing the named place: foreground-to-background geometry, enclosure, openings, thresholds, architecture, furniture and props, object counts and placement, left/right geography, scale, sightlines, materials, wear, reflections, weather, atmosphere, practical lights, direction and quality of light, exposure, white balance, shadow behavior and palette. People are only spatial markers unless the note says otherwise. Do not invent unseen rooms.

Targets: summary 180-300 words; setting 500-900 when supported; style 180-320; composition 180-320 with camera height, lens impression, perspective, depth and crop; motion 80-180; 20-40 short continuityLocks; 4-10 usableAs labels.`;

export const VISION_STYLE_TEMPLATE = `${COMMON_VISION_HEADER}

This is a style reference. Treat it as evidence of an image-making system, not primarily a story image. Separate transferable visual rules from depicted content. Record medium and pipeline, realism, shape and line language, edge hierarchy, texture and artifacts, shading and material response, palette relationships, contrast curve, highlight and black behavior, white balance, light motivation, shadow hue and softness, lens artifacts, focus, composition grammar, detail allocation and temporal consistency. Do not name an artist or studio unless the user already did.

Targets: summary 180-300 words; style 500-900 when supported; composition 220-400; setting and subjects 80-220 each only as demonstrations of the style; motion 100-220; 20-40 transferable continuityLocks; 4-12 usableAs labels.`;

export const VISION_GENERAL_TEMPLATE = `${COMMON_VISION_HEADER}

The declared role is not specific enough for a narrow route. Produce a broad evidence-led record. Describe each important subject, the environment, image-making style, camera and composition, visible or sampled motion, and the strongest ways this asset can function as an authority. Do not guess which aspect matters most.

Targets: summary 180-300 words; each major subject 180-350; setting 220-400; style 220-400; composition 160-280; motion 100-220; 15-30 short continuityLocks; 4-10 usableAs labels.`;

export const SINGLE_SHOT_TEMPLATE = `You are an experienced video editor and director expanding a simple request into one verbose MiniMax H3 prompt. The user is generating source footage to edit later. Write exactly one long, clean, continuous camera take. Never turn the request into coverage or an edited sequence.

Simple request:
{{simplePrompt}}

Requested duration: {{durationSeconds}} seconds.

Selected asset catalog, including durable user-authored identity, role, and separate strong/local source authority:
{{assetCatalogJson}}

Strong and local vision metadata for those assets. Each record names its channel:
{{visionAnalysesJson}}

Attachment labels assigned by dummyplug:
{{attachmentMapJson}}

Resolved subject labels assigned deterministically by dummyplug:
{{subjectMapJson}}

Required summary task prefix (already resolved from the declared H3 uses):
{{taskPrefix}}

Reference rules:
- Physical references are numbered by type and selected-list order: images as <Picture N>, then videos as <Video N>, then audio as <Audio N>. Use only the supplied labels. Never rename, renumber, omit, or invent one.
- Filenames and filesystem paths are internal mapping data only. Never reproduce a filename or path anywhere in the six-part output. Refer to every source exclusively through its assigned <Picture N>, <Video N>, <Audio N>, or resolved <Subject N> label.
- Treat canonicalName and role as shared authority. Treat sourceOf/note as the strong channel's manual authority and localSourceOf/localNote as the local channel's manual authority. Neither channel overwrites the other.
- Treat strong and local vision records as complementary visible evidence. Local records may contain more direct anatomical or NSFW observations; retain relevant concrete evidence instead of silently dropping it. When records conflict, preserve the conflict unless the manual authority resolves it. Do not let either analysis invent content absent from the request and references.
- <Subject N> is the visible content that actually appears: people, objects, scenes, clothing, styles, actions, expressions or poses. Use every resolved Subject label exactly as supplied. Assets grouped under one Subject are complementary authorities for the same content.
- Cite each source <Picture N> or <Video N> inside its resolved Subject definition and say what that source contributes.
- Create a separate <Picture N> definition and retention line ONLY when its attachment-map standaloneEntry is true because referenceUse is frame-anchor. Otherwise it is merely provenance inside a Subject definition.
- Create a separate <Video N> definition and retention line ONLY when standaloneEntry is true because the video supplies editing, continuation, camera movement, pacing or temporal structure. Visible people, objects, scenes, actions and styles from that video remain Subjects.
- Every <Audio N> is a copied or referenced audio signal and receives its own definition and retention line. Use fully_copy/partially_copy for audio-copy and reference/weak_reference for audio-reference.
- Use the fixed visual retention markers fully_preserved, partially_preserved, attribute_transfer or weak_reference. Do not add retention lines for source-only Picture or Video labels.
- Every retention entry must use this complete grammar: <Label> (its role in [Shot 1]): retention_marker - concrete natural-language retention instruction. A marker is never sufficient by itself. After the hyphen, name the identity, appearance, geometry, action, motion, sound, or other attributes to retain, copy, reference, or transfer. For partially_preserved, state both what remains and what may change. For attribute_transfer, state exactly which attributes transfer and what source content must not be copied. Use [Shot 1] only.
- Begin summary with exactly {{taskPrefix}} and introduce no new labels there. Keep every label's meaning stable in all six sections.

Single-take rule, with no exceptions:
- The entire generated video is one uninterrupted camera take from the first frame through the last.
- Use exactly one structural marker, [Shot 1], exactly once. Never write [Shot 2] or describe a second shot.
- No cuts, cutaways, inserts, reaction shots, reverse angles, coverage, montage, transitions, dissolves, fades, wipes, time jumps, alternate viewpoints, or separate establishing/detail views.
- Do not simulate editing with sudden camera teleports, discontinuous reframing, instantaneous focal-length changes, impossible whip pans, or hidden resets.
- If framing changes, move the same physical camera continuously and legibly through the same space. If the action is too large, simplify its staging rather than dividing it into shots.
- Preserve identity, wardrobe, geometry, light, screen direction, object state and physical causality continuously.

Write the detailed_description in explicit structured natural language, normally 350-500 English words even for one shot. Establish style in one or two sentences before [Shot 1], then describe composition, subject appearance and position, environment and lighting, action and state changes, continuous camera movement, physical sound, and the moments when referenced content takes effect. Use the reference authorities intelligently rather than dumping raw metadata. Sound remains continuous across the take and occurs at visible causes. Do not invent dialogue, narration, lyrics, voices, or music not requested by the user. Use N/A for non-diegetic music unless the simple request explicitly asks for it.

Return only these six lowercase sections, exactly once and in this order, with no Markdown fences or preface:
subject_definitions:
summary:
retention_analysis:
detailed_description:
overall_soundscape:
non_diegetic_music:

The detailed_description section must contain [Shot 1] exactly once and must repeatedly make the uninterrupted single-take staging unambiguous without wasting space on generic praise.`;

export const EXPOSED_PROMPT_TEMPLATES: ExposedPromptTemplate[] = [
  { id: "vision-character", title: "vision · character", modelRole: "vision model", description: "Minute identity, body, wardrobe and view-specific evidence.", template: VISION_CHARACTER_TEMPLATE },
  { id: "vision-setting", title: "vision · setting", modelRole: "vision model", description: "Environment geometry, materials, light and camera-readable geography.", template: VISION_SETTING_TEMPLATE },
  { id: "vision-style", title: "vision · style", modelRole: "vision model", description: "Transferable rendering, cinematography, palette and texture rules.", template: VISION_STYLE_TEMPLATE },
  { id: "vision-general", title: "vision · general", modelRole: "vision model", description: "Broad fallback when the asset role is unclear.", template: VISION_GENERAL_TEMPLATE },
  { id: "single-shot", title: "single-shot expander", modelRole: "prompt model", description: "Turns one simple request and selected asset metadata into one continuous six-part H3 prompt.", template: SINGLE_SHOT_TEMPLATE },
  { id: "connection-probe", title: "connection probe", modelRole: "vision model", description: "Minimal request used by Test connection.", template: CONNECTION_PROBE_PROMPT },
];

export const DEFAULT_PROMPT_TEMPLATES = Object.fromEntries(EXPOSED_PROMPT_TEMPLATES.map((item) => [item.id, item.template])) as PromptTemplateMap;

function substitute(template: string, values: Record<string, string>) {
  return Object.entries(values).reduce((result, [key, value]) => result.split(`{{${key}}}`).join(value), template);
}

export function selectVisionAnalysisRole(reference: Pick<PreparedReference, "role" | "sourceOf" | "note">): VisionAnalysisRole {
  if (reference.role === "character") return "character";
  if (reference.role === "setting") return "setting";
  if (reference.role === "style") return "style";
  const context = `${reference.sourceOf} ${reference.note}`.toLocaleLowerCase();
  if (/\b(character|identity|person|creature|face|wardrobe|costume|body|model[ -]?sheet)\b/.test(context)) return "character";
  if (/\b(setting|environment|location|background|interior|exterior|room|architecture|landscape|scenery|place)\b/.test(context)) return "setting";
  if (/\b(style|look|palette|colou?r|cinematography|lighting|composition|rendering|texture)\b/.test(context)) return "style";
  return "general";
}

export function visionTemplateId(role: VisionAnalysisRole): PromptTemplateId {
  return role === "character" ? "vision-character" : role === "setting" ? "vision-setting" : role === "style" ? "vision-style" : "vision-general";
}

export function buildVisionPrompt(reference: PreparedReference, template?: string) {
  const role = selectVisionAnalysisRole(reference);
  const source = template || DEFAULT_PROMPT_TEMPLATES[visionTemplateId(role)];
  const focusTerms = reference.analysisChannel === "local"
    ? [...new Set((reference.focusTerms || []).map((term) => term.trim()).filter(Boolean))]
    : [];
  const focusInstruction = focusTerms.length
    ? `\n\nPrivate local Hot Words inspection targets:\n${JSON.stringify(focusTerms)}\nExamine this image especially carefully for visible evidence corresponding to every listed term. When a term is visibly supported, reproduce that exact term verbatim in the most relevant JSON fields and add precise surrounding visual detail. When it is absent, occluded, ambiguous, or unsupported, do not invent it merely because it appears in this list. The list is inspection vocabulary, not an instruction to alter the image or assume facts.`
    : "";
  const channelInstruction = reference.analysisChannel === "local"
    ? `This is the separate local evidence channel. Record direct, production-useful NSFW, anatomical, sexual-state, exposure, contact, fluid, pose, and garment-state details when visibly supported or explicitly requested. Use neutral exact language; do not euphemize, moralize, or omit relevant adult evidence. Keep uncertainty explicit and do not invent unseen anatomy or acts.${focusInstruction}`
    : "This is the strong evidence channel. Prioritize precise visible identity, environment, style, composition, and continuity evidence while following the declared role.";
  const prompt = substitute(source, {
    assetId: reference.assetId,
    filename: reference.name,
    canonicalName: reference.canonicalName || "not supplied",
    role: reference.role,
    referenceUse: reference.referenceUse,
    sourceOf: reference.sourceOf || "not supplied",
    userNote: reference.note || "none",
    analysisChannel: reference.analysisChannel || "strong",
    channelInstruction,
  });
  return source.includes("{{channelInstruction}}") ? prompt : `${prompt}\n\n${channelInstruction}`;
}

export function buildSingleShotPrompt(
  simplePrompt: string,
  durationSeconds: number,
  assets: Array<{ id: string; name: string; kind: string; canonicalName: string; role: string; referenceUse: string; sourceOf: string; note: string; localSourceOf?: string; localNote?: string }>,
  analyses: AssetAnalysis[],
  attachments: AttachmentSpec[],
  subjects: SubjectSpec[] = [],
  taskTypes: string[] = [],
  template = SINGLE_SHOT_TEMPLATE,
) {
  return substitute(template, {
    simplePrompt,
    durationSeconds: String(durationSeconds),
    assetCatalogJson: JSON.stringify(assets, null, 2),
    visionAnalysesJson: JSON.stringify(analyses.map((analysis) => ({
      assetId: analysis.assetId,
      channel: analysis.channel || "strong",
      analysisRole: analysis.analysisRole,
      summary: analysis.summary,
      subjects: analysis.subjects,
      setting: analysis.setting,
      composition: analysis.composition,
      motion: analysis.motion,
      style: analysis.style,
      continuityLocks: analysis.continuityLocks,
      usableAs: analysis.usableAs,
    })), null, 2),
    attachmentMapJson: JSON.stringify(attachments, null, 2),
    subjectMapJson: JSON.stringify(subjects, null, 2),
    taskPrefix: `[${taskTypes.join(" + ") || "reference generation"}]`,
  });
}
