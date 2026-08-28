import { describe, expect, it, vi } from "vitest";

import { checkPublicServices, formatSystemHealth } from "../src/system-health.js";

describe("morning public service health", () => {
  it("summarizes a healthy public surface without technical noise", async () => {
    const requester = vi.fn(async () => new Response("ok", { status: 200 }));
    const summary = await checkPublicServices([
      { label: "ТВК", url: "https://trainer.test/" },
      { label: "ГМК", url: "https://clients.test/" },
    ], requester as typeof fetch);

    expect(summary.services.every((service) => service.ok)).toBe(true);
    expect(formatSystemHealth(summary).join("\n")).toContain("все **2 публичных проекта** отвечают");
  });

  it("names only the public projects that need attention", async () => {
    const requester = vi.fn(async (url: string | URL | Request) => String(url).includes("broken")
      ? new Response("error", { status: 503 })
      : new Response("ok", { status: 200 }));
    const summary = await checkPublicServices([
      { label: "ТВК", url: "https://healthy.test/" },
      { label: "WellTravel", url: "https://broken.test/" },
    ], requester as typeof fetch);

    expect(formatSystemHealth(summary)).toEqual([
      "⚠️ Отвечают **1 из 2** публичных проектов.",
      "Проверить: **WellTravel**.",
    ]);
  });
});
