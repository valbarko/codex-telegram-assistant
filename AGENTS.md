# Authorial writing in this project

When Valentin asks to write or edit an article, essay, Telegram post, announcement, or reply in his voice:

1. Read `writing/VALENTIN_STYLE.md` before drafting.
2. Search the private corpus for relevant examples. Run searches sequentially because local Milvus Lite permits only one process at a time:

   ```bash
   npm run style:search:personal -- "<topic, format, and tone>"
   npm run style:search:expert -- "<topic, format, and tone>"
   ```

   Use only the personal search for personal essays and humor, only the expert search for narrowly expert posts, and both sequentially for mixed formats.
3. Prefer `barko-pro-zhizn` examples for voice, personal narrative, and humor. Use `v-svoem-tele` for expert structure, fitness, nutrition, and psychology.
4. Synthesize the style. Do not copy distinctive passages or invent autobiographical facts.
5. Treat Valentin's latest explicit correction as stronger evidence than the corpus or style guide.
6. Keep diary, fiction, expert writing, and public personal writing as separate modes.
7. Verify unstable factual claims when the text depends on current facts. Style examples are not factual sources.

The raw corpus is private and ignored by Git under `.private/`.
