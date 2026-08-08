import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseWorkTasks, taskChecklistText, taskNotesHtml, WorkTaskArchive } from "../src/task-capture.js";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("work task capture", () => {
  it("recognizes project names and abbreviations", () => {
    const now = Date.parse("2026-07-27T12:00:00+03:00");
    const tasks = parseWorkTasks([
      "ГМК — срочно исправить форму до завтра",
      "Тренер в кармане: стратегическая задача продумать онбординг",
      "ГМД — можно потом добавить экспорт",
    ].join("\n"), "/Users/test", now);

    expect(tasks.map((task) => task.project?.code)).toEqual(["ГМК", "ТВК", "ГМД"]);
    expect(tasks[0]).toMatchObject({ title: "срочно исправить форму до завтра", urgency: "срочно" });
    expect(tasks[0]?.dueAt).toBe(Date.parse("2026-07-28T09:00:00+03:00"));
    expect(tasks[1]).toMatchObject({ priority: "стратегический" });
    expect(tasks[2]).toMatchObject({ urgency: "потом" });
    expect(tasks[2]?.project?.workspace).toBe(path.join("/Users/test", "WORK", "gde-moi-dengi"));
  });

  it("splits dictated project tasks after sentence boundaries", () => {
    const tasks = parseWorkTasks(
      "ГМК сделать отчёт. ТВК проверить оплату. Где мои деньги — обновить прогноз.",
      "/Users/test",
      Date.parse("2026-07-27T12:00:00+03:00"),
    );
    expect(tasks.map((task) => task.project?.code)).toEqual(["ГМК", "ТВК", "ГМД"]);
    expect(tasks.map((task) => task.title)).toEqual(["сделать отчёт", "проверить оплату", "обновить прогноз"]);
  });

  it("keeps a readable Markdown checklist and Notes checkbox presentation", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "cta-tasks-"));
    folders.push(folder);
    const task = parseWorkTasks("ТВК — высокий приоритет проверить регистрацию", "/Users/test",
      Date.parse("2026-07-27T12:00:00+03:00"))[0]!;
    const archive = new WorkTaskArchive(folder);
    const file = await archive.save([task]);
    const markdown = await readFile(file, "utf8");

    expect(markdown).toContain("# РАБОЧИЕ ЗАДАЧИ");
    expect(markdown).toContain("- [ ] **[ТВК — Тренер в кармане]**");
    expect(markdown).toContain("Приоритет: высокий");
    expect(taskNotesHtml(task)).toContain("☐");
    expect(taskChecklistText(task)).toContain("[ТВК]");
  });
});
