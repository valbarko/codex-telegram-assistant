import { describe, expect, it, vi } from "vitest";

import { formatPaymentAlert, PaymentAlertMonitor, paymentLink, type PaymentRow, type PaymentSnapshotReader } from "../src/payment-alerts.js";

const row: PaymentRow = {
  id: 42,
  user_id: 17,
  amount: "990.00",
  paid_at: "2026-09-29 17:01:00",
  status: "paid",
  name: "Анна <Б>",
  email: "anna@example.test",
  detail: "Подписка & доступ",
  product: "basic_monthly",
};

describe("payment alerts", () => {
  it("formats a private owner alert with an escaped client name and a usable card link", () => {
    expect(formatPaymentAlert("tvk", row)).toContain("Клиент: <b>Анна &lt;Б&gt;</b>");
    expect(formatPaymentAlert("tvk", row)).toContain("Сумма: <b>990 ₽</b>");
    expect(formatPaymentAlert("tvk", row)).toContain("Подписка &amp; доступ");
    expect(paymentLink("tvk", row)).toBe("https://trenervkarmane.ru/admin/user.php?id=17");
    expect(paymentLink("gu", row)).toBe("https://gdeucheniki.ru/admin/crm_billing.php?platform_invoice_id=42");
    expect(formatPaymentAlert("gmk", { ...row, status: "paid_review" })).toContain("требуется проверка");
  });

  it("starts from the current database clock, deduplicates invoices, and retries failed sends", async () => {
    let available = false;
    const reader: PaymentSnapshotReader = vi.fn(async (project, since) => {
      expect(since).toBe(project === "telo" ? "20260929140000" : "20260929170000");
      return { project, now: project === "telo" ? "20260929140200" : "20260929170200",
        rows: available && project === "tvk" ? [row] : [] };
    });
    let fail = true;
    const send = vi.fn(async () => {
      if (fail) {
        fail = false;
        throw new Error("temporary_failure");
      }
    });
    const monitor = new PaymentAlertMonitor(":memory:", 12345, send, reader,
      new Date("2026-09-29T14:00:00Z"));
    try {
      await monitor.tick();
      expect(send).not.toHaveBeenCalled();
      available = true;
      await monitor.tick();
      expect(send).toHaveBeenCalledTimes(1);
      await monitor.tick();
      expect(send).toHaveBeenCalledTimes(2);
      await monitor.tick();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]?.[0]).toBe(12345);
    } finally {
      monitor.close();
    }
  });
});
