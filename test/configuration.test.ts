import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readConfiguration } from "../src/configuration.js";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe("readConfiguration", () => {
  it("loads private defaults without depending on a machine username", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "cta-config-")); folders.push(cwd);
    const config = readConfiguration(cwd, { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ALLOWED_USER_IDS: "12,34", HOME: "/home/person" });
    expect(config.allowedUsers).toEqual(new Set([12, 34]));
    expect(config.dataDirectory).toBe("/home/person/.local/share/codex-telegram-assistant");
    expect(config.memsearchExecutable).toBe("/home/person/.local/bin/memsearch");
    expect(config.profiles.map((profile) => profile.id)).toEqual(["default", "review", "readonly"]);
  });

  it("rejects missing secrets and unknown profiles", () => {
    expect(() => readConfiguration("/tmp", {})).toThrow("TELEGRAM_BOT_TOKEN");
    expect(() => readConfiguration("/tmp", { TELEGRAM_BOT_TOKEN: "x", TELEGRAM_ALLOWED_USER_IDS: "1", ASSISTANT_DEFAULT_PROFILE: "missing" })).toThrow("Unknown ASSISTANT_DEFAULT_PROFILE");
  });
});
