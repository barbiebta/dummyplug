import type { AssetKind, AssetRecord, AttachmentSpec, SingleShotPrompt, SubjectSpec } from "./types";

function labelFor(kind: AssetKind, index: number) {
  return `<${kind === "image" ? "Picture" : kind === "video" ? "Video" : "Audio"} ${index}>`;
}

function subjectKey(asset: AssetRecord) {
  return asset.canonicalName.trim().toLocaleLowerCase() || `asset:${asset.id}`;
}

export function compileAttachments(assets: AssetRecord[]): Omit<SingleShotPrompt, "prompt"> {
  const counters: Record<AssetKind, number> = { image: 0, video: 0, audio: 0 };
  const attachments = assets.map((asset): AttachmentSpec => {
    counters[asset.kind] += 1;
    const referenceUse = asset.referenceUse || (asset.kind === "audio" ? "audio-reference" : "subject");
    const standaloneEntry = asset.kind === "audio" || referenceUse !== "subject";
    return { assetId: asset.id, label: labelFor(asset.kind, counters[asset.kind]), name: asset.name, kind: asset.kind, referenceUse, standaloneEntry };
  });
  const subjectKeys = new Map<string, SubjectSpec["role"]>();
  for (const asset of assets) {
    if (asset.kind === "audio") continue;
    const key = subjectKey(asset);
    if (!subjectKeys.has(key)) subjectKeys.set(key, asset.role);
  }
  const subjects: SubjectSpec[] = [];
  for (const [key, role] of subjectKeys) {
    const members = assets.map((asset, index) => ({ asset, attachment: attachments[index] })).filter(({ asset }) => subjectKey(asset) === key);
    if (!members.length) continue;
    subjects.push({
      label: `<Subject ${subjects.length + 1}>`,
      canonicalName: members[0].asset.canonicalName.trim() || members[0].asset.name,
      role,
      assetIds: members.map(({ asset }) => asset.id),
      attachmentLabels: members.map(({ attachment }) => attachment.label),
    });
  }
  const warnings: string[] = [];
  if (!attachments.length) warnings.push("Select at least one asset.");
  if (counters.image > 9) warnings.push("MiniMax H3 accepts at most 9 picture references.");
  if (counters.video > 3) warnings.push("MiniMax H3 accepts at most 3 video references.");
  if (counters.audio > 3) warnings.push("MiniMax H3 accepts at most 3 audio references.");
  if (attachments.length > 12) warnings.push("MiniMax H3 accepts at most 12 reference files.");
  if (counters.audio > 0 && counters.image + counters.video === 0) warnings.push("MiniMax H3 requires at least one image or video when audio is selected.");
  for (const asset of assets) {
    const referenceUse = asset.referenceUse || (asset.kind === "audio" ? "audio-reference" : "subject");
    if (asset.kind === "image" && !["subject", "frame-anchor"].includes(referenceUse)) warnings.push(`${asset.name}: choose subject source or frame anchor for an image.`);
    if (asset.kind === "video" && !["subject", "video-structure", "video-edit", "video-continuation"].includes(referenceUse)) warnings.push(`${asset.name}: choose a visual or structural video use.`);
    if (asset.kind === "audio" && !["audio-reference", "audio-copy"].includes(referenceUse)) warnings.push(`${asset.name}: choose audio reference or audio copy.`);
  }
  const taskTypes: string[] = [];
  if (assets.some((asset) => (asset.referenceUse || (asset.kind === "audio" ? "audio-reference" : "subject")) === "subject" || asset.referenceUse === "video-structure")) taskTypes.push("reference generation");
  if (assets.some((asset) => asset.referenceUse === "frame-anchor")) taskTypes.push("keyframe completion");
  if (assets.some((asset) => asset.referenceUse === "video-edit")) taskTypes.push("video editing");
  if (assets.some((asset) => asset.referenceUse === "video-continuation")) taskTypes.push("video continuation");
  if (assets.some((asset) => asset.referenceUse === "audio-copy")) taskTypes.push("audio reuse");
  if (assets.some((asset) => asset.referenceUse === "audio-reference")) taskTypes.push("audio reference");
  return { attachments, subjects, taskTypes, warnings };
}

export function validateSingleShotPrompt(prompt: string, attachments: AttachmentSpec[], subjects: SubjectSpec[] = []) {
  const headings = [
    "subject_definitions:",
    "summary:",
    "retention_analysis:",
    "detailed_description:",
    "overall_soundscape:",
    "non_diegetic_music:",
  ];
  const missing = headings.filter((heading) => !prompt.includes(heading));
  const duplicateHeadings = headings.filter((heading) => prompt.indexOf(heading) !== prompt.lastIndexOf(heading));
  const positions = headings.map((heading) => prompt.indexOf(heading));
  const headingsOutOfOrder = positions.some((position, index) => index > 0 && position <= positions[index - 1]);
  const detailedStart = prompt.indexOf("detailed_description:");
  const detailedEnd = prompt.indexOf("overall_soundscape:");
  const detailedDescription = detailedStart >= 0 && detailedEnd > detailedStart ? prompt.slice(detailedStart + "detailed_description:".length, detailedEnd) : "";
  const shotMarkers = [...detailedDescription.matchAll(/\[Shot\s+(\d+)\]/gi)].map((match) => Number(match[1]));
  const invalidShotMarkers = [...prompt.matchAll(/\[Shot\s+(\d+)\]/gi)].map((match) => Number(match[1])).filter((number) => number !== 1);
  const expectedLabels = new Set(attachments.map((attachment) => attachment.label));
  const usedLabels = new Set([...prompt.matchAll(/<(?:Picture|Video|Audio)\s+\d+>/g)].map((match) => match[0]));
  const missingLabels = [...expectedLabels].filter((label) => !usedLabels.has(label));
  const inventedLabels = [...usedLabels].filter((label) => !expectedLabels.has(label));
  const expectedSubjects = new Set(subjects.map((subject) => subject.label));
  const usedSubjects = new Set([...prompt.matchAll(/<Subject\s+\d+>/g)].map((match) => match[0]));
  const missingSubjects = [...expectedSubjects].filter((label) => !usedSubjects.has(label));
  const inventedSubjects = subjects.length ? [...usedSubjects].filter((label) => !expectedSubjects.has(label)) : [];
  const sectionText = (heading: string, nextHeading: string) => prompt.slice(prompt.indexOf(heading) + heading.length, prompt.indexOf(nextHeading));
  const subjectDefinitions = missing.length ? "" : sectionText("subject_definitions:", "summary:");
  const retentionAnalysis = missing.length ? "" : sectionText("retention_analysis:", "detailed_description:");
  const normalizedRetention = retentionAnalysis.replace(/\r/g, "").replace(/\n(?!\s*<(?:Subject|Picture|Video|Audio)\s+\d+>)/g, " ");
  const startsOwnLine = (text: string, label: string) => new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|:|$)`, "m").test(text);
  const standaloneDefinitionMissing = attachments.filter((attachment) => attachment.standaloneEntry && !startsOwnLine(subjectDefinitions, attachment.label)).map((attachment) => attachment.label);
  const standaloneRetentionMissing = attachments.filter((attachment) => attachment.standaloneEntry && !startsOwnLine(retentionAnalysis, attachment.label)).map((attachment) => attachment.label);
  const sourceOnlyStandaloneDefinitions = attachments.filter((attachment) => !attachment.standaloneEntry && startsOwnLine(subjectDefinitions, attachment.label)).map((attachment) => attachment.label);
  const sourceOnlyRetentionLines = attachments.filter((attachment) => !attachment.standaloneEntry && startsOwnLine(retentionAnalysis, attachment.label)).map((attachment) => attachment.label);
  const retentionLabels = [...subjects.map((subject) => subject.label), ...attachments.filter((attachment) => attachment.standaloneEntry).map((attachment) => attachment.label)];
  const retentionDescriptionMissing = retentionLabels.filter((label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = normalizedRetention.match(new RegExp(`^\\s*${escaped}[^\\n]*?\\b(?:fully_preserved|partially_preserved|attribute_transfer|weak_reference|fully_copy|partially_copy|reference)\\s*-\\s*([^\\n]+)`, "mi"));
    return !match || (match[1].match(/[a-z0-9]+/gi) || []).length < 3;
  });
  return {
    valid: !missing.length && !duplicateHeadings.length && !headingsOutOfOrder && shotMarkers.length === 1 && !invalidShotMarkers.length && !missingLabels.length && !inventedLabels.length && !missingSubjects.length && !inventedSubjects.length && !standaloneDefinitionMissing.length && !standaloneRetentionMissing.length && !sourceOnlyStandaloneDefinitions.length && !sourceOnlyRetentionLines.length && !retentionDescriptionMissing.length,
    missing,
    duplicateHeadings,
    headingsOutOfOrder,
    shotMarkers,
    invalidShotMarkers,
    missingLabels,
    inventedLabels,
    missingSubjects,
    inventedSubjects,
    standaloneDefinitionMissing,
    standaloneRetentionMissing,
    sourceOnlyStandaloneDefinitions,
    sourceOnlyRetentionLines,
    retentionDescriptionMissing,
  };
}

export function hasNonDiegeticMusicNA(prompt: string) {
  return /^[ \t]*non_diegetic_music:[ \t]*N\/A[ \t]*$/mi.test(prompt)
    || /^[ \t]*non_diegetic_music:[ \t]*\r?\n[ \t]*N\/A[ \t]*$/mi.test(prompt);
}

export function enforceNonDiegeticMusicNA(prompt: string) {
  const heading = "non_diegetic_music:";
  const index = prompt.toLocaleLowerCase().lastIndexOf(heading);
  if (index < 0) return `${prompt.trimEnd()}\n${heading} N/A`;
  return `${prompt.slice(0, index).trimEnd()}\n${heading} N/A`;
}

export function makeDemoAnalysis(asset: AssetRecord) {
  return {
    assetId: asset.id,
    analysisRole: (asset.role === "character" || asset.role === "setting" || asset.role === "style" ? asset.role : "general") as "character" | "setting" | "style" | "general",
    summary: `${asset.name}: ${asset.canonicalName || "unnamed asset"}. ${asset.sourceOf || asset.note || "No manual authority was supplied."} Demo mode records manual metadata only; connect a vision model for visible specifics.`,
    subjects: asset.role === "character" || asset.role === "prop" ? [asset.note || asset.canonicalName || asset.name] : [],
    setting: asset.role === "setting" ? asset.note || asset.sourceOf : "",
    style: asset.role === "style" ? asset.note || asset.sourceOf : "",
    composition: "Not visually analyzed in demo mode.",
    motion: asset.kind === "video" ? asset.sourceOf || "Source video motion." : "No sampled motion.",
    continuityLocks: [asset.sourceOf || asset.note || "Preserve the user-declared authority."],
    usableAs: [asset.role, asset.sourceOf].filter(Boolean),
    raw: "Generated by dummyplug offline demo mode.",
  };
}
