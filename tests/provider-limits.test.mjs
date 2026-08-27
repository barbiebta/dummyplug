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

test("local connection test uses the models endpoint instead of sending JoyCaption a zero-image chat", async () => {
  const originalFetch = globalThis.fetch;
  let observedUrl = "";
  let observedMethod = "";
  globalThis.fetch = async (url, init) => {
    observedUrl = String(url);
    observedMethod = String(init?.method || "GET");
    return Response.json({ data: [{ id: "joycaption" }] });
  };
  try {
    const response = await POST(new Request("http://localhost/api/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "test", settings: { ...settings, provider: "local", baseUrl: "http://127.0.0.1:8080", visionModel: "joycaption" } }) }));
    assert.equal(response.status, 200);
    assert.equal(observedUrl, "http://127.0.0.1:8080/v1/models");
    assert.equal(observedMethod, "GET");
  } finally { globalThis.fetch = originalFetch; }
});

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

test("local vision analysis preserves its channel through the provider response", async () => {
  const originalFetch = globalThis.fetch;
  let observed;
  globalThis.fetch = async (_url, init) => {
    observed = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: `${JSON.stringify({ visibleBody: "Direct local evidence.", presentation: "feminine", clothingAndExposure: "clothed", contactAndSexualState: "none", fluidsAndObjects: "none", uncertainties: [], focusFindings: [] })}\nJoyCaption trailing note` } }] });
  };
  try {
    const response = await POST(new Request("http://localhost/api/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "analyze", settings: { ...settings, provider: "local", baseUrl: "http://127.0.0.1:8080", visionModel: "local-vision" }, references: [{ assetId: "rabbit", analysisChannel: "local", name: "rabbit.png", kind: "image", canonicalName: "Rabbit", declaredIdentity: "transgender woman; she/her", role: "character", referenceUse: "subject", sourceOf: "explicit anatomy", note: "local note", dataUrls: ["data:image/jpeg;base64,AA=="] }] }) }));
    assert.equal(response.status, 200);
    assert.match(observed.messages[0].content[0].text, /Do not write a general caption/);
    assert.match(observed.messages[0].content[0].text, /location, appearance, and qualities/i);
    const analysis = (await response.json()).analyses[0];
    assert.equal(analysis.channel, "local");
    assert.equal(analysis.dirtyFocus.declaredIdentity, "transgender woman; she/her");
  } finally { globalThis.fetch = originalFetch; }
});

test("local video analysis sends sampled frames to JoyCaption one at a time and merges them", async () => {
  const originalFetch = globalThis.fetch;
  const observed = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    observed.push(body);
    const frame = observed.length;
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      visibleBody: `frame ${frame} body evidence`, presentation: `presentation ${frame}`, clothingAndExposure: `clothing ${frame}`,
      contactAndSexualState: `state ${frame}`, fluidsAndObjects: `objects ${frame}`, uncertainties: [], focusFindings: [],
    }) } }] });
  };
  try {
    const response = await POST(new Request("http://localhost/api/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      action: "analyze",
      settings: { ...settings, provider: "local", baseUrl: "http://127.0.0.1:8080", visionModel: "joycaption" },
      references: [{ assetId: "rabbit-video", analysisChannel: "local", name: "rabbit.mov", kind: "video", canonicalName: "Rabbit", declaredIdentity: "transgender woman", role: "character", referenceUse: "subject", sourceOf: "performance", note: "", dataUrls: ["data:image/jpeg;base64,AA==", "data:image/jpeg;base64,BB==", "data:image/jpeg;base64,CC=="] }],
    }) }));
    assert.equal(response.status, 200);
    assert.equal(observed.length, 3);
    assert.deepEqual(observed.map((requestBody) => requestBody.messages[0].content.filter((part) => part.type === "image_url").length), [1, 1, 1]);
    assert.deepEqual(observed.map((requestBody) => requestBody.max_tokens), [2048, 2048, 2048]);
    assert.match(observed[0].messages[0].content[0].text, /frame:\s*1 of 3/i);
    assert.match(observed[2].messages[0].content[0].text, /frame:\s*3 of 3/i);
    const analysis = (await response.json()).analyses[0];
    assert.equal(analysis.channel, "local");
    assert.match(analysis.summary, /Frame 1: frame 1 body evidence/);
    assert.match(analysis.summary, /Frame 3: frame 3 body evidence/);
    assert.equal(analysis.dirtyFocus.frames.length, 3);
    assert.match(analysis.continuityLocks[0], /Authored identity: transgender woman/);
  } finally { globalThis.fetch = originalFetch; }
});

test("local dirty focus probes each unresolved term with one-image JoyCaption requests", async () => {
  const originalFetch = globalThis.fetch;
  const observed = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    observed.push(body);
    const content = observed.length === 1
      ? { visibleBody: "visible subject", presentation: "presentation", clothingAndExposure: "clothed", contactAndSexualState: "none", fluidsAndObjects: "none", uncertainties: [], focusFindings: [{ term: "red ribbon", status: "present", location: "neck", appearance: "red", qualities: "silk" }] }
      : { status: "unclear", location: "unknown", appearance: "occluded", qualities: "not visible" };
    return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
  };
  try {
    const response = await POST(new Request("http://localhost/api/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      action: "analyze",
      settings: { ...settings, provider: "local", baseUrl: "http://127.0.0.1:8080", visionModel: "joycaption" },
      references: [{ assetId: "rabbit", analysisChannel: "local", name: "rabbit.png", kind: "image", canonicalName: "Rabbit", declaredIdentity: "transgender woman", role: "character", referenceUse: "subject", sourceOf: "body details", note: "", focusTerms: ["red ribbon", "silver ring"], dataUrls: ["data:image/jpeg;base64,AA=="] }],
    }) }));
    assert.equal(response.status, 200);
    assert.equal(observed.length, 2);
    assert.match(observed[0].messages[0].content[0].text, /"red ribbon","silver ring"/);
    assert.match(observed[1].messages[0].content[0].text, /Target term: silver ring/);
    assert.deepEqual(observed.map((body) => body.messages[0].content.filter((part) => part.type === "image_url").length), [1, 1]);
    const analysis = (await response.json()).analyses[0];
    assert.deepEqual(analysis.dirtyFocus.termChecks.map(({ term, status }) => ({ term, status })), [{ term: "red ribbon", status: "present" }, { term: "silver ring", status: "unclear" }]);
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

test("checked no-music guard normalizes the provider return before validation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: validSingle.replace("non_diegetic_music:\nN/A", "non_diegetic_music:\nominous strings") } }] });
  try {
    const response = await POST(new Request("http://localhost/api/provider", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "expand-single", settings, simplePrompt: "Rabbit walks.", durationSeconds: 10, assets: [{ id: "rabbit", name: "rabbit.png", kind: "image", canonicalName: "Rabbit", role: "character", referenceUse: "subject", sourceOf: "identity", note: "" }], analyses: [], attachments: [attachment], subjects: [subject], taskTypes: ["reference generation"], requireNonDiegeticMusicNA: true }) }));
    assert.equal(response.status, 200);
    assert.match((await response.json()).prompt, /non_diegetic_music: N\/A$/);
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
