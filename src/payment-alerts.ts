import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export type PaymentProject = "tvk" | "gmk" | "gu" | "telo";

export interface PaymentRow {
  id: string | number;
  user_id: string | number | null;
  amount: string | number;
  paid_at: string;
  status: "paid" | "paid_review";
  name: string | null;
  email: string | null;
  detail: string | null;
  product: string | null;
}

export interface PaymentSnapshot {
  project: PaymentProject;
  now: string;
  rows: PaymentRow[];
}

export type PaymentSnapshotReader = (
  project: PaymentProject, since: string, afterAt?: string, afterId?: string,
) => Promise<PaymentSnapshot>;

const PROJECTS: readonly PaymentProject[] = ["tvk", "gmk", "gu", "telo"];
const PROJECT_NAMES: Readonly<Record<PaymentProject, string>> = {
  tvk: "Тренер в кармане",
  gmk: "Где мои клиенты",
  gu: "Где мои ученики",
  telo: "Тело в порядке",
};

interface MonitorState {
  started_at: string;
  cursor_at: string;
}

export class PaymentAlertMonitor {
  private readonly sql: Database.Database;
  private timer?: NodeJS.Timeout;
  private active = false;

  constructor(
    file: string,
    private readonly ownerId: number,
    private readonly send: (ownerId: number, text: string, url: string) => Promise<void>,
    private readonly readSnapshot: PaymentSnapshotReader = remotePaymentSnapshot,
    startedAt: Date = new Date(),
  ) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new Database(file);
    if (file !== ":memory:") chmodSync(file, 0o600);
    this.sql.pragma("journal_mode = WAL");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS payment_monitor_state (
        project TEXT PRIMARY KEY, started_at TEXT NOT NULL, cursor_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_monitor_deliveries (
        project TEXT NOT NULL, invoice_id TEXT NOT NULL, sent_at INTEGER NOT NULL,
        PRIMARY KEY (project, invoice_id)
      );
    `);
    for (const project of PROJECTS) {
      const start = projectClock(project, startedAt);
      this.sql.prepare("INSERT OR IGNORE INTO payment_monitor_state(project, started_at, cursor_at) VALUES (?, ?, ?)")
        .run(project, start, start);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  close(): void {
    this.stop();
    this.sql.close();
  }

  async tick(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      const results = await Promise.allSettled(PROJECTS.map((project) => this.poll(project)));
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          // Neither SSH stderr nor payment data is written to application logs.
          console.error(`Payment alert check failed for ${PROJECTS[index]}: ${safeReason(result.reason)}`);
        }
      });
    } finally {
      this.active = false;
    }
  }

  private async poll(project: PaymentProject): Promise<void> {
    const state = this.sql.prepare("SELECT started_at, cursor_at FROM payment_monitor_state WHERE project=?")
      .get(project) as MonitorState | undefined;
    if (!state) throw new Error("payment_state_missing");

    const since = maxTimestamp(state.started_at, subtractMinutes(state.cursor_at, 2));
    let afterAt: string | undefined;
    let afterId: string | undefined;
    let snapshot: PaymentSnapshot | undefined;
    for (let page = 0; page < 50; page += 1) {
      snapshot = await this.readSnapshot(project, since, afterAt, afterId);
      validateSnapshot(snapshot, project);
      for (const row of snapshot.rows) {
        const invoiceId = String(row.id);
        if (!/^[1-9]\d{0,19}$/.test(invoiceId)) throw new Error("invalid_invoice");
        if (this.sql.prepare("SELECT 1 FROM payment_monitor_deliveries WHERE project=? AND invoice_id=?")
          .get(project, invoiceId)) continue;
        const message = formatPaymentAlert(project, row);
        const url = paymentLink(project, row);
        await this.send(this.ownerId, message, url);
        this.sql.prepare("INSERT OR IGNORE INTO payment_monitor_deliveries(project, invoice_id, sent_at) VALUES (?, ?, ?)")
          .run(project, invoiceId, Date.now());
      }
      if (snapshot.rows.length < 200) {
        this.sql.prepare("UPDATE payment_monitor_state SET cursor_at=? WHERE project=?")
          .run(maxTimestamp(state.cursor_at, snapshot.now), project);
        return;
      }
      const last = snapshot.rows.at(-1)!;
      afterAt = compactTimestamp(last.paid_at);
      afterId = String(last.id);
    }
    throw new Error("too_many_payment_pages");
  }
}

export function formatPaymentAlert(project: PaymentProject, row: PaymentRow): string {
  const minorUnits = project === "telo"
    ? Number(row.amount)
    : Math.round(Number(row.amount) * 100);
  if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0) throw new Error("invalid_amount");
  const amount = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: minorUnits % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(minorUnits / 100);
  const person = cleanText(row.name, 160) || cleanText(row.email, 254)
    || (row.user_id ? `Клиент #${row.user_id}` : "Аккаунт удалён");
  const detail = project === "telo" && row.product === "renewal"
    ? "Продление подписки"
    : project === "tvk" && row.product === "personal_program_once"
      ? "Индивидуальная программа"
      : cleanText(row.detail, 200);
  return [
    "💳 <b>Новая оплата</b>",
    `Проект: <b>${escapeHtml(PROJECT_NAMES[project])}</b>`,
    `Клиент: <b>${escapeHtml(person)}</b>`,
    `Сумма: <b>${escapeHtml(amount)} ₽</b>`,
    ...(detail ? [`Оплачено: ${escapeHtml(detail)}`] : []),
    ...(row.status === "paid_review" ? ["Статус: требуется проверка"] : []),
    `Платёж: #${escapeHtml(String(row.id))}`,
  ].join("\n");
}

export function paymentLink(project: PaymentProject, row: PaymentRow): string {
  const id = String(row.user_id || "");
  if (project === "tvk") return /^[1-9]\d{0,19}$/.test(id)
    ? `https://trenervkarmane.ru/admin/user.php?id=${id}`
    : "https://trenervkarmane.ru/admin/users.php";
  if (project === "gmk") return /^[1-9]\d{0,19}$/.test(id)
    ? `https://gdeklienty.ru/admin/trainer_account.php?id=${id}`
    : "https://gdeklienty.ru/admin/trainer_billing_payments.php";
  if (project === "gu") {
    const invoiceId = String(row.id);
    if (!/^[1-9]\d{0,19}$/.test(invoiceId)) throw new Error("invalid_invoice");
    return `https://gdeucheniki.ru/admin/crm_billing.php?platform_invoice_id=${invoiceId}`;
  }
  if (id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    return `https://telovporyadke.ru/cabinet/#client/${id}/overview`;
  }
  return "https://telovporyadke.ru/cabinet/#billing";
}

export async function remotePaymentSnapshot(
  project: PaymentProject, since: string, afterAt?: string, afterId?: string,
): Promise<PaymentSnapshot> {
  if (!PROJECTS.includes(project) || (since && !/^\d{14}$/.test(since))
    || (afterAt && !/^\d{14}(?:\d{6})?$/.test(afterAt))
    || (afterId && !/^[1-9]\d{0,19}$/.test(afterId))) throw new Error("invalid_snapshot_request");
  const script = readFileSync(path.join(process.cwd(), "scripts", "payment-snapshot.php"), "utf8");
  const remote = `env PAYMENT_PROJECT=${project} PAYMENT_SINCE=${since} PAYMENT_AFTER_AT=${afterAt || ""} PAYMENT_AFTER_ID=${afterId || ""} php`;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
      "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1", "gmk-root", remote],
    { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timeout = setTimeout(() => child.kill(), 25_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 512_000) child.kill();
    });
    child.stderr.resume();
    child.stdin.on("error", () => reject(new Error("snapshot_unavailable")));
    child.on("error", () => { clearTimeout(timeout); reject(new Error("ssh_unavailable")); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || stdout.length > 512_000) reject(new Error("snapshot_unavailable"));
      else resolve(stdout);
    });
    child.stdin.end(script);
  });
  try {
    return JSON.parse(output) as PaymentSnapshot;
  } catch {
    throw new Error("snapshot_invalid_json");
  }
}

function validateSnapshot(snapshot: PaymentSnapshot, project: PaymentProject): void {
  if (snapshot.project !== project || !/^\d{14}$/.test(snapshot.now)
    || !Array.isArray(snapshot.rows) || snapshot.rows.length > 200) throw new Error("snapshot_invalid");
  for (const row of snapshot.rows) {
    compactTimestamp(row.paid_at);
    if ((typeof row.id !== "number" && typeof row.id !== "string")
      || !["paid", "paid_review"].includes(row.status)) throw new Error("snapshot_invalid_row");
  }
}

function compactTimestamp(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error("invalid_paid_at");
  return `${match[1]}${match[2]}${match[3]}${match[4]}${match[5]}${match[6]}`
    + (match[7] ? match[7].padEnd(6, "0") : "");
}

function subtractMinutes(value: string, minutes: number): string {
  const parts = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!parts) throw new Error("invalid_cursor");
  return new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]),
    Number(parts[4]), Number(parts[5]) - minutes, Number(parts[6])))
    .toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function projectClock(project: PaymentProject, date: Date): string {
  if (project === "telo") return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}${value.hour}${value.minute}${value.second}`;
}

function maxTimestamp(left: string, right: string): string {
  return left > right ? left : right;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function cleanText(value: string | null, limit: number): string {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);
}

function safeReason(error: unknown): string {
  return error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "unknown";
}
