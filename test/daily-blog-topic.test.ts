import { describe, expect, it, vi } from "vitest";

import { blogTopicPillarForDate, findDailyBlogStudies, findDailyBlogStudy,
  parsePubMedArticles } from "../src/daily-blog-topic.js";

const abstract = "Resistance training produced a measurable change in muscle function in healthy adults. "
  + "The randomized protocol compared two loading strategies and reported the size of the effect, adherence, and adverse events. "
  + "The authors note that the sample was small and that the result should not be generalized beyond the studied population.";

const pubmedXml = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle><MedlineCitation>
    <PMID>222</PMID>
    <Article>
      <Journal><Title>Journal of Useful Exercise Research</Title><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal>
      <ArticleTitle>Training load and <i>muscle</i> adaptation</ArticleTitle>
      <Abstract><AbstractText>${abstract}</AbstractText></Abstract>
    </Article>
  </MedlineCitation></PubmedArticle>
</PubmedArticleSet>`;

describe("daily blog topic research", () => {
  it("rotates five blog pillars by Moscow date", () => {
    expect(blogTopicPillarForDate(Date.parse("2026-08-09T06:00:00+03:00"))).toMatchObject({ id: "training" });
    expect(blogTopicPillarForDate(Date.parse("2026-08-10T06:00:00+03:00"))).toMatchObject({ id: "nutrition" });
  });

  it("selects an unused PubMed study with a usable abstract", async () => {
    const requester = vi.fn(async (url: string | URL | Request) => String(url).includes("esearch.fcgi")
      ? new Response(JSON.stringify({ esearchresult: { idlist: ["111", "222"] } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      })
      : new Response(pubmedXml, { status: 200, headers: { "Content-Type": "application/xml" } }));

    const study = await findDailyBlogStudy({
      now: Date.parse("2026-08-09T06:00:00+03:00"),
      usedSourceIds: new Set(["111"]),
      requester: requester as typeof fetch,
      wait: async () => undefined,
    });

    expect(study).toMatchObject({
      sourceId: "222",
      pillar: "training",
      pillarLabel: "тренировки и адаптация",
      title: "Training load and muscle adaptation",
      publication: "Journal of Useful Exercise Research",
      year: 2024,
      sourceUrl: "https://pubmed.ncbi.nlm.nih.gov/222/",
    });
    expect(requester.mock.calls.some(([url]) => String(url).includes("id=222"))).toBe(true);
  });

  it("parses inline markup and XML entities in PubMed records", () => {
    const result = parsePubMedArticles(pubmedXml.replace("muscle</i>", "muscle &amp; recovery</i>"));

    expect(result[0]?.title).toBe("Training load and muscle & recovery adaptation");
    expect(result[0]?.abstract).toContain("sample was small");
  });

  it("collects enough unused studies for the separate daily shortlist", async () => {
    const second = pubmedXml.match(/<PubmedArticle>[\s\S]*<\/PubmedArticle>/u)?.[0]
      ?.replace("222", "333")
      .replace("Training load and <i>muscle</i> adaptation", "Sleep and <i>muscle</i> recovery") ?? "";
    const batch = pubmedXml.replace("</PubmedArticleSet>", `${second}</PubmedArticleSet>`);
    const requester = vi.fn(async (url: string | URL | Request) => String(url).includes("esearch.fcgi")
      ? new Response(JSON.stringify({ esearchresult: { idlist: ["222", "333"] } }), { status: 200 })
      : new Response(batch, { status: 200 }));

    const studies = await findDailyBlogStudies({
      now: Date.parse("2026-08-09T06:00:00+03:00"),
      limit: 2,
      requester: requester as typeof fetch,
      wait: async () => undefined,
    });

    expect(studies.map((study) => study.sourceId)).toEqual(["222", "333"]);
  });
});
