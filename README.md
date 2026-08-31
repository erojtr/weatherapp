# Dynatrace Weather App

A Node.js/TypeScript/Express demo app that pulls live weather data from [Open-Meteo](https://open-meteo.com/) and serves it through a dynamic, glassmorphism-styled frontend. Built as a full-platform Dynatrace showcase — each layer of the stack is instrumented with a different DT capability.

**Live:** http://13.221.41.29:8080/weatherapp.html

---

## App Architecture

```
Browser (weatherapp.html)
    │  XHR → GET /weather?city=tokyo
    ▼
Express (app.ts, port 8080)
    │  fetchWeather() → Open-Meteo API
    │  sendBizEvents() → DT /api/v2/bizevents/ingest
    ▼
OTel SDK (tracing.ts)
    │  OTLP protobuf → DT /api/v2/otlp/v1/traces
    │  OTLP protobuf → DT /api/v2/otlp/v1/metrics
    ▼
Dynatrace tenant: act53954.sprint.dynatracelabs.com
```

### Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20, TypeScript |
| Framework | Express 5 |
| Process manager | PM2 (`ecosystem.config.js`) |
| Weather data | Open-Meteo (free, no API key) |
| Infrastructure | AWS EC2 `t3.large`, `us-east-1` |

---

## Repository Structure

```
weatherapp/
├── app.ts                  # Express server + weather API + biz events
├── tracing.ts              # OTel SDK bootstrap (must be imported first)
├── tsconfig.json           # TypeScript config (target ES2020, outDir ./dist)
├── package.json
├── .env                    # Local only — DT_ENV_URL, DT_API_TOKEN, PORT
├── .gitignore              # Excludes node_modules, dist, .env, compiled JS
├── public/
│   └── weatherapp.html     # Single-page frontend (RUM tag, canvas particles)
└── .github/
    └── workflows/
        ├── deploy.yml          # Staging deploy (CI-triggered)
        └── deploy-prod.yml     # Production promote (manual trigger)
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/weather` | Random city weather |
| `GET` | `/weather?city=tokyo` | Specific city (see city keys below) |
| `GET` | `/weather?lat=51.5&lon=-0.1` | Ad-hoc coordinates |
| `GET` | `/weather/cities` | List all available cities |

**Supported city keys:** `denver`, `slc`, `sf`, `nyc`, `london`, `sydney`, `tokyo`

**Response shape:**
```json
{
  "city": "Tokyo, JP",
  "coordinates": { "lat": 35.6762, "lon": 139.6503 },
  "observed_at": "2026-08-31T12:00",
  "temperature": 82.4,
  "windspeed": 7.2,
  "winddirection": 220,
  "weathercode": 3,
  "units": { "temperature": "fahrenheit", "windspeed": "mph" },
  "provider": "Open-Meteo"
}
```

---

## Frontend

`public/weatherapp.html` is a self-contained single-page app — no build step, no framework.

**Features:**
- **City dropdown + Random button** — fetches `/weather` via XHR on every selection
- **Dynamic background gradient** — changes color based on WMO weather condition
- **Weather condition icons + labels** — mapped from WMO `weathercode` (e.g., 🌧 Rain, ❄️ Snow, ⛈ Thunderstorm)
- **Canvas particle system** — full-viewport animated particles that match the condition:
  - Clear/night → twinkling stars
  - Rain → falling rain streaks
  - Snow → drifting snowflakes
  - Thunderstorm → fast storm streaks with lightning flash
- **Animated CSS orbs** — three large blurred gradient orbs drifting behind the UI
- **Glassmorphism card** — `backdrop-filter: blur()` with semi-transparent background
- **Stats grid** — wind speed, compass direction, latitude, longitude

---

## Dynatrace Instrumentation

### OneAgent (host-level)

Installed on the EC2 instance. Auto-discovers the Node.js process and instruments it with zero code changes. Provides:
- Service topology and dependencies
- Auto-instrumented HTTP/Express traces
- Host metrics (CPU, memory, network)
- Service health and anomaly detection

The service shows up in DT as **`dynatrace-weather-app`** with both OneAgent traces and OTel custom spans visible side by side.

---

### Phase 1 — OpenTelemetry (Custom Spans + Metrics)

**File:** `tracing.ts`

Bootstraps the OTel NodeSDK at process start. Must be the first import in `app.ts`:

```typescript
import './tracing'; // always first
```

**What's exported:**

| Signal | Details |
|---|---|
| Traces | `weather.fetch` span wrapping every Open-Meteo API call |
| Metrics | `weather.fetch.duration` histogram (ms per city, exported every 15s) |

**Span attributes on `weather.fetch`:**

| Attribute | Example |
|---|---|
| `weather.city` | `"Tokyo, JP"` |
| `weather.lat` | `35.6762` |
| `weather.lon` | `139.6503` |
| `weather.provider` | `"open-meteo"` |

**Critical implementation details:**
- DT requires `application/x-protobuf` — uses `@opentelemetry/exporter-trace-otlp-proto` and `@opentelemetry/exporter-metrics-otlp-proto` (NOT the `-http` JSON variants)
- `OTEL_LOGS_EXPORTER=none` must be set to suppress the default localhost:4318 logs exporter
- `ignoreOutgoingRequestHook` excludes `dynatracelabs.com` from http auto-instrumentation so the exporter's own HTTP calls aren't intercepted

**Where to look in DT:**
- Services → `dynatrace-weather-app` → Distributed traces → filter by `span.source = OpenTelemetry`
- DQL: `fetch spans | filter service.name == "dynatrace-weather-app" | filter span.name == "weather.fetch"`

---

### Phase 2 — Real User Monitoring (RUM)

**File:** `public/weatherapp.html` (`<head>`)

Agentless RUM — a single CDN-hosted JS tag injected into the HTML:

```html
<script type="text/javascript"
  src="https://js-cdn.dynatracelabs.com/jstag/145e049b9b1/bf12352mhz/85ad107277f9ecee_complete.js"
  crossorigin="anonymous"></script>
```

DT Application: **`APPLICATION-CD12E7F136DBA675`** ("Weather app")

**What's captured:**
- Browser sessions and user actions
- XHR actions on `/weather` (auto-captured)
- Frontend performance: page load time, TTFB, render time
- JavaScript errors
- Connected to backend OTel traces via W3C trace context propagation

**Where to look in DT:**
- Applications → Weather app → User sessions
- DQL: `fetch user.events | filter dt.rum.application.id == "APPLICATION-CD12E7F136DBA675" | filterOut dt.rum.user_type == "synthetic"`

---

### Phase 3 — Synthetic Monitoring

Configured in DT (no code changes). Automated checks running on a schedule from multiple global locations.

**Where to look in DT:**
- Synthetic → Monitors

---

### Phase 4 — Business Observability (Biz Events)

**File:** `app.ts` — `sendBizEvents()` function

Fires business events to DT on every `/weather` response using the Events API:

```
POST /api/v2/bizevents/ingest
Content-Type: application/json
```

**`weather.request` event** — emitted on every successful response:

| Field | Example |
|---|---|
| `event.type` | `"weather.request"` |
| `event.provider` | `"dynatrace-weather-app"` |
| `city.name` | `"Tokyo, JP"` |
| `city.key` | `"tokyo"` |
| `temperature` | `82.4` |
| `weather.code` | `3` |
| `windspeed` | `7.2` |
| `request.source` | `user_selected \| random \| coordinates` |
| `response.time.ms` | `134` |

**`weather.alert` event** — emitted additionally when `temperature < 0°F` or `temperature > 100°F`:

| Field | Example |
|---|---|
| `event.type` | `"weather.alert"` |
| `alert.reason` | `extreme_cold \| extreme_heat` |

Note: ingest lag is ~3–4 minutes before events appear in DQL.

**Where to look in DT:**
- DQL: `fetch bizevents | filter event.provider == "dynatrace-weather-app"`
- DQL: `fetch bizevents | filter event.type == "weather.alert"`

---

## Local Development

### Prerequisites

- Node.js 20+
- A Dynatrace tenant with an API token scoped for `openTelemetryTrace.ingest`, `metrics.ingest`, `bizevents.ingest`

### Setup

```bash
git clone https://github.com/erojtr/weatherapp.git
cd weatherapp
npm install
```

Create `.env`:
```
DT_ENV_URL=https://<your-tenant>.dynatracelabs.com
DT_API_TOKEN=dt0c01.<your-token>
PORT=8080
```

Build and run:
```bash
npm run start:local
# → http://localhost:8080/weatherapp.html
```

---

## EC2 Deployment

The app runs on EC2 managed by PM2. Environment variables are set in `ecosystem.config.js` (not committed — contains the API token).

```bash
# SSH into EC2
ssh -i ~/path/to/key.pem ec2-user@<ec2-ip>

# Deploy updated files
scp -i key.pem public/weatherapp.html ec2-user@<ec2-ip>:~/weatherapp/public/
scp -i key.pem app.ts tracing.ts ec2-user@<ec2-ip>:~/weatherapp/

# Rebuild and restart on EC2
cd weatherapp && npm run build && pm2 restart weatherapp
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DT_ENV_URL` | Yes | Full DT tenant URL, e.g. `https://abc123.live.dynatrace.com` |
| `DT_API_TOKEN` | Yes | DT API token with OTel + bizevents ingest scopes |
| `PORT` | No | HTTP port (default `8080`) |
| `OTEL_LOGS_EXPORTER` | Yes (EC2) | Set to `none` to suppress default localhost logs exporter |
