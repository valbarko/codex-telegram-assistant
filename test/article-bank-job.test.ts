import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isArticleBankDeliveryRequest, snapshotArticleBank, validateArticleBankDelivery } from "../src/article-bank-job.js";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe("article bank job contract", () => {
  it("routes explicit delivery requests but not lookup questions", () => {
    expect(isArticleBankDeliveryRequest("Неплохо, делаем в банк статей — потом поправлю")).toBe(true);
    expect(isArticleBankDeliveryRequest("Проверь, есть ли это в банке статей")).toBe(false);
  });

  it("accepts only a changed package with texts, metadata, both covers and bank validation", async () => {
    const root = bankRoot();
    const before = await snapshotArticleBank(root);
    const article = path.join(root, "articles", "new-article");
    mkdirSync(path.join(article, "assets"), { recursive: true });
    writeFileSync(path.join(article, "article.md"), "Основной текст");
    writeFileSync(path.join(article, "telegram.md"), "Telegram");
    writeFileSync(path.join(article, "vc.txt"), "vc.ru");
    writeFileSync(path.join(article, "assets", "cover-4x5.png"), pngHeader(1080, 1350));
    writeFileSync(path.join(article, "assets", "cover-16x9.png"), pngHeader(1600, 900));
    writeFileSync(path.join(article, "metadata.json"), JSON.stringify({
      media: { feed_4x5: "assets/cover-4x5.png", article_16x9: "assets/cover-16x9.png" },
    }));

    await expect(validateArticleBankDelivery(root, before)).resolves.toEqual(["new-article"]);
  });

  it("rejects a completed Codex turn that did not save a complete package", async () => {
    const root = bankRoot();
    const before = await snapshotArticleBank(root);
    const article = path.join(root, "articles", "unfinished");
    mkdirSync(article, { recursive: true });
    writeFileSync(path.join(article, "article.md"), "Только основной текст");

    await expect(validateArticleBankDelivery(root, before)).rejects.toMatchObject({
      name: "AssistantJobBlockedError", errorClass: "article_incomplete",
    });
  });

  it("rejects validator issues for a changed package after synchronizing the bank", async () => {
    const root = bankRoot("  - new-article: main — draft");
    const before = await snapshotArticleBank(root);
    const article = path.join(root, "articles", "new-article");
    mkdirSync(path.join(article, "assets"), { recursive: true });
    writeFileSync(path.join(article, "article.md"), "Основной текст");
    writeFileSync(path.join(article, "telegram.md"), "Telegram");
    writeFileSync(path.join(article, "vc.md"), "vc.ru");
    writeFileSync(path.join(article, "assets", "cover-4x5.png"), pngHeader(1080, 1350));
    writeFileSync(path.join(article, "assets", "cover-16x9.png"), pngHeader(1600, 900));
    writeFileSync(path.join(article, "metadata.json"), JSON.stringify({
      media: { feed_4x5: "assets/cover-4x5.png", article_16x9: "assets/cover-16x9.png" },
    }));

    await expect(validateArticleBankDelivery(root, before)).rejects.toMatchObject({
      name: "AssistantJobBlockedError", errorClass: "article_validation",
    });
  });
});

function bankRoot(validationOutput = "Все статьи готовы"): string {
  const root = mkdtempSync(path.join(tmpdir(), "cta-article-bank-"));
  folders.push(root);
  mkdirSync(path.join(root, "articles"), { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "article_bank.py"), [
    "import sys",
    `print(${JSON.stringify(validationOutput)} if sys.argv[1] == \"validate\" else \"Синхронизировано\")`,
  ].join("\n"));
  return root;
}

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}
