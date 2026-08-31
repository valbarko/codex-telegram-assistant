import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { transcribeAudio, transcribeAudioDetailed } from "../src/audio.js";

const folders: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("FluidAudio-first voice transcription", () => {
  it("uses FluidAudio and removes its temporary JSON result", async () => {
    const directory = await temporaryDirectory();
    const audio = path.join(directory, "message.ogg");
    const fluidAudio = path.join(directory, "fluid-audio");
    await writeFile(audio, "audio");
    await executable(fluidAudio, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"text\":\"Текст из FluidAudio\",\"wordTimings\":[]}' > \"$8\"",
    ].join("\n"));

    const result = await transcribeAudioDetailed(audio, {
      fluidAudioExecutable: fluidAudio,
      python: path.join(directory, "missing-python"),
    });

    expect(result).toMatchObject({ text: "Текст из FluidAudio", engine: "fluid-audio" });
    expect((await readdir(directory)).some((name) => name.startsWith(".fluid-transcript-"))).toBe(false);
  });

  it("falls back to MLX Whisper when FluidAudio fails", async () => {
    const directory = await temporaryDirectory();
    const audio = path.join(directory, "message.ogg");
    const fluidAudio = path.join(directory, "fluid-audio");
    const python = path.join(directory, "python");
    await writeFile(audio, "audio");
    await executable(fluidAudio, ["#!/bin/sh", "echo 'primary failed' >&2", "exit 2"].join("\n"));
    await executable(python, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"text\":\"Текст из MLX Whisper\",\"segments\":[]}'",
    ].join("\n"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await transcribeAudioDetailed(audio, {
      fluidAudioExecutable: fluidAudio,
      python,
      model: "test-model",
    });

    expect(result).toMatchObject({ text: "Текст из MLX Whisper", engine: "mlx-whisper" });
    expect(warning).toHaveBeenCalledWith("FluidAudio transcription failed; falling back to MLX Whisper", expect.any(Error));
    expect((await readdir(directory)).some((name) => name.startsWith(".fluid-transcript-"))).toBe(false);
  });

  it("preserves explicit Whisper language auto-detection", async () => {
    const directory = await temporaryDirectory();
    const audio = path.join(directory, "message.ogg");
    const fluidAudio = path.join(directory, "fluid-audio");
    const python = path.join(directory, "python");
    await writeFile(audio, "audio");
    await executable(fluidAudio, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"text\":\"Неверный основной путь\",\"wordTimings\":[]}' > \"$8\"",
    ].join("\n"));
    await executable(python, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"text\":\"Автоопределение MLX\",\"segments\":[]}'",
    ].join("\n"));

    const result = await transcribeAudio(audio, {
      fluidAudioExecutable: fluidAudio,
      language: null,
      python,
      model: "test-model",
    });

    expect(result).toBe("Автоопределение MLX");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cta-audio-transcription-"));
  folders.push(directory);
  return directory;
}

async function executable(file: string, source: string): Promise<void> {
  await writeFile(file, `${source}\n`);
  await chmod(file, 0o755);
}
