import path from "node:path";

import { AppleNotesImporter, formatAppleNotesImportResult } from "./apple-notes.js";
import { readConfiguration } from "./configuration.js";
import { MemoryService } from "./memory-service.js";
import { AssistantDatabase } from "./storage.js";

const configuration = readConfiguration();
if (!configuration.appleNotesImportOwner) {
  throw new Error("Set APPLE_NOTES_IMPORT_OWNER_ID before importing Apple Notes");
}

const database = new AssistantDatabase(path.join(configuration.dataDirectory, "assistant.sqlite"));
try {
  const memory = new MemoryService(configuration.dataDirectory, configuration.memsearchExecutable, database);
  const importer = new AppleNotesImporter({
    enabled: true,
    owner: configuration.appleNotesImportOwner,
    intervalMs: configuration.appleNotesImportIntervalMs,
    includeProtected: configuration.appleNotesImportProtected,
  }, memory);
  const result = await importer.sync();
  await memory.flush(configuration.appleNotesImportOwner);
  console.log(formatAppleNotesImportResult(result));
} finally {
  database.close();
}
