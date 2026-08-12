import { describe, expect, it } from "vitest";

import type { ContentRadarPost } from "../src/content-radar.js";
import {
  WEBSITE_FEED_SOURCES,
  parseWebsiteFeed,
  parseHubermanIndex,
  selectWebsiteRadarPosts,
  type WebsiteFeedSource,
} from "../src/website-topic-radar.js";

describe("website content radar", () => {
  const source: WebsiteFeedSource = {
    id: "example",
    title: "Evidence Example",
    homepage: "https://example.com/articles/",
    feedUrl: "https://example.com/feed/",
    role: "evidence",
  };

  it("parses RSS articles, descriptions and cited links", () => {
    const posts = parseWebsiteFeed(`<?xml version="1.0"?><rss><channel><item>
      <title><![CDATA[Protein &amp; training]]></title>
      <link>https://example.com/protein/</link>
      <guid>article-1</guid>
      <pubDate>Mon, 10 Aug 2026 04:15:00 +0000</pubDate>
      <description><![CDATA[<p>A useful research summary with enough detail for the content radar.</p>
        <a href="https://pubmed.ncbi.nlm.nih.gov/123/">Study</a>]]></description>
    </item></channel></rss>`, source);

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      sourceKind: "website",
      sourceRole: "evidence",
      sourceTitle: "Evidence Example",
      sourceUrl: "https://example.com/protein/",
      links: ["https://pubmed.ncbi.nlm.nih.gov/123/"],
    });
    expect(posts[0]?.text).toContain("Protein & training");
  });

  it("parses Atom alternate links", () => {
    const posts = parseWebsiteFeed(`<?xml version="1.0"?><feed><entry>
      <id>article-2</id><title>Strength adaptation</title>
      <published>2026-08-09T10:00:00Z</published>
      <link rel="self" href="https://example.com/feed/article-2" />
      <link rel="alternate" href="https://example.com/strength/" />
      <summary>Research on strength adaptation with practical context and limitations for trained adults.</summary>
    </entry></feed>`, source);

    expect(posts[0]).toMatchObject({ sourceUrl: "https://example.com/strength/" });
  });

  it("reads Menno's official research videos and skips shorts", () => {
    const menno = WEBSITE_FEED_SOURCES.find((item) => item.id === "menno-henselmans")!;
    const posts = parseWebsiteFeed(`<?xml version="1.0"?><feed xmlns:media="http://search.yahoo.com/mrss/">
      <entry><id>yt:video:short</id><title>Quick exercise</title>
        <published>2026-08-09T10:00:00Z</published>
        <link rel="alternate" href="https://www.youtube.com/shorts/short" />
        <media:group><media:description>Short exercise demonstration with enough text to be considered.</media:description></media:group>
      </entry>
      <entry><id>yt:video:study</id><title>Two new training studies</title>
        <published>2026-08-08T10:00:00Z</published>
        <link rel="alternate" href="https://www.youtube.com/watch?v=study" />
        <media:group><media:description>Comparison of training volume and rest intervals with practical limitations.
          Reference: https://doi.org/10.1000/example</media:description></media:group>
      </entry>
    </feed>`, menno);

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      sourceRole: "expert",
      sourceTitle: "Menno Henselmans",
      sourceUrl: "https://www.youtube.com/watch?v=study",
      links: ["https://doi.org/10.1000/example"],
    });
  });

  it("parses dated episodes from the official Huberman index", () => {
    const rows = parseHubermanIndex(`<div>
      <a episode-card="" href="/episode/sleep-and-recovery" class="card">
        <div class="paragraph-small u-line-height-none">August 10, 2026</div>
        <h3 card-title="" class="h7">Sleep &amp; Recovery</h3>
      </a>
    </div>`);

    expect(rows).toEqual([{
      title: "Sleep & Recovery",
      sourceUrl: "https://www.hubermanlab.com/episode/sleep-and-recovery",
      publishedAt: Date.parse("August 10, 2026"),
    }]);
  });

  it("keeps recent non-promotional entries and limits each publisher", () => {
    const now = Date.parse("2026-08-10T06:00:00+03:00");
    const posts = [
      post("a", now - 1_000, "Research on protein and training with practical context for athletes.".repeat(2)),
      post("b", now - 2_000, "Research on recovery and sleep with practical context for athletes.".repeat(2)),
      post("c", now - 3_000, "Research on strength and muscle with practical context for athletes.".repeat(2)),
      post("d", now - 4_000, "Research on appetite and behavior with practical context for athletes.".repeat(2)),
      post("sale", now - 5_000, "Limited-time sale and discount. Register now for our course.".repeat(3)),
      post("old", now - 30 * 86_400_000, "Old research on training and nutrition.".repeat(5)),
    ];

    expect(selectWebsiteRadarPosts(posts, { now, usedSourceIds: new Set([posts[1]!.sourceId]) })
      .map((item) => item.sourceId)).toEqual([posts[0]!.sourceId, posts[2]!.sourceId, posts[3]!.sourceId]);
  });
});

function post(id: string, publishedAt: number, text: string): ContentRadarPost {
  return {
    sourceId: `website:example:${id}`,
    sourceKind: "website",
    sourceRole: "evidence",
    sourceTitle: "Evidence Example",
    publishedAt,
    text,
    sourceUrl: `https://example.com/${id}/`,
  };
}
