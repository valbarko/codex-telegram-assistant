# Authorial workflow

Read for a new text or substantial voice/structure rewrite. Narrow edits use the
current passage and its context; they do not restart corpus retrieval.

## Voice and references

1. Read [VALENTIN_STYLE.md](VALENTIN_STYLE.md). It owns source priority, writing
   modes, the one-draft/one-edit process, and the limits on additional rewrite
   passes. Reuse material already read in this task.
2. Read `writing/VALENTIN_GOLD_CORPUS.md` and select up to three relevant examples.
   This is an ignored, local-only input. In a clean worktree, use the canonical
   `/Users/valentinbarko/WORK/codex-telegram-assistant/writing/VALENTIN_GOLD_CORPUS.md`.
   Examples supply voice and structure, not reusable passages or factual evidence.
3. Before using article-bank material as voice evidence, check
   `/Users/valentinbarko/WORK/valentin-writing/.private/editorial-provenance.json`.
   Only entries marked `valentin` qualify. Keep provenance out of reader-facing
   text, metadata, previews, HTML, manifests, and publication messages.
4. Search the broader private corpus only when the gold examples are insufficient.
   Search only personal examples from `barko-pro-zhizn` for narrative and humor;
   only expert examples from `v-svoem-tele` for narrowly expert work in fitness,
   nutrition, or psychology. For mixed work, use both. Find the search commands in
   [package.json](../package.json) and corpus setup in [README.md](README.md).
   Run searches sequentially: local Milvus Lite permits one process at a time.

Private inputs stay in their local locations. If a required source is unavailable,
report that limitation and request the missing reference when it is essential;
use only supplied or verified authorial references in the meantime.

## Publication branches

- New marketing copy or substantial marketing restructuring: use the installed
  `/Users/valentinbarko/.codex/skills/valentin-content-marketing/SKILL.md`.
  It points to the local playbook/templates and preserves the authorial process.
- Public indexable content: use the installed `seo-playbook` skill.
- Changed public Russian copy: use the installed `russian-typography` skill
  after meaning, facts, and voice are settled.
