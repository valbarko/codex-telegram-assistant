import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawn = vi.fn(() => {
  throw new Error("spawn observed");
});

vi.mock("node:child_process", () => ({ spawn }));

describe("AppServerTransport executable discovery", () => {
  afterEach(() => {
    delete process.env.CODEX_CLI_PATH;
    vi.resetModules();
    spawn.mockReset();
    spawn.mockImplementation(() => { throw new Error("spawn observed"); });
  });

  it("honors an explicit executable path", async () => {
    process.env.CODEX_CLI_PATH = "/custom/codex";
    const { AppServerTransport } = await import("../src/appserver-transport.js");
    await expect(new AppServerTransport().connect()).rejects.toThrow("spawn observed");
    expect(spawn).toHaveBeenCalledWith("/custom/codex", ["app-server", "--stdio"], expect.any(Object));
  });

  it("waits for app-server to exit before allowing a reconnect", async () => {
    const children = [fakeAppServer(), fakeAppServer()];
    spawn.mockImplementation(() => children.shift() as never);
    const { AppServerTransport } = await import("../src/appserver-transport.js");
    const transport = new AppServerTransport();

    await transport.connect();
    const closing = transport.close();
    const reconnecting = transport.connect();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(1);
    await closing;
    await reconnecting;

    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

function fakeAppServer() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString("utf8")) as { id?: number };
    if (request.id) child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
  });
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    queueMicrotask(() => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
    });
    return true;
  });
  return child;
}
