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
}

export async function todayWeather(location: WeatherLocation, requester: typeof fetch = fetch): Promise<string> {
  const query = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    daily: ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_probability_max",
      "precipitation_sum", "wind_speed_10m_max"].join(","),
    timezone: "Europe/Moscow",
    forecast_days: "1",
  });
  const response = await requester(`https://api.open-meteo.com/v1/forecast?${query}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`weather HTTP ${response.status}`);
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
  return [
    `🌦 Погода · ${location.label}`,
    `${weatherLabel(code!)} · ${temperature(minimum!)}…${temperature(maximum!)} °C · осадки ${Math.round(probability!)}% (${decimal(precipitation!)} мм) · ветер до ${Math.round(wind!)} км/ч`,
  ].join("\n");
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
