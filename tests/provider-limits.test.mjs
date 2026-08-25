import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/provider/route.ts";

const settings = { provider: "openrouter", visionModel: "vision-model", promptModel: "prompt-model", baseUrl: "", apiKey: "test-key", rememberKey: false, temperature: 0.2, promptMaxTokens: 32_768 };
const attachment = { assetId: "rabbit", label: "<Picture 1>", name: "rabbit.png", kind: "image", referenceUse: "subject", standaloneEntry: false };
const subject = { label: "<Subject 1>", canonicalName: "Rabbit", role: "character", assetIds: ["rabbit"], attachmentLabels: ["<Picture 1>"] };
const validSingle = [
  "subject_definitions:", "<Subject 1> is Rabbit from <Picture 1>.",
  "summary:", "[reference generation] One continuous ten-second take.",
  "retention_analysis:", "<Subject 1> (appears in [Shot 1]): fully_preserved - identity is preserved.",
  "detailed_description:", "[Shot 1] The same camera tracks Rabbit left to right without interruption.",
  "overall_soundscape:", "Continuous exterior ambience and synchronized footsteps.",
  "non_diegetic_music:", "N/A",
].join("\n");

test("vision analysis uses the role-routed recipe and expanded allowance", async () => {
  const originalFetch = globalThis.fetch;
  let observed;
  globalThis.fetch = async (_url, init) => {
    observed = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "Rabbit visible.", subjects: ["Rabbit"], setting: "outside", style: "painted", composition: "full body", motion: "still", continuityLocks: ["long ears"], usableAs: ["identity"] }) } }] });
  };
  try {
    const response = await POST(new Request("http://localhost/api/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "analyze", settings, references: [{ assetId: "rabbit", name: "rabbit.png", kind: "image", canonicalName: "Rabbit", role: "character", referenceUse: "subject", sourceOf: "identity", note: "main character", dataUrls: ["data:image/jpeg;base64,AA=="] }] }) }));
    assert.equal(response.status, 200);
    assert.equal(observed.model, "vision-model");
    assert.equal(observed.max_tokens, 8_192);
    assert.match(observed.messages[0].content[0].text, /This is a character reference/);
  } finally { globalThis.fetch = originalFetch; }
});

test("single-shot expansion uses the prompt model and one-take recipe", async () => {
  const originalFetch = globalThis.fetch;
  let observed;
  globalThis.fetch = async (_url, init) => {
    observed = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: validSingle } }] });
  };
  try {
    const response = await POST(new Request("http://localhost/api/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "expand-single", settings, simplePrompt: "Rabbit walks left to right.", durationSeconds: 10, assets: [{ id: "rabbit", name: "rabbit.png", kind: "image", canonicalName: "Rabbit", role: "character", referenceUse: "subject", sourceOf: "identity and wardrobe", note: "happy" }], analyses: [], attachments: [attachment], subjects: [subject], taskTypes: ["reference generation"] }) }));
    assert.equal(response.status, 200);
    assert.equal(observed.model, "prompt-model");
    assert.equal(observed.max_tokens, 32_768);
    assert.match(observed.messages[0].content, /No cuts, cutaways, inserts/);
    assert.match(observed.messages[0].content, /"sourceOf": "identity and wardrobe"/);
    assert.equal((await response.json()).prompt, validSingle);
  } finally { globalThis.fetch = originalFetch; }
});

test("single-shot expansion retains a response that introduces a second shot", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: `${validSingle}\n[Shot 2] cutaway` } }] });
  try {
    const response = await POST(new Request("http://localhost/api/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "expand-single", settings, simplePrompt: "Rabbit walks.", durationSeconds: 10, assets: [{ id: "rabbit", name: "rabbit.png", kind: "image", canonicalName: "Rabbit", role: "character", referenceUse: "subject", sourceOf: "identity", note: "" }], analyses: [], attachments: [attachment], subjects: [subject], taskTypes: ["reference generation"] }) }));
    assert.equal(response.status, 422);
    const payload = await response.json();
    assert.equal(payload.retained, true);
    assert.match(payload.raw, /\[Shot 2\]/);
  } finally { globalThis.fetch = originalFetch; }
});
