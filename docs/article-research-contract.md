# Private article research contract

Use this contract for a new or substantially revised article-bank package. It
keeps editorial reasoning auditable without leaking research notes into public
artifacts. A narrow copy or formatting edit may reuse the existing bundle.

Store the bundle outside the publishable article directory:

```text
.private/article-research/<slug>/
|-- brief.md
`-- claims.json
```

Neither file belongs in `metadata.json`, publication manifests, previews, or
platform copy. Do not modify a source document while researching an article.

## Brief

Keep `brief.md` short. Record only the decisions that should shape the draft:

- writing mode: `authorial` or `reader_first_seo`;
- intended reader and their immediate question;
- page role and unique value relative to existing articles;
- author material that may be used without inventing biography;
- facts that must be verified before publication;
- the next useful reader action.

An authorial article may have an empty claim register, but it still needs a
brief for a complete new package. For a reader-first article, check the existing
bank for overlap and state why this article deserves its own page.

## Claim register

Track only material claims: statements that affect the title, conclusion,
advice, comparison, safety, price, date, rule, or factual credibility. Do not
inventory harmless connective prose or purely authorial opinion.

Use this JSON shape:

```json
{
  "version": 1,
  "slug": "article-slug",
  "mode": "reader_first_seo",
  "sources": [
    {
      "id": "source-1",
      "reference": "https://example.com/or/private-source-description",
      "visibility": "public",
      "authority": "primary",
      "checked_at": "2026-09-21"
    }
  ],
  "claims": [
    {
      "id": "claim-1",
      "statement": "The exact claim used by the article",
      "importance": "material",
      "risk": "unstable",
      "status": "verified",
      "source_ids": ["source-1"],
      "publication_use": "cite",
      "limitations": ""
    }
  ]
}
```

Allowed values:

- `visibility`: `public`, `restricted`, `internal`, `confidential`;
- `authority`: `primary`, `secondary`, `author`;
- `importance`: `material`, `supporting`;
- `risk`: `normal`, `unstable`, `high_stakes`;
- `status`: `verified`, `qualified`, `removed`;
- `publication_use`: `cite`, `paraphrase`, `background_only`, `exclude`.

Use the narrowest truthful visibility. `restricted` means a source is shared or
account-gated, not public. `internal` material may inform a careful paraphrase
but must not be presented as a public citation. `confidential` material is only
background or excluded unless Valentin explicitly authorizes a particular use.

Every retained claim needs a source. A `qualified` claim also needs a concrete
limitation. A `cite` claim may use only public sources. A `paraphrase` claim may
not rely on confidential sources. Every unstable or high-stakes claim needs at
least one current primary source; `checked_at` records the verification date,
not the source's publication date. Remove or qualify a claim that does not pass.

The bundle records evidence; it does not grant permission to publish. Existing
publication approval and exact-artifact checks still apply.
