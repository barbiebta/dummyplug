import assert from "node:assert/strict";
import test from "node:test";
import { auditHotWords, parseHotWords } from "../lib/hot-words.ts";

const asset = {
  id: "rabbit", name: "rabbit.png", kind: "image", size: 1, mimeType: "image/png", previewUrl: "blob:test", selected: true,
  canonicalName: "Rabbit", role: "character", referenceUse: "subject", sourceOf: "identity and velvet collar", note: "",
  localSourceOf: "private body detail", localNote: "local authority", analysis: undefined,
  localAnalysis: { assetId: "rabbit", channel: "local", summary: "copper curls", subjects: [], setting: "", style: "", composition: "", motion: "", continuityLocks: [], usableAs: [] },
};

test("Hot Words are parsed one term per line without case-duplicate entries", () => {
  assert.deepEqual(parseHotWords("Velvet collar\nprivate body detail\nvelvet COLLAR\n\n"), ["Velvet collar", "private body detail"]);
});

test("Hot Words separately report metadata and simple-prompt omissions", () => {
  const result = auditHotWords(
    ["velvet collar", "private body detail", "copper curls", "crosses"],
    "Rabbit crosses the room.",
    [asset],
    "Rabbit with a velvet collar walks into the room.",
  );
  assert.deepEqual(result.missingFromMetadata, ["private body detail", "copper curls"]);
  assert.deepEqual(result.missingFromSimplePrompt, ["crosses"]);
});
