import { describe, expect, it, vi } from "vitest";

import { todayWeather } from "../src/weather.js";

describe("todayWeather", () => {
  it("formats temperature, precipitation and wind for the morning digest", async () => {
    const requester = vi.fn(async () => new Response(JSON.stringify({
      daily: {
        weather_code: [61], temperature_2m_max: [24.6], temperature_2m_min: [15.2],
        precipitation_probability_max: [73], precipitation_sum: [2.4], wind_speed_10m_max: [17.8],
      },
      hourly: {
        time: ["2026-07-18T10:00", "2026-07-18T14:00", "2026-07-18T18:00", "2026-07-18T21:00"],
        weather_code: [3, 61, 80, 1], temperature_2m: [20.2, 23.7, 19.4, 16.6],
        precipitation_probability: [20, 72, 81, 15], precipitation: [0, 1.2, 2.6, 0],
        rain: [0, 1.2, 0.4, 0], showers: [0, 0, 2.2, 0],
      },
    }), { status: 200 }));

    const result = await todayWeather({ label: "Москва", latitude: 55.7558, longitude: 37.6173 }, requester as typeof fetch);

    expect(result).toBe([
      "🌦 Погода · Москва",
      "дождь · +15…+25 °C · осадки 73% (2,4 мм) · ветер до 18 км/ч",
      "",
      "☔ Дождь ожидается в 14:00 и 18:00.",
      "",
      "По времени:",
      "10:00 · +20 °C · облачно · осадки 20% (0 мм)",
      "☔ 14:00 · +24 °C · дождь · осадки 72% (1,2 мм)",
      "☔ 18:00 · +19 °C · ливни · осадки 81% (2,6 мм)",
      "21:00 · +17 °C · переменная облачность · осадки 15% (0 мм)",
    ].join("\n"));
    expect(String(requester.mock.calls[0]?.[0])).toContain("forecast_days=1");
    expect(String(requester.mock.calls[0]?.[0])).toContain("hourly=weather_code%2Ctemperature_2m%2Cprecipitation_probability");
  });

  it("rejects incomplete forecasts so the digest can show a concise fallback", async () => {
    const requester = vi.fn(async () => new Response(JSON.stringify({ daily: {} }), { status: 200 }));
    await expect(todayWeather({ label: "Москва", latitude: 55.7558, longitude: 37.6173 }, requester as typeof fetch))
      .rejects.toThrow("incomplete");
  });

  it("retries transient provider failures before showing the fallback", async () => {
    const requester = vi.fn()
      .mockResolvedValueOnce(new Response("temporarily unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        daily: {
          weather_code: [0], temperature_2m_max: [26], temperature_2m_min: [17],
          precipitation_probability_max: [5], precipitation_sum: [0], wind_speed_10m_max: [9],
        },
        hourly: {
          time: ["2026-07-18T10:00", "2026-07-18T14:00", "2026-07-18T18:00", "2026-07-18T21:00"],
          weather_code: [0, 1, 2, 0], temperature_2m: [20, 25, 23, 18],
          precipitation_probability: [0, 5, 5, 0], precipitation: [0, 0, 0, 0],
          rain: [0, 0, 0, 0], showers: [0, 0, 0, 0],
        },
      }), { status: 200 }));
    const wait = vi.fn(async () => {});

    const result = await todayWeather(
      { label: "Москва", latitude: 55.7558, longitude: 37.6173 },
      requester as typeof fetch,
      wait,
    );

    expect(result).toContain("ясно · +17…+26 °C");
    expect(requester).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(500);
  });

  it("does not retry a permanent provider error", async () => {
    const requester = vi.fn(async () => new Response("bad request", { status: 400 }));
    await expect(todayWeather(
      { label: "Москва", latitude: 55.7558, longitude: 37.6173 },
      requester as typeof fetch,
      async () => {},
    )).rejects.toThrow("weather HTTP 400");
    expect(requester).toHaveBeenCalledTimes(1);
  });
});
