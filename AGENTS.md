# Authorial writing in this project

When Valentin asks to write or edit an article, essay, Telegram post, announcement, or reply in his voice:

1. Read `writing/VALENTIN_STYLE.md` and `writing/VALENTIN_GOLD_CORPUS.md` before drafting.
2. Select and read no more than three relevant gold-corpus examples. Use them for voice and structure, not as factual sources.
3. Search the broader private corpus only when the gold corpus is insufficient. Run searches sequentially because local Milvus Lite permits only one process at a time:

   ```bash
   npm run style:search:personal -- "<topic, format, and tone>"
   npm run style:search:expert -- "<topic, format, and tone>"
   ```

   Use only the personal search for personal essays and humor, only the expert search for narrowly expert posts, and both sequentially for mixed formats.
4. Before treating any article-bank material as a voice reference, check `/Users/valentinbarko/WORK/valentin-writing/.private/editorial-provenance.json`. Only material marked `valentin` may serve as voice evidence. Never expose this internal provenance in article copy, metadata, previews, HTML, manifests, or publication messages.
5. Prefer `barko-pro-zhizn` examples for voice and personal narrative. Use `v-svoem-tele` for expert structure, fitness, nutrition, and psychology only when its provenance and relevance are clear.
6. Choose one of two modes: authorial story or reader-first SEO article. For indexable content, also follow the global SEO playbook.
7. Produce one coherent draft and one targeted edit. Do not add a humanizer, LanguageTool, or another rewrite pass by default.
8. Synthesize the style. Do not copy distinctive passages or invent autobiographical facts.
9. Treat Valentin's latest explicit correction as stronger evidence than the corpus or style guide.
10. Verify unstable factual claims when the text depends on current facts. Style examples are not factual sources.

The raw corpus is private and ignored by Git under `.private/`.
