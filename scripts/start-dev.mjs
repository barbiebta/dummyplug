import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const probeUrl = "https://openrouter.ai/api/v1/models";

try {
  const response = await fetch(probeUrl, {
    method: "HEAD",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  console.log(`OpenRouter network preflight reached ${new URL(probeUrl).host} (${response.status}).`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error([
    "Dummyplug did not start because its provider bridge cannot reach OpenRouter.",
    `Network preflight failed: ${detail}`,
    "When Codex starts this server, run `npm run dev` with outbound network permission.",
  ].join("\n"));
  process.exit(1);
}

const vinextCli = fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url));
const child = spawn(process.execPath, [vinextCli, "dev"], {
  env: process.env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Could not start vinext: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
