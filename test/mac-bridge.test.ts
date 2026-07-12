import { describe, expect, it } from "vitest";

import { shortcutDateInput } from "../src/mac-bridge.js";

describe("system alarm shortcut input", () => {
  it("passes an unambiguous local date and time to Shortcuts", () => {
    const value = new Date("2026-07-12T14:00:00+03:00").getTime();
    expect(shortcutDateInput(value)).toBe("2026-07-12 14:00:00");
  });
});
