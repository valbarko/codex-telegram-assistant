import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.fn(() => {
  throw new Error("spawn observed");
});

vi.mock("node:child_process", () => ({ spawn }));

describe("AppServerTransport executable discovery", () => {
  afterEach(() => {
    delete process.env.CODEX_CLI_PATH;
    vi.resetModules();
    spawn.mockClear();
  });

  it("honors an explicit executable path", async () => {
    process.env.CODEX_CLI_PATH = "/custom/codex";
    const { AppServerTransport } = await import("../src/appserver-transport.js");
    await expect(new AppServerTransport().connect()).rejects.toThrow("spawn observed");
    expect(spawn).toHaveBeenCalledWith("/custom/codex", ["app-server", "--stdio"], expect.any(Object));
  });
});
