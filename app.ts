
// app.ts
import './tracing';
import express, { Express } from 'express';
import path from 'path';
import { trace, metrics, SpanStatusCode } from '@opentelemetry/api';

const PORT: number = parseInt(process.env.PORT || '8080');
const app: Express = express();
const HOST = process.env.HOST || '0.0.0.0';

const tracer = trace.getTracer('weather-app');
const meter = metrics.getMeter('weather-app');
const fetchDuration = meter.createHistogram('weather.fetch.duration', {
  description: 'Time to fetch weather from Open-Meteo',
  unit: 'ms',
});

const DT_BIZ_URL = `${process.env.DT_ENV_URL || 'https://act53954.sprint.dynatracelabs.com'}/api/v2/bizevents/ingest`;
const DT_BIZ_HEADERS = {
  'Authorization': `Api-Token ${process.env.DT_API_TOKEN}`,
  'Content-Type': 'application/json',
};

function sendBizEvents(events: object[]): void {
  fetch(DT_BIZ_URL, {
    method: 'POST',
    headers: DT_BIZ_HEADERS,
    body: JSON.stringify(events),
  }).catch(() => {}); // fire-and-forget
}

app.use(express.static(path.join(__dirname, '../public')));

// --- City catalog used both for random and user selection ---
const CITIES = [
  { key: 'denver', name: 'Denver, US', lat: 39.7392, lon: -104.9903 },
  { key: 'slc', name: 'Salt Lake City, US', lat: 40.7608, lon: -111.8910 },
  { key: 'sf', name: 'San Francisco, US', lat: 37.7749, lon: -122.4194 },
  { key: 'nyc', name: 'New York, US', lat: 40.7128, lon: -74.0060 },
  { key: 'london', name: 'London, UK', lat: 51.5074, lon: -0.1278 },
  { key: 'sydney', name: 'Sydney, AU', lat: -33.8688, lon: 151.2093 },
  { key: 'tokyo', name: 'Tokyo, JP', lat: 35.6762, lon: 139.6503 }
];

function getRandomCity() {
  return CITIES[Math.floor(Math.random() * CITIES.length)];
}

function findCityByKey(key?: string) {
  if (!key) return undefined;
  return CITIES.find(c => c.key === key.toLowerCase());
}

// Optional helper to call Open‑Meteo using native fetch (Node 18+)
async function fetchWeather(lat: number, lon: number, cityName?: string) {
  const span = tracer.startSpan('weather.fetch', {
    attributes: {
      'weather.city': cityName ?? 'custom',
      'weather.lat': lat,
      'weather.lon': lon,
      'weather.provider': 'open-meteo',
    },
  });

  const start = Date.now();
  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current_weather: 'true',
      temperature_unit: 'fahrenheit',
      wind_speed_unit: 'mph',
      timezone: 'auto',
    });

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: controller.signal })
      .finally(() => clearTimeout(t));

    if (!resp.ok) throw new Error(`Open-Meteo responded ${resp.status}`);
    const data = await resp.json() as any;

    fetchDuration.record(Date.now() - start, { city: cityName ?? 'custom' });
    span.setStatus({ code: SpanStatusCode.OK });
    return data;
  } catch (err: any) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message });
    span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

// --- API: optional list of cities for dropdown population ---
app.get('/weather/cities', (_req, res) => {
  res.json(CITIES.map(({ key, name, lat, lon }) => ({ key, name, lat, lon })));
});

// --- API: /weather now supports three modes ---
// 1) ?city=denver (picks from catalog)
// 2) ?lat=..&lon=.. (ad-hoc coordinates)
// 3) no params => random city (existing behavior)
app.get('/weather', async (req, res) => {
  const reqStart = Date.now();
  try {
    let selected: { key?: string; name: string; lat: number; lon: number } | undefined;
    let requestSource: string;

    if (req.query.city) {
      const city = findCityByKey(String(req.query.city));
      if (!city) {
        return res.status(400).json({ error: 'Unknown city key', allowed: CITIES.map(c => c.key) });
      }
      selected = city;
      requestSource = 'user_selected';
    } else if (req.query.lat && req.query.lon) {
      const lat = Number(req.query.lat);
      const lon = Number(req.query.lon);
      if (Number.isNaN(lat) || Number.isNaN(lon)) {
        return res.status(400).json({ error: 'Invalid lat/lon' });
      }
      selected = { name: `Custom (${lat}, ${lon})`, lat, lon };
      requestSource = 'coordinates';
    } else {
      selected = getRandomCity();
      requestSource = 'random';
    }

    const data = await fetchWeather(selected.lat, selected.lon, selected.name);
    const cw = data?.current_weather;
    if (!cw) return res.status(502).json({ error: 'No current_weather in response', city: selected });

    const responseMs = Date.now() - reqStart;
    const events: object[] = [{
      'event.type': 'weather.request',
      'event.provider': 'dynatrace-weather-app',
      'city.name': selected.name,
      'city.key': selected.key ?? 'custom',
      'temperature': cw.temperature,
      'weather.code': cw.weathercode,
      'windspeed': cw.windspeed,
      'request.source': requestSource,
      'response.time.ms': responseMs,
    }];

    if (cw.temperature < 0 || cw.temperature > 100) {
      events.push({
        'event.type': 'weather.alert',
        'event.provider': 'dynatrace-weather-app',
        'city.name': selected.name,
        'city.key': selected.key ?? 'custom',
        'temperature': cw.temperature,
        'alert.reason': cw.temperature < 0 ? 'extreme_cold' : 'extreme_heat',
      });
    }

    sendBizEvents(events);

    res.json({
      city: selected.name,
      coordinates: { lat: selected.lat, lon: selected.lon },
      observed_at: cw.time,
      temperature: cw.temperature,
      windspeed: cw.windspeed,
      winddirection: cw.winddirection,
      weathercode: cw.weathercode,
      units: { temperature: 'fahrenheit', windspeed: 'mph' },
      provider: 'Open-Meteo'
    });
  } catch (err: any) {
    const message = err?.name === 'AbortError' ? 'request timed out' : (err?.message || String(err));
    res.status(500).json({ error: 'Failed to fetch weather', detail: message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Listening for requests on http://${HOST}:${PORT}`);
});
