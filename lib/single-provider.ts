import { enforceNonDiegeticMusicNA, validateSingleShotPrompt } from "./single-h3.ts";
import { validateCharacterPolicy } from "./character-policy.ts";
import { buildLocalDirtyProbePrompt, buildLocalDirtyScanPrompt, buildSingleShotPrompt, buildVisionPrompt, CONNECTION_PROBE_PROMPT, selectVisionAnalysisRole, visionTemplateId, type PromptTemplateMap } from "./single-prompts.ts";
import type { AssetAnalysis, AttachmentSpec, CharacterPromptPolicy, DirtyFocusFrameFinding, DirtyFocusStatus, ModelSettings, PreparedReference, SubjectSpec } from "./types.ts";

export const runtime = "edge";

type AssetCatalogItem = { id: string; name: string; kind: string; canonicalName: string; declaredIdentity?: string; resolvedDeclaredIdentity?: string; role: string; referenceUse: string; sourceOf: string; note: string; localSourceOf?: string; localNote?: string };
type ProviderRequest =
  | { action: "test"; settings: ModelSettings; promptTemplates?: Partial<PromptTemplateMap> }
  | { action: "analyze"; settings: ModelSettings; references: PreparedReference[]; promptTemplates?: Partial<PromptTemplateMap> }
  | { action: "expand-single"; settings: ModelSettings; simplePrompt: string; durationSeconds: number; assets: AssetCatalogItem[]; analyses: AssetAnalysis[]; attachments: AttachmentSpec[]; subjects: SubjectSpec[]; taskTypes: string[]; characterPolicy: CharacterPromptPolicy; requireNonDiegeticMusicNA?: boolean; promptTemplates?: Partial<PromptTemplateMap> };

function endpointFor(settings: ModelSettings) {
  if (settings.provider === "openrouter") return "https://openrouter.ai/api/v1/chat/completions";
  const trimmed = settings.baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Enter the local model server address.");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function modelsEndpointFor(settings: ModelSettings) {
  const chatEndpoint = endpointFor(settings);
  return chatEndpoint.replace(/\/chat\/completions$/i, "/models");
}

async function testLocalConnection(settings: ModelSettings, signal: AbortSignal) {
  const endpoint = modelsEndpointFor(settings);
  const headers: Record<string, string> = {};
  if (settings.apiKey.trim()) headers.authorization = `Bearer ${settings.apiKey.trim()}`;
  let response: Response;
  try { response = await fetch(endpoint, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) }); }
  catch (error) { throw new Error(`Could not reach the local model server at ${endpoint}. ${error instanceof Error ? error.message : String(error)}`); }
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 700)}`);
  return `local server connected · ${settings.visionModel}`;
}

function extractContent(payload: unknown) {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "").join("\n");
  throw new Error("The model returned no message content.");
}

function parseJson<T>(text: string): T {
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(unfenced) as T; } catch {
    const start = unfenced.indexOf("{");
    if (start >= 0) {
      let depth = 0;
      let quoted = false;
      let escaped = false;
      for (let index = start; index < unfenced.length; index += 1) {
        const character = unfenced[index];
        if (quoted) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') quoted = false;
          continue;
        }
        if (character === '"') quoted = true;
        else if (character === "{") depth += 1;
        else if (character === "}") {
          depth -= 1;
          if (depth === 0) return JSON.parse(unfenced.slice(start, index + 1)) as T;
        }
      }
    }
    throw new Error("The model response did not contain valid JSON.");
  }
}

export function replaceFilenameReferences(text: string, attachments: AttachmentSpec[]) {
  return attachments.reduce((current, attachment) => {
    if (!attachment.name.trim()) return current;
    const escaped = attachment.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return current.replace(new RegExp(escaped, "gi"), attachment.label);
  }, text);
}

async function chat(settings: ModelSettings, model: string, messages: Array<Record<string, unknown>>, options: { jsonMode?: boolean; timeoutMs?: number; maxTokens?: number; operation?: string; signal?: AbortSignal } = {}) {
  const endpoint = endpointFor(settings);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (settings.apiKey.trim()) headers.authorization = `Bearer ${settings.apiKey.trim()}`;
  if (settings.provider === "openrouter") headers["x-title"] = "dummyplug single-shot desk";
  const timeoutMs = options.timeoutMs ?? 360_000;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: settings.temperature,
        max_tokens: options.maxTokens ?? 4_096,
        ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (options.signal?.aborted) throw new Error(`${options.operation || "Model"} request canceled.`);
    const detail = error instanceof Error ? error.message : String(error);
    if (settings.provider === "local") throw new Error(`Could not reach the local model server at ${endpoint}. ${detail}`);
    throw new Error(`Could not reach OpenRouter. ${detail}`);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string };
      message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message || text;
    } catch { /* retain raw provider text */ }
    throw new Error(`${response.status} ${response.statusText}: ${message.slice(0, 700)}`);
  }
  return extractContent(JSON.parse(text));
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizeAnalysis(candidate: Partial<AssetAnalysis>, reference: PreparedReference): AssetAnalysis {
  return {
    assetId: reference.assetId,
    channel: reference.analysisChannel || "strong",
    analysisRole: selectVisionAnalysisRole(reference),
    summary: String(candidate.summary || `${reference.name}, analyzed by the selected vision model.`),
    subjects: strings(candidate.subjects),
    setting: String(candidate.setting || "Not confidently identified."),
    style: String(candidate.style || "Not confidently identified."),
    composition: String(candidate.composition || "Not confidently identified."),
    motion: String(candidate.motion || "No source motion confidently identified."),
    continuityLocks: strings(candidate.continuityLocks),
    usableAs: strings(candidate.usableAs),
    raw: candidate.raw ? String(candidate.raw) : undefined,
  };
}

function mergeSampleAnalyses(samples: AssetAnalysis[], reference: PreparedReference): AssetAnalysis {
  if (samples.length === 1) return samples[0];
  const joinField = (field: "summary" | "setting" | "style" | "composition" | "motion") => samples
    .map((sample, index) => `Frame ${index + 1}: ${sample[field]}`)
    .join("\n");
  const unique = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];
  return {
    assetId: reference.assetId,
    channel: reference.analysisChannel || "local",
    analysisRole: selectVisionAnalysisRole(reference),
    summary: joinField("summary"),
    subjects: samples.flatMap((sample, index) => sample.subjects.map((subject) => `Frame ${index + 1}: ${subject}`)),
    setting: joinField("setting"),
    style: joinField("style"),
    composition: joinField("composition"),
    motion: joinField("motion"),
    continuityLocks: unique(samples.flatMap((sample) => sample.continuityLocks)),
    usableAs: unique(samples.flatMap((sample) => sample.usableAs)),
    raw: JSON.stringify(samples.map((sample, index) => ({ frame: index + 1, response: sample.raw || "" })), null, 2),
  };
}

type DirtyScanReturn = {
  visibleBody?: unknown;
  presentation?: unknown;
  clothingAndExposure?: unknown;
  contactAndSexualState?: unknown;
  fluidsAndObjects?: unknown;
  uncertainties?: unknown;
  focusFindings?: unknown;
};

function normalizeDirtyStatus(value: unknown): DirtyFocusStatus {
  const status = String(value || "").toLocaleLowerCase();
  return status === "present" || status === "absent" ? status : "unclear";
}

async function analyzeLocalDirty(reference: PreparedReference, settings: ModelSettings, templates: Partial<PromptTemplateMap> | undefined, signal: AbortSignal) {
  const focusTerms = [...new Set((reference.focusTerms || []).map((term) => term.trim()).filter(Boolean))];
  const frames: DirtyFocusFrameFinding[] = [];
  const rawRecords: unknown[] = [];
  for (let index = 0; index < reference.dataUrls.length; index += 1) {
    const dataUrl = reference.dataUrls[index];
    const scanPrompt = buildLocalDirtyScanPrompt(reference, index + 1, reference.dataUrls.length, templates?.["vision-local-dirty"]?.trim() || undefined);
    const scanRaw = await chat(settings, settings.visionModel, [{ role: "user", content: [{ type: "text", text: scanPrompt }, { type: "image_url", image_url: { url: dataUrl } }] }], {
      jsonMode: true, timeoutMs: 360_000, maxTokens: 2_048, operation: `Local dirty scan for ${reference.name} frame ${index + 1}/${reference.dataUrls.length}`, signal,
    });
    const scan = parseJson<DirtyScanReturn>(scanRaw);
    const focusFindings = Array.isArray(scan.focusFindings) ? scan.focusFindings.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
    const termChecks: DirtyFocusFrameFinding["termChecks"] = [];
    for (const term of focusTerms) {
      const finding = focusFindings.find((item) => String(item.term || "").trim().toLocaleLowerCase() === term.toLocaleLowerCase());
      if (finding && normalizeDirtyStatus(finding.status) !== "unclear") {
        termChecks.push({ term, status: normalizeDirtyStatus(finding.status), evidence: `Location: ${String(finding.location || "unknown")}. Appearance: ${String(finding.appearance || "unknown")}. Qualities: ${String(finding.qualities || "unknown")}.` });
        continue;
      }
      const probePrompt = buildLocalDirtyProbePrompt(reference, term, index + 1, reference.dataUrls.length, templates?.["vision-local-probe"]?.trim() || undefined);
      const probeRaw = await chat(settings, settings.visionModel, [{ role: "user", content: [{ type: "text", text: probePrompt }, { type: "image_url", image_url: { url: dataUrl } }] }], {
        jsonMode: true, timeoutMs: 180_000, maxTokens: 384, operation: `Local dirty probe for ${reference.name} frame ${index + 1}/${reference.dataUrls.length}`, signal,
      });
      const probe = parseJson<{ status?: unknown; location?: unknown; appearance?: unknown; qualities?: unknown }>(probeRaw);
      termChecks.push({ term, status: normalizeDirtyStatus(probe.status), evidence: `Location: ${String(probe.location || "unknown")}. Appearance: ${String(probe.appearance || "unknown")}. Qualities: ${String(probe.qualities || "unknown")}.` });
      rawRecords.push({ frame: index + 1, term, probe: probeRaw });
    }
    frames.push({
      frame: index + 1,
      visibleBody: String(scan.visibleBody || "Not confidently identified."),
      presentation: String(scan.presentation || "Not confidently identified."),
      clothingAndExposure: String(scan.clothingAndExposure || "Not confidently identified."),
      contactAndSexualState: String(scan.contactAndSexualState || "Not confidently identified."),
      fluidsAndObjects: String(scan.fluidsAndObjects || "Not confidently identified."),
      uncertainties: strings(scan.uncertainties),
      termChecks,
    });
    rawRecords.push({ frame: index + 1, scan: scanRaw });
  }
  const termChecks = focusTerms.map((term) => {
    const checks = frames.flatMap((frame) => frame.termChecks).filter((check) => check.term.toLocaleLowerCase() === term.toLocaleLowerCase());
    const status: DirtyFocusStatus = checks.some((check) => check.status === "present") ? "present" : checks.length && checks.every((check) => check.status === "absent") ? "absent" : "unclear";
    return { term, status, evidence: checks.map((check) => `Frame ${frames.find((frame) => frame.termChecks.includes(check))?.frame || "?"}: ${check.evidence}`).join(" ") };
  });
  const frameText = frames.map((frame) => `Frame ${frame.frame}: ${frame.visibleBody} ${frame.presentation} ${frame.clothingAndExposure} ${frame.contactAndSexualState} ${frame.fluidsAndObjects}`).join("\n");
  return {
    assetId: reference.assetId,
    channel: "local" as const,
    analysisRole: selectVisionAnalysisRole(reference),
    summary: `${reference.declaredIdentity ? `Declared identity (authored, not inferred): ${reference.declaredIdentity}. ` : ""}${frameText}`,
    subjects: frames.map((frame) => `Frame ${frame.frame}: ${frame.visibleBody}; ${frame.presentation}; ${frame.clothingAndExposure}; ${frame.contactAndSexualState}; ${frame.fluidsAndObjects}`),
    setting: "Not part of the narrow local dirty-focus scan.",
    style: "Not part of the narrow local dirty-focus scan.",
    composition: "Not part of the narrow local dirty-focus scan.",
    motion: frames.length > 1 ? "Compare the sampled frame states; no unsampled motion was inferred." : "No motion inferred from a still image.",
    continuityLocks: [reference.declaredIdentity ? `Authored identity: ${reference.declaredIdentity}.` : "No authored identity supplied.", ...termChecks.filter((check) => check.status === "present").map((check) => `${check.term}: ${check.evidence}`)],
    usableAs: ["dirty focus", ...termChecks.filter((check) => check.status === "present").map((check) => check.term)],
    dirtyFocus: { declaredIdentity: reference.declaredIdentity || "", frames, termChecks },
    raw: JSON.stringify(rawRecords, null, 2),
  } satisfies AssetAnalysis;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as ProviderRequest;
    if (!body?.action || !body.settings) return Response.json({ error: "Malformed request." }, { status: 400 });
    if (body.settings.provider === "demo") return Response.json({ error: "Demo mode does not call a provider." }, { status: 400 });

    if (body.action === "test") {
      const result = body.settings.provider === "local"
        ? await testLocalConnection(body.settings, request.signal)
        : await chat(body.settings, body.settings.visionModel, [{ role: "user", content: body.promptTemplates?.["connection-probe"]?.trim() || CONNECTION_PROBE_PROMPT }], { timeoutMs: 60_000, maxTokens: 32, operation: "Connection test", signal: request.signal });
      return Response.json({ ok: true, message: result.trim().slice(0, 180) });
    }

    if (body.action === "analyze") {
      if (!body.references?.length) return Response.json({ error: "No assets supplied." }, { status: 400 });
      const analyses: AssetAnalysis[] = [];
      for (const reference of body.references) {
        if (body.settings.provider === "local") {
          analyses.push(await analyzeLocalDirty(reference, body.settings, body.promptTemplates, request.signal));
          continue;
        }
        const role = selectVisionAnalysisRole(reference);
        const prompt = buildVisionPrompt(reference, body.promptTemplates?.[visionTemplateId(role)]?.trim() || undefined);
        const splitLocalFrames = false;
        const batches = [reference.dataUrls];
        const samples: AssetAnalysis[] = [];
        for (let index = 0; index < batches.length; index += 1) {
          const framePrompt = splitLocalFrames
            ? `${prompt}\n\nThis is sampled frame ${index + 1} of ${batches.length} from the same source video. Analyze only this frame. Do not claim temporal motion that is not visible in this still; describe pose and state so the three frame records can be compared after all requests finish.`
            : prompt;
          const content: Array<Record<string, unknown>> = [{ type: "text", text: framePrompt }];
          for (const url of batches[index]) content.push({ type: "image_url", image_url: { url } });
          const raw = await chat(body.settings, body.settings.visionModel, [{ role: "user", content }], { jsonMode: true, timeoutMs: 360_000, maxTokens: 8_192, operation: `Vision analysis for ${reference.name}`, signal: request.signal });
          samples.push(normalizeAnalysis({ ...parseJson<Partial<AssetAnalysis>>(raw), raw }, reference));
        }
        analyses.push(mergeSampleAnalyses(samples, reference));
      }
      return Response.json({ analyses });
    }

    if (body.action === "expand-single") {
      if (!body.simplePrompt?.trim()) return Response.json({ error: "Write a simple prompt first." }, { status: 400 });
      if (!body.attachments?.length) return Response.json({ error: "Select at least one asset." }, { status: 400 });
      const prompt = buildSingleShotPrompt(body.simplePrompt, body.durationSeconds, body.assets, body.analyses || [], body.attachments, body.subjects || [], body.taskTypes || [], body.promptTemplates?.["single-shot"]?.trim() || undefined, body.characterPolicy);
      const modelReturn = (await chat(body.settings, body.settings.promptModel, [{ role: "user", content: prompt }], {
        timeoutMs: 600_000,
        maxTokens: Math.max(8_192, Math.min(32_768, Number(body.settings.promptMaxTokens) || 16_384)),
        operation: "Single-shot prompt expansion",
        signal: request.signal,
      })).replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/i, "").trim();
      const replaced = replaceFilenameReferences(modelReturn, body.attachments);
      const raw = body.requireNonDiegeticMusicNA ? enforceNonDiegeticMusicNA(replaced) : replaced;
      const validation = validateSingleShotPrompt(raw, body.attachments, body.subjects || []);
      const characterValidation = validateCharacterPolicy(raw, body.subjects || [], body.characterPolicy);
      if (!validation.valid || !characterValidation.valid) return Response.json({ error: `The prompt model violated the single-shot H3 format or character policy: ${JSON.stringify({ ...validation, characterPolicy: characterValidation })}`, raw, retained: true }, { status: 422 });
      return Response.json({ prompt: raw, raw });
    }

    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (request.signal.aborted) return Response.json({ error: "Request canceled." }, { status: 499 });
    const message = error instanceof Error ? error.message : "Unexpected provider error.";
    console.error("dummyplug provider request failed", error);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ ok: true, service: "dummyplug provider bridge" });
}
