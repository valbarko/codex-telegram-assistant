import { describe, expect, it, vi } from "vitest";

import { logInternalError, publicErrorMessage } from "../src/public-errors.js";

describe("public errors", () => {
  it("returns only fixed user-safe messages", () => {
    const internal = "Command failed: /usr/bin/secret --token abc\nTraceback: /Users/private/file.ts";

    expect(publicErrorMessage("request")).toBe("Не удалось выполнить запрос. Попробуйте ещё раз.");
    expect(publicErrorMessage("request")).not.toContain(internal);
    expect(Object.values([
      publicErrorMessage("scheduled-task"), publicErrorMessage("forwarded-voice"),
      publicErrorMessage("writing"), publicErrorMessage("media-summary"),
    ]).join(" ")).not.toMatch(/command|traceback|\/Users\/|token/iu);
  });

  it("writes complete internal errors to the log", () => {
    const error = new Error("private system detail");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logInternalError("Codex request failed", error);

    expect(spy).toHaveBeenCalledWith("Codex request failed", error);
    spy.mockRestore();
  });
});
