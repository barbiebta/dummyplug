import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VERB_FAMILIES, DEFAULT_VERB_VOCABULARY, createJobId, deriveJobDesc, detectVerbs, stableStringify } from "../lib/job-identity.ts";

test("default vocabulary is broad and excludes every form of be", () => {
  assert.ok(DEFAULT_VERB_FAMILIES.length >= 100);
  assert.ok(DEFAULT_VERB_VOCABULARY.length >= 300);
  assert.deepEqual(detectVerbs("is are was were be being been"), []);
});

test("verb matching is case insensitive, whole word, and ordered", () => {
  assert.deepEqual(detectVerbs("RABBIT walks, then WALKED; a walker waits." ).map((hit) => [hit.word, hit.lemma]), [["walks", "walk"], ["WALKED", "walk"], ["waits", "wait"]]);
});

test("description alternates prompt-matched assets and verbs", () => {
  const assets = [{ canonicalName: "Rabbit", name: "rabbit.png" }, { canonicalName: "Rooftop", name: "roof.jpg" }];
  assert.equal(deriveJobDesc("Rabbit walks across Rooftop", assets), "Rabbit walk Rooftop");
  assert.equal(deriveJobDesc("anything", assets, "  My custom job  "), "My custom job");
  assert.equal(deriveJobDesc("rabbit-front walks", [{ canonicalName: "Rabbit", name: "rabbit-front.png" }]), "Rabbit walk");
  assert.equal(deriveJobDesc("walks and runs", []), "job");
});

test("derived descriptions truncate to 30 chars with ellipsis", () => {
  const result = deriveJobDesc("alpha walks beta runs gamma jumps", [{ name: "alpha-long.png" }, { name: "beta-long.png" }, { name: "gamma-long.png" }]);
  assert.ok(result.length <= 30);
  assert.ok(result.endsWith("...") || result.length <= 30);
});

test("stable stringify sorts object keys but preserves arrays", () => {
  assert.equal(stableStringify({ b: 2, a: ["x", 1] }), '{"a":["x",1],"b":2}');
});

test("job IDs are deterministic and use safe description prefix", async () => {
  const a = await createJobId("Rabbit walks!", { seed: 1, assets: ["a"] });
  const b = await createJobId("Rabbit walks!", { assets: ["a"], seed: 1 });
  const c = await createJobId("Rabbit walks!", { seed: 2, assets: ["a"] });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^Rabbitwa_[0-9a-f]{8}$/);
});
