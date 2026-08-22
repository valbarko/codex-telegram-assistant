import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readConfiguration } from "./configuration.js";

const execFileAsync = promisify(execFile);

export interface WatchdogHeartbeat {
  updatedAt?: number;
  polling?: boolean;
  activeJob?: { id?: string; lastEventAt?: number; startedAt?: number };
}

export interface WatchdogDecision {
  restart: boolean;
  reason?: string;
}

export function heartbeatNeedsRestart(heartbeat: WatchdogHeartbeat | undefined, now: number,
  staleMs: number, activeJobStaleMs: number): WatchdogDecision {
  if (!heartbeat || typeof heartbeat.updatedAt !== "number") {
    return { restart: true, reason: "heartbeat is missing or invalid" };
  }
  if (now - heartbeat.updatedAt > staleMs) {
    return { restart: true, reason: `heartbeat is ${now - heartbeat.updatedAt} ms old` };
  }
  if (heartbeat.polling === false) return { restart: true, reason: "Telegram runner is not polling" };
  if (heartbeat.activeJob) {
    const activity = heartbeat.activeJob.lastEventAt ?? heartbeat.activeJob.startedAt;
    if (typeof activity === "number" && now - activity > activeJobStaleMs) {
      return { restart: true, reason: `job ${heartbeat.activeJob.id ?? "unknown"} has no events for ${now - activity} ms` };
    }
  }
  return { restart: false };
}

async function main(): Promise<void> {
  const [root, label] = process.argv.slice(2);
  if (!root || !label) throw new Error("Usage: watchdog <application-root> <launch-agent-label>");
  const configuration = readConfiguration(root);
  const heartbeatFile = configuration.heartbeatFile;
  const staleMs = configuration.watchdogStaleMs;
  const activeJobStaleMs = configuration.assistantInactivityTimeoutMs + 2 * 60_000;
  let heartbeat: WatchdogHeartbeat | undefined;
  try {
    heartbeat = JSON.parse(await readFile(heartbeatFile, "utf8")) as WatchdogHeartbeat;
  } catch {
    heartbeat = undefined;
  }
  const decision = heartbeatNeedsRestart(heartbeat, Date.now(), staleMs, activeJobStaleMs);
  if (!decision.restart) return;
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  console.error(`Watchdog restarting ${label}: ${decision.reason}`);
  await execFileAsync("/bin/launchctl", ["kickstart", "-k", `${domain}/${label}`], { timeout: 30_000 });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
