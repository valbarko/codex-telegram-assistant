import { describe, expect, it } from "vitest";

import { heartbeatNeedsRestart } from "../src/watchdog.js";

describe("heartbeatNeedsRestart", () => {
  it("keeps an idle healthy bot running", () => {
    expect(heartbeatNeedsRestart({ updatedAt: 95_000 }, 100_000, 10_000, 20_000)).toEqual({ restart: false });
  });

  it("restarts a process with a stale heartbeat", () => {
    expect(heartbeatNeedsRestart({ updatedAt: 80_000 }, 100_000, 10_000, 20_000)).toMatchObject({
      restart: true,
      reason: expect.stringContaining("heartbeat"),
    });
  });

  it("restarts a live process when the Telegram runner has stopped", () => {
    expect(heartbeatNeedsRestart({ updatedAt: 99_000, polling: false }, 100_000, 10_000, 20_000))
      .toMatchObject({ restart: true, reason: expect.stringContaining("runner") });
  });

  it("restarts a live process whose active Codex job has stopped producing events", () => {
    expect(heartbeatNeedsRestart({
      updatedAt: 99_000,
      activeJob: { id: "job-1", startedAt: 50_000, lastEventAt: 60_000 },
    }, 100_000, 10_000, 20_000)).toMatchObject({ restart: true, reason: expect.stringContaining("job-1") });
  });
});
