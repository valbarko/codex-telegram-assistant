export interface WeatherLocation {
  label: string;
  latitude: number;
  longitude: number;
}

interface ForecastResponse {
  daily?: {
    weather_code?: unknown[];
    temperature_2m_max?: unknown[];
    temperature_2m_min?: unknown[];
    precipitation_probability_max?: unknown[];
    precipitation_sum?: unknown[];
    wind_speed_10m_max?: unknown[];
  };
  hourly?: {
    time?: unknown[];
    weather_code?: unknown[];
    temperature_2m?: unknown[];
    precipitation_probability?: unknown[];
    precipitation?: unknown[];
    rain?: unknown[];
    showers?: unknown[];
  };
}

const WEATHER_ATTEMPTS = 4;
const WEATHER_RETRY_DELAYS = [500, 1_500, 3_000];
const FORECAST_HOURS = [10, 14, 18, 21] as const;

export async function todayWeather(
  location: WeatherLocation,
  requester: typeof fetch = fetch,
  wait: (milliseconds: number) => Promise<void> = delay,
): Promise<string> {
  const query = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    daily: ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_probability_max",
      "precipitation_sum", "wind_speed_10m_max"].join(","),
    hourly: ["weather_code", "temperature_2m", "precipitation_probability", "precipitation", "rain", "showers"].join(","),
    timezone: "Europe/Moscow",
    forecast_days: "1",
  });
  const response = await requestForecast(`https://api.open-meteo.com/v1/forecast?${query}`, requester, wait);
  const payload = await response.json() as ForecastResponse;
  const daily = payload.daily;
  const code = numberAt(daily?.weather_code, 0);
  const maximum = numberAt(daily?.temperature_2m_max, 0);
  const minimum = numberAt(daily?.temperature_2m_min, 0);
  const probability = numberAt(daily?.precipitation_probability_max, 0);
  const precipitation = numberAt(daily?.precipitation_sum, 0);
  const wind = numberAt(daily?.wind_speed_10m_max, 0);
  if ([code, maximum, minimum, probability, precipitation, wind].some((value) => value === undefined)) {
    throw new Error("weather response is incomplete");
  }
  const segments = FORECAST_HOURS.map((hour) => hourlySegment(payload.hourly, hour));
  if (segments.some((segment) => segment === undefined)) throw new Error("weather hourly response is incomplete");
  const points = segments.filter((segment): segment is WeatherSegment => segment !== undefined);
  const rainy = points.filter(rainExpected);
  const rainAlert = rainy.length
    ? `☔ Дождь ожидается в ${joinTimes(rainy.map((segment) => segment.time))}.`
    : undefined;
  return [
    `🌦 Погода · ${location.label}`,
    `${weatherLabel(code!)} · ${temperature(minimum!)}…${temperature(maximum!)} °C · осадки ${Math.round(probability!)}% (${decimal(precipitation!)} мм) · ветер до ${Math.round(wind!)} км/ч`,
    "",
    ...(rainAlert ? [rainAlert, ""] : []),
    "По времени:",
    ...points.map(formatSegment),
  ].join("\n");
}

interface WeatherSegment {
  time: string;
  code: number;
  temperature: number;
  probability: number;
  precipitation: number;
  rain: number;
  showers: number;
}

function hourlySegment(hourly: ForecastResponse["hourly"], hour: number): WeatherSegment | undefined {
  const suffix = `T${String(hour).padStart(2, "0")}:00`;
  const index = hourly?.time?.findIndex((value) => typeof value === "string" && value.endsWith(suffix)) ?? -1;
  if (index < 0) return undefined;
  const code = numberAt(hourly?.weather_code, index);
  const segmentTemperature = numberAt(hourly?.temperature_2m, index);
  const probability = numberAt(hourly?.precipitation_probability, index);
  const precipitation = numberAt(hourly?.precipitation, index);
  const rain = numberAt(hourly?.rain, index);
  const showers = numberAt(hourly?.showers, index);
  if ([code, segmentTemperature, probability, precipitation, rain, showers].some((value) => value === undefined)) return undefined;
  return { time: `${String(hour).padStart(2, "0")}:00`, code: code!, temperature: segmentTemperature!, probability: probability!,
    precipitation: precipitation!, rain: rain!, showers: showers! };
}

function formatSegment(segment: WeatherSegment): string {
  const icon = rainExpected(segment) ? "☔ " : "";
  return `${icon}${segment.time} · ${temperature(segment.temperature)} °C · ${weatherLabel(segment.code)} · осадки ${Math.round(segment.probability)}% (${decimal(segment.precipitation)} мм)`;
}

function rainExpected(segment: WeatherSegment): boolean {
  return segment.rain + segment.showers > 0 || isRainCode(segment.code)
    || (segment.probability >= 50 && !isSnowCode(segment.code));
}

function isRainCode(code: number): boolean {
  return (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
}

function isSnowCode(code: number): boolean {
  return code >= 71 && code <= 77 || code >= 85 && code <= 86;
}

function joinTimes(values: string[]): string {
  if (values.length < 2) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} и ${values.at(-1)}`;
}

async function requestForecast(
  url: string,
  requester: typeof fetch,
  wait: (milliseconds: number) => Promise<void>,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < WEATHER_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await requester(url, { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      lastError = error;
      if (attempt === WEATHER_ATTEMPTS - 1) throw error;
      await wait(WEATHER_RETRY_DELAYS[attempt] ?? WEATHER_RETRY_DELAYS.at(-1)!);
      continue;
    }
    if (response.ok) return response;
    const error = new Error(`weather HTTP ${response.status}`);
    if (!retryableStatus(response.status) || attempt === WEATHER_ATTEMPTS - 1) throw error;
    lastError = error;
    await wait(WEATHER_RETRY_DELAYS[attempt] ?? WEATHER_RETRY_DELAYS.at(-1)!);
  }
  throw lastError instanceof Error ? lastError : new Error("weather request failed");
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function numberAt(values: unknown[] | undefined, index: number): number | undefined {
  const value = values?.[index];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function temperature(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function decimal(value: number): string {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(value);
}

function weatherLabel(code: number): string {
  if (code === 0) return "ясно";
  if ([1, 2].includes(code)) return "переменная облачность";
  if (code === 3) return "облачно";
  if ([45, 48].includes(code)) return "туман";
  if (code >= 51 && code <= 57) return "морось";
  if (code >= 61 && code <= 67) return "дождь";
  if (code >= 71 && code <= 77) return "снег";
  if (code >= 80 && code <= 82) return "ливни";
  if (code >= 85 && code <= 86) return "снегопад";
  if (code >= 95) return "гроза";
  return "погода без уточнения";
}
