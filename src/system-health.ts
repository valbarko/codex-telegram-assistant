const REQUEST_TIMEOUT_MS = 8_000;

export interface PublicService {
  label: string;
  url: string;
}

export interface PublicServiceStatus extends PublicService {
  ok: boolean;
  status?: number;
}

export interface SystemHealthSummary {
  services: readonly PublicServiceStatus[];
}

export const PUBLIC_SERVICES: readonly PublicService[] = [
  { label: "ТВК", url: "https://trenervkarmane.ru/" },
  { label: "ГМК", url: "https://gdeklienty.ru/" },
  { label: "ГМД", url: "https://gde-moi-dengi.ru/" },
  { label: "ValBarko", url: "https://valbarko.ru/" },
  { label: "WellTravel", url: "https://welltravel.club/" },
  { label: "InYourBody", url: "https://inyourbody.ru/" },
  { label: "Fitness24", url: "https://fit-ness24.ru/" },
] as const;

export async function checkPublicServices(
  services: readonly PublicService[] = PUBLIC_SERVICES,
  requester: typeof fetch = fetch,
): Promise<SystemHealthSummary> {
  const results = await Promise.allSettled(services.map((service) => checkService(service, requester)));
  return {
    services: results.map((result, index) => result.status === "fulfilled"
      ? result.value
      : { ...services[index]!, ok: false }),
  };
}

async function checkService(service: PublicService, requester: typeof fetch): Promise<PublicServiceStatus> {
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await requester(service.url, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": "codex-telegram-assistant/0.1 (personal morning health check)" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      lastStatus = response.status;
      await response.body?.cancel().catch(() => undefined);
      if (response.status < 500 || attempt === 1) {
        return { ...service, ok: response.status >= 200 && response.status < 500, status: response.status };
      }
    } catch {
      if (attempt === 1) return { ...service, ok: false, status: lastStatus };
    }
  }
  return { ...service, ok: false, status: lastStatus };
}

export function formatSystemHealth(summary: SystemHealthSummary | undefined): string[] {
  if (!summary) return ["⚠️ Не удалось проверить публичные проекты."];
  const failed = summary.services.filter((service) => !service.ok);
  if (!failed.length) {
    return [`✅ Telegram-помощник работает, все **${publicProjectCount(summary.services.length)}** отвечают.`];
  }
  const available = summary.services.length - failed.length;
  return [
    `⚠️ Отвечают **${available} из ${summary.services.length}** публичных проектов.`,
    `Проверить: **${failed.map((service) => service.label).join(", ")}**.`,
  ];
}

function publicProjectCount(value: number): string {
  const tens = value % 100;
  const units = value % 10;
  const noun = tens >= 11 && tens <= 14
    ? "публичных проектов"
    : units === 1
      ? "публичный проект"
      : units >= 2 && units <= 4
        ? "публичных проекта"
        : "публичных проектов";
  return `${value} ${noun}`;
}
