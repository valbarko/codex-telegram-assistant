import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as audio from "../src/audio.js";
import * as fluid from "../src/fluid-audio.js";
import { EphemeralTextEditor } from "../src/ephemeral-text-editor.js";
import { MediaSummaryService } from "../src/media-summary.js";
import { UnusableMediaTranscriptError } from "../src/media-transcript-quality.js";
import { AssistantDatabase } from "../src/storage.js";

const folders: string[] = [];
const databases: AssistantDatabase[] = [];
const sourceUrl = "https://youtu.be/zksgMtoEB3Y";
const readable = "Start working instead of waiting for the perfect conditions.";
const garbage = "[00:00:00] '10, 10, 120, 2000-1%, 0.30 10-15-10, ст, 100, 200, 300, 400.'";

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cta-media-pipeline-"));
  folders.push(directory);
  const mediaPath = path.join(directory, "source.m4a");
  const chunkPath = path.join(directory, "chunk-0000.mka");
  await Promise.all([writeFile(mediaPath, "audio"), writeFile(chunkPath, "audio")]);
  const database = new AssistantDatabase(path.join(directory, "assistant.sqlite"));
  databases.push(database);
  const editor = new EphemeralTextEditor({});
  const summarize = vi.spyOn(editor, "summarizeMediaTranscript").mockResolvedValue("# Проверенный конспект");
  const service = new MediaSummaryService({
    dataDirectory: directory, mediaDownloaderExecutable: "unused", ffmpegExecutable: "unused",
    fluidAudioExecutable: "fluid-test", mediaSummaryMaxDurationSeconds: 3600,
  }, database, editor);
  const io = service as unknown as {
    inspect(): Promise<{ title: string; durationSeconds: number; caption?: { language: string; automatic: boolean } }>;
    download(): Promise<string>;
    downloadCaption(): Promise<string>;
    splitAudio(): Promise<string[]>;
  };
  const inspect = vi.spyOn(io, "inspect").mockResolvedValue({ title: "English video", durationSeconds: 599 });
  const download = vi.spyOn(io, "download").mockResolvedValue(mediaPath);
  const captions = vi.spyOn(io, "downloadCaption").mockResolvedValue(readable);
  vi.spyOn(io, "splitAudio").mockResolvedValue([chunkPath]);
  const primary = vi.spyOn(fluid, "transcribeWithFluidAudioDetailed")
    .mockResolvedValue({ text: readable, segments: [] });
  const fallback = vi.spyOn(audio, "transcribeAudioBatchDetailed").mockImplementation(async (_files, options) => {
    const result = { text: readable, segments: [] };
    await options?.onResult?.(result, 0);
    return [result];
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return { service, database, summarize, inspect, download, captions, primary, fallback, mediaPath };
}

describe("media transcription quality fallback", () => {
  it.each([readable, "Обсуждаем product market fit и план на 90 дней."])
    ("keeps English and mixed speech without a language filter", async (text) => {
      const f = await fixture();
      f.primary.mockResolvedValue({ text, segments: [] });
      await f.service.summarize(sourceUrl);
      expect(f.primary).toHaveBeenCalledWith(f.mediaPath, { executable: "fluid-test", timeoutMs: 30 * 60_000 });
      expect(f.fallback).not.toHaveBeenCalled();
      expect(f.summarize).toHaveBeenCalledWith(expect.objectContaining({ transcript: `[00:00:00] ${text}` }));
    });

  it("retries nonempty decoder garbage with MLX before asking for a summary", async () => {
    const f = await fixture();
    f.primary.mockResolvedValue({ text: garbage, segments: [] });
    await f.service.summarize(sourceUrl);
    expect(f.fallback).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ language: null }));
    expect(f.summarize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ transcript: `[00:00:00] ${readable}` }));
  });

  it("falls back from corrupt captions to audio", async () => {
    const f = await fixture();
    f.inspect.mockResolvedValue({ title: "Video", durationSeconds: 599, caption: { language: "en", automatic: true } });
    f.captions.mockResolvedValue(garbage);
    await f.service.summarize(sourceUrl);
    expect(f.primary).toHaveBeenCalledOnce();
    expect(f.summarize).toHaveBeenCalledWith(expect.objectContaining({ transcript: `[00:00:00] ${readable}` }));
  });

  it("fails without generating a fake summary if both engines return garbage", async () => {
    const f = await fixture();
    f.primary.mockResolvedValue({ text: garbage, segments: [] });
    f.fallback.mockImplementation(async (_files, options) => {
      const result = { text: garbage, segments: [] };
      await options?.onResult?.(result, 0);
      return [result];
    });
    await expect(f.service.summarize(sourceUrl)).rejects.toBeInstanceOf(UnusableMediaTranscriptError);
    expect(f.summarize).not.toHaveBeenCalled();
  });

  it("discards a corrupt cached result and transcribes again", async () => {
    const f = await fixture();
    const jobId = f.database.enqueueAssistantJob({ owner: "1", context: "1", chatId: "1", body: sourceUrl,
      prompt: sourceUrl, fingerprint: sourceUrl, kind: "media_summary", maxAttempts: 3 }).job.id;
    f.database.saveMediaJobCheckpoint({ jobId, sourceUrl, stage: "transcribed", mediaPath: f.mediaPath,
      chunks: [], transcriptParts: [garbage] });
    await f.service.summarize(sourceUrl, () => undefined, jobId);
    expect(f.download).not.toHaveBeenCalled();
    expect(f.primary).toHaveBeenCalledOnce();
    expect(f.database.mediaJobCheckpoint(jobId)?.transcriptParts).toEqual([`[00:00:00] ${readable}`]);
  });

  it("preserves a valid cached transcript without repeating ASR", async () => {
    const f = await fixture();
    const jobId = f.database.enqueueAssistantJob({ owner: "1", context: "1", chatId: "1", body: sourceUrl,
      prompt: sourceUrl, fingerprint: sourceUrl, kind: "media_summary", maxAttempts: 3 }).job.id;
    f.database.saveMediaJobCheckpoint({ jobId, sourceUrl, stage: "transcribed", mediaPath: f.mediaPath,
      chunks: [], transcriptParts: [`[00:00:00] ${readable}`] });
    await f.service.summarize(sourceUrl, () => undefined, jobId);
    expect(f.primary).not.toHaveBeenCalled();
    expect(f.fallback).not.toHaveBeenCalled();
    expect(f.summarize).toHaveBeenCalledOnce();
  });

  it("does not return success when the editor reports unusable source", async () => {
    const f = await fixture();
    f.summarize.mockRejectedValue(new UnusableMediaTranscriptError());
    await expect(f.service.summarize(sourceUrl)).rejects.toBeInstanceOf(UnusableMediaTranscriptError);
  });
});
