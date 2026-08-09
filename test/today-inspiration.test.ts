import { describe, expect, it, vi } from "vitest";

import { parseCalendRss, todayInspiration } from "../src/today-inspiration.js";

const rss = `<?xml version="1.0" encoding="utf-8"?>
<rss><channel>
  <item><title>30 октября 2026 - День тренера в России</title><link>https://www.calend.ru/holidays/0/0/3586/</link><description><![CDATA[День тренера отмечают 30 октября. В 1999 году Федерации спортивной и художественной гимнастики России выступили с инициативой учреждения праздника.]]></description><category>Праздники России</category></item>
  <item><title>30 октября 2026 - День инженера-механика</title><link>https://www.calend.ru/holidays/0/0/123/</link><description><![CDATA[Праздник появился в XX веке.]]></description><category>Праздники России</category></item>
  <item><title>30 октября 2026 - День памяти жертв политических репрессий</title><link>https://www.calend.ru/holidays/0/0/456/</link><description><![CDATA[Памятная дата России.]]></description><category>Праздники России</category></item>
  <item><title>30 октября 2026 - Всемирный день футбола</title><link>https://www.calend.ru/holidays/0/0/457/</link><description><![CDATA[Праздник футболистов и болельщиков.]]></description><category>Международные праздники</category></item>
  <item><title>30 октября 2026 - Празднование иконы</title><link>https://www.calend.ru/holidays/0/0/789/</link><description><![CDATA[Православный праздник.]]></description><category>Православные праздники</category></item>
  <item><title>31 октября 2026 - День здорового питания</title><link>https://www.calend.ru/holidays/0/0/999/</link><description>Завтра.</description><category>Международные праздники</category></item>
</channel></rss>`;

describe("todayInspiration", () => {
  it("keeps only occasions that fit the blog", async () => {
    const requester = vi.fn(async (url: string | URL | Request) => String(url).endsWith("today-holidays.rss")
      ? new Response(rss, { status: 200 })
      : new Response(JSON.stringify({ holidays: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await todayInspiration(
      Date.parse("2026-10-30T06:00:00+03:00"), requester as typeof fetch, async () => undefined,
    );

    expect(result).toContain("**Сегодня · пятница, 30 октября**");
    expect(result).toContain("[День тренера в России](https://www.calend.ru/holidays/0/0/3586/)");
    expect(result).not.toContain("День инженера-механика");
    expect(result).not.toContain("репрессий");
    expect(result).not.toContain("футбола");
    expect(result).not.toContain("Празднование иконы");
    expect(result).not.toContain("День здорового питания");
    expect(result).not.toContain("Факт для блога");
  });

  it("does not fill an empty day with war, politics, athletes or a generic holiday", async () => {
    const fallbackWiki = {
      holidays: [
        { text: "— Международный день коренных народов мира.", pages: [] },
        { text: "— День военной славы.", pages: [] },
        { text: "— Всемирный день футбола.", pages: [] },
      ],
      selected: [{ year: 1942, text: "Матч в оккупированном городе." }],
      births: [{ year: 1943, text: "Известный боксёр и чемпион мира." }],
    };
    const requester = vi.fn(async (url: string | URL | Request) => String(url).includes("calend.ru")
      ? new Response("unavailable", { status: 404 })
      : new Response(JSON.stringify(fallbackWiki), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await todayInspiration(
      Date.parse("2026-08-09T06:00:00+03:00"), requester as typeof fetch, async () => undefined,
    );

    expect(result).toBeUndefined();
  });

  it("parses only the requested Moscow calendar date from the RSS feed", () => {
    const result = parseCalendRss(rss, { year: 2026, month: 10, day: 30 });

    expect(result.map((item) => item.title)).toEqual([
      "День тренера в России",
      "День инженера-механика",
      "День памяти жертв политических репрессий",
      "Всемирный день футбола",
      "Празднование иконы",
    ]);
  });
});
