import path from "node:path";

import { readConfiguration } from "./configuration.js";
import { HindsightKnowledgeService } from "./hindsight-service.js";
import { AssistantDatabase } from "./storage.js";

const configuration = readConfiguration();
if (!configuration.hindsightEnabled) throw new Error("Set HINDSIGHT_ENABLED=true before running the backfill");

const requestedLimit = Number(process.argv[2] ?? 500);
if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 5_000) {
  throw new Error("Backfill limit must be an integer from 1 to 5000");
}

const database = new AssistantDatabase(path.join(configuration.dataDirectory, "assistant.sqlite"));
const hindsight = new HindsightKnowledgeService(configuration);

try {
  const version = await hindsight.health();
  console.log(`Hindsight ${version} is available at ${configuration.hindsightBaseUrl}`);
  for (const userId of configuration.allowedUsers) {
    const owner = String(userId);
    const events = database.memoryEvents(owner, { limit: requestedLimit });
    const submitted = await hindsight.backfill(events);
    console.log(`Submitted ${submitted} memory events for owner ${owner}`);
  }
} finally {
  database.close();
}
