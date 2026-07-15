import { describe, expect, it, vi } from "vitest";

import { todayWeather } from "../src/weather.js";

describe("todayWeather", () => {
  it("formats temperature, precipitation and wind for the morning digest", async () => {
    const requester = vi.fn(async () => new Response(JSON.stringify({
      daily: {
        weather_code: [61], temperature_2m_max: [24.6], temperature_2m_min: [15.2],
        precipitation_probability_max: [73], precipitation_sum: [2.4], wind_speed_10m_max: [17.8],
      },
    }), { status: 200 }));

    const result = await todayWeather({ label: "Москва", latitude: 55.7558, longitude: 37.6173 }, requester as typeof fetch);

    expect(result).toBe("🌦 Погода · Москва\nдождь · +15…+25 °C · осадки 73% (2,4 мм) · ветер до 18 км/ч");
    expect(String(requester.mock.calls[0]?.[0])).toContain("forecast_days=1");
  });

  it("rejects incomplete forecasts so the digest can show a concise fallback", async () => {
    const requester = vi.fn(async () => new Response(JSON.stringify({ daily: {} }), { status: 200 }));
    await expect(todayWeather({ label: "Москва", latitude: 55.7558, longitude: 37.6173 }, requester as typeof fetch))
      .rejects.toThrow("incomplete");
  });
});
