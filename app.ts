
// app.ts 
import express, { Express } from 'express';
import { setTimeout as delay } from 'timers/promises';

const PORT: number = parseInt(process.env.PORT || '8080');
const app: Express = express();
const HOST = process.env.HOST || '0.0.0.0';

// Serve /public
app.use(express.static('public'));

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
async function fetchWeather(lat: number, lon: number) {

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current_weather: 'true',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: 'auto'
  });

  
  // timeout via AbortController
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);

  const resp = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: controller.signal })
    .finally(() => clearTimeout(t));

  if (!resp.ok) throw new Error(`Open-Meteo responded ${resp.status}`);
  const data = await resp.json();
  return data;
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
  try {
    let selected:
      | { name: string; lat: number; lon: number }
      | undefined;

    if (req.query.city) {
      const city = findCityByKey(String(req.query.city));
      if (!city) {
        return res.status(400).json({ error: 'Unknown city key', allowed: CITIES.map(c => c.key) });
      }
      selected = city;
    } else if (req.query.lat && req.query.lon) {
      const lat = Number(req.query.lat);
      const lon = Number(req.query.lon);
      if (Number.isNaN(lat) || Number.isNaN(lon)) {
        return res.status(400).json({ error: 'Invalid lat/lon' });
      }
      selected = { name: `Custom (${lat}, ${lon})`, lat, lon };
    } else {
      selected = getRandomCity();
    }

    const data = await fetchWeather(selected.lat, selected.lon);
    const cw = data?.current_weather;
    if (!cw) return res.status(502).json({ error: 'No current_weather in response', city: selected });

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
