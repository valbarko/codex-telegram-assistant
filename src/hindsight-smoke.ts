import { randomUUID } from "node:crypto";

import { HindsightClient } from "@vectorize-io/hindsight-client";

import { readConfiguration } from "./configuration.js";

const configuration = readConfiguration();
const client = new HindsightClient({
  baseUrl: configuration.hindsightBaseUrl,
  apiKey: configuration.hindsightApiKey,
  userAgent: "codex-telegram-assistant-smoke/0.1",
});
const bankId = `cta-smoke-${randomUUID()}`;

try {
  const version = await client.getVersion({ signal: AbortSignal.timeout(configuration.hindsightTimeoutMs) });
  console.log(`Connected to Hindsight ${version.api_version}`);
  await client.createBank(bankId, {
    reflectMission: "Answer briefly and only from retained memories.",
    signal: AbortSignal.timeout(configuration.hindsightTimeoutMs),
  });
  await client.retain(bankId, "Валентин предпочитает чай без сахара.", {
    context: "Проверочная запись, не настоящая персональная память.",
    documentId: "smoke-memory",
    async: false,
    signal: AbortSignal.timeout(configuration.hindsightTimeoutMs),
  });
  const recall = await client.recall(bankId, "Какой чай предпочитает Валентин?", {
    budget: "low",
    signal: AbortSignal.timeout(configuration.hindsightTimeoutMs),
  });
  const reflection = await client.reflect(bankId, "Какой чай предпочитает Валентин?", {
    budget: "low",
    signal: AbortSignal.timeout(configuration.hindsightTimeoutMs),
  });
  if (!recall.results.length || !reflection.text.trim()) throw new Error("Hindsight returned an empty smoke-test result");
  console.log(`Recall results: ${recall.results.length}`);
  console.log(`Reflect: ${reflection.text.replace(/\s+/g, " ").slice(0, 300)}`);
} finally {
  await client.deleteBank(bankId, { signal: AbortSignal.timeout(configuration.hindsightTimeoutMs) }).catch(() => undefined);
}
