# Authorial writing in this project

When Valentin asks to write or edit an article, essay, Telegram post, announcement, or reply in his voice:

1. For a new text or substantial voice/structure rewrite, read `writing/VALENTIN_STYLE.md` and `writing/VALENTIN_GOLD_CORPUS.md`, reusing relevant material already read in this task. For a typo, single-phrase edit, or formatting correction, work from the current text without reloading the corpus or drafting a replacement article.
2. When voice references are needed, select and read up to three relevant gold-corpus examples. Use them for voice and structure, not as factual sources.
3. Search the broader private corpus only when the gold corpus is insufficient. Run searches sequentially because local Milvus Lite permits only one process at a time:

   ```bash
   npm run style:search:personal -- "<topic, format, and tone>"
   npm run style:search:expert -- "<topic, format, and tone>"
   ```

   Use only the personal search for personal essays and humor, only the expert search for narrowly expert posts, and both sequentially for mixed formats.
4. Before treating any article-bank material as a voice reference, check `/Users/valentinbarko/WORK/valentin-writing/.private/editorial-provenance.json`. Only material marked `valentin` may serve as voice evidence. Never expose this internal provenance in article copy, metadata, previews, HTML, manifests, or publication messages.
5. Prefer `barko-pro-zhizn` examples for voice and personal narrative. Use `v-svoem-tele` for expert structure, fitness, nutrition, and psychology only when its provenance and relevance are clear.
6. For a new text or substantial rewrite, choose authorial story or reader-first SEO article. For indexable content, apply the relevant parts of the global SEO playbook.
7. For new drafting, produce one coherent draft and one targeted edit. For a narrow revision, edit only the requested passage and check it in context. Do not add a humanizer, LanguageTool, or another rewrite pass by default.
8. Synthesize the style. Do not copy distinctive passages or invent autobiographical facts.
9. Treat Valentin's latest explicit correction as stronger evidence than the corpus or style guide.
10. Verify unstable factual claims when the text depends on current facts. Style examples are not factual sources.

The raw corpus is private and ignored by Git under `.private/`.
