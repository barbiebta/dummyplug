import { validateSingleShotPrompt } from "./single-h3.ts";
import { buildSingleShotPrompt, buildVisionPrompt, CONNECTION_PROBE_PROMPT, selectVisionAnalysisRole, visionTemplateId, type PromptTemplateMap } from "./single-prompts.ts";
import type { AssetAnalysis, AttachmentSpec, ModelSettings, PreparedReference, SubjectSpec } from "./types.ts";

export const runtime = "edge";

type AssetCatalogItem = { id: string; name: string; kind: string; canonicalName: string; role: string; referenceUse: string; sourceOf: string; note: string };
type ProviderRequest =
  | { action: "test"; settings: ModelSettings; promptTemplates?: Partial<PromptTemplateMap> }
  | { action: "analyze"; settings: ModelSettings; references: PreparedReference[]; promptTemplates?: Partial<PromptTemplateMap> }
  | { action: "expand-single"; settings: ModelSettings; simplePrompt: string; durationSeconds: number; assets: AssetCatalogItem[]; analyses: AssetAnalysis[]; attachments: AttachmentSpec[]; subjects: SubjectSpec[]; taskTypes: string[]; promptTemplates?: Partial<PromptTemplateMap> };

function endpointFor(settings: ModelSettings) {
  if (settings.provider === "openrouter") return "https://openrouter.ai/api/v1/chat/completions";
  const trimmed = settings.baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Enter the local model server address.");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
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
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1)) as T;
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

export async function POST(request: Request) {
  try {
    const body = await request.json() as ProviderRequest;
    if (!body?.action || !body.settings) return Response.json({ error: "Malformed request." }, { status: 400 });
    if (body.settings.provider === "demo") return Response.json({ error: "Demo mode does not call a provider." }, { status: 400 });

    if (body.action === "test") {
      const result = await chat(body.settings, body.settings.visionModel, [{ role: "user", content: body.promptTemplates?.["connection-probe"]?.trim() || CONNECTION_PROBE_PROMPT }], { timeoutMs: 60_000, maxTokens: 32, operation: "Connection test", signal: request.signal });
      return Response.json({ ok: true, message: result.trim().slice(0, 180) });
    }

    if (body.action === "analyze") {
      if (!body.references?.length) return Response.json({ error: "No assets supplied." }, { status: 400 });
      const analyses: AssetAnalysis[] = [];
      for (const reference of body.references) {
        const role = selectVisionAnalysisRole(reference);
        const prompt = buildVisionPrompt(reference, body.promptTemplates?.[visionTemplateId(role)]?.trim() || undefined);
        const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
        for (const url of reference.dataUrls) content.push({ type: "image_url", image_url: { url } });
        const raw = await chat(body.settings, body.settings.visionModel, [{ role: "user", content }], { jsonMode: true, timeoutMs: 360_000, maxTokens: 8_192, operation: `Vision analysis for ${reference.name}`, signal: request.signal });
        analyses.push(normalizeAnalysis({ ...parseJson<Partial<AssetAnalysis>>(raw), raw }, reference));
      }
      return Response.json({ analyses });
    }

    if (body.action === "expand-single") {
      if (!body.simplePrompt?.trim()) return Response.json({ error: "Write a simple prompt first." }, { status: 400 });
      if (!body.attachments?.length) return Response.json({ error: "Select at least one asset." }, { status: 400 });
      const prompt = buildSingleShotPrompt(body.simplePrompt, body.durationSeconds, body.assets, body.analyses || [], body.attachments, body.subjects || [], body.taskTypes || [], body.promptTemplates?.["single-shot"]?.trim() || undefined);
      const modelReturn = (await chat(body.settings, body.settings.promptModel, [{ role: "user", content: prompt }], {
        timeoutMs: 600_000,
        maxTokens: Math.max(8_192, Math.min(32_768, Number(body.settings.promptMaxTokens) || 16_384)),
        operation: "Single-shot prompt expansion",
        signal: request.signal,
      })).replace(/^```(?:text|markdown)?\s*/i, "").replace(/\s*```$/i, "").trim();
      const raw = replaceFilenameReferences(modelReturn, body.attachments);
      const validation = validateSingleShotPrompt(raw, body.attachments, body.subjects || []);
      if (!validation.valid) return Response.json({ error: `The prompt model violated the single-shot H3 format: ${JSON.stringify(validation)}`, raw, retained: true }, { status: 422 });
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
