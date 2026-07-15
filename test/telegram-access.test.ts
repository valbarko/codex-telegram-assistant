import { describe, expect, it } from "vitest";

import { isTranscriptionMedia, telegramAccessMode } from "../src/telegram-access.js";

const configuration = {
  allowedUsers: new Set([1]),
  transcriptionOnlyUsers: new Set([42, 43]),
};

describe("telegram access", () => {
  it("keeps full, transcription-only, and denied users separate", () => {
    expect(telegramAccessMode(configuration, 1)).toBe("full");
    expect(telegramAccessMode(configuration, 42)).toBe("transcription-only");
    expect(telegramAccessMode(configuration, 43)).toBe("transcription-only");
    expect(telegramAccessMode(configuration, 2)).toBe("denied");
    expect(telegramAccessMode(configuration)).toBe("denied");
  });

  it("accepts only voice and audio as transcription media", () => {
    expect(isTranscriptionMedia({ message: { voice: {} } })).toBe(true);
    expect(isTranscriptionMedia({ message: { audio: {} } })).toBe(true);
    expect(isTranscriptionMedia({ message: {} })).toBe(false);
    expect(isTranscriptionMedia({ message: { voice: undefined, audio: undefined } })).toBe(false);
    expect(isTranscriptionMedia({})).toBe(false);
  });
});
