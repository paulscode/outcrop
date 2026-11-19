# Outcrop: the console's web UI

The browser side of Outcrop's console: React 19 + TypeScript + Vite, Tailwind CSS v4, Radix primitives
(shadcn-style components in `src/components/ui`), TanStack Router and Query, Motion, uPlot, cmdk, sonner and lucide. The
console API (`console/outcrop/console`) serves the built files from `web/dist`; everything is local (no CDNs) and runs
under the console's CSP, including `style-src 'self'`.

## Develop

Node 22 or newer and pnpm 10 (`corepack enable` picks the version in `package.json`).

```sh
# the whole backend on this machine, with fake GPU data and generated traffic (console on :8800)
cd console && uv run python dev.py --fresh

# the UI with hot reload on :5173; /api (and its WebSocket) and /ca.crt go to :8800
cd web && pnpm install && pnpm dev
```

Sign in as `dev` / `harbor glacier lantern velvet orbit moss`. `OUTCROP_BACKEND=http://host:port pnpm dev` points the
proxy elsewhere. `node scripts/shot.mjs [--phone] [--light] /path …` signs in and saves screenshots to
`test-results/shots/` for a quick look.

## Check, test, build

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | `tsc --noEmit` over the app, the tests and the configs |
| `pnpm test` | Vitest: formatters, the live socket client, the request river, switch phases, prompt progress, logs, events, the bench noise band, SSE parsing, the playground's Markdown |
| `pnpm build` | the production build into `dist/` (`setup/build-ui.sh` runs it on the server, in a `node:22` container) |
| `pnpm e2e` | builds, then runs Playwright against `console/dev.py` on :8800 (it starts one if none is running) |
| `pnpm shots` | only the screenshots and accessibility checks (`e2e/screens.spec.ts`) |

The end-to-end tests (`e2e/`) cover sign-in (right, wrong, the lockout and its countdown), a token from creation to use
to revocation, opening the API with its banner and countdown, a preset switch with a request held for it, the connect
wizard lighting up on an app's first request, a CSP check of every page under `style-src 'self'`, and screenshots of
every page at 1440 × 900 and 375 × 812 with axe (serious or critical findings fail). Screenshots go to
`test-results/screenshots/`. The lockout test runs last, because it blocks new sign-ins from this address for a while;
`dev.py --fresh` clears it.

## How it is put together

| Path | Holds |
| --- | --- |
| `src/main.tsx`, `src/router.tsx` | providers, the routes (every page is its own chunk), the sign-in redirect |
| `src/lib/api.ts` | the API client: JSON, `X-Outcrop: 1`, 401 → sign-in, a 403 `{reauth: true}` → the password dialog, then a retry |
| `src/lib/live.ts` | one WebSocket to `/api/live`: ref-counted topics, reconnect with backoff, the last message replayed to late listeners, and the global stores (metrics, engine, units, gateway, switch, alerts, the request river) |
| `src/lib/requests.ts`, `phases.ts`, `progress.ts`, `switching.ts` | the request river reducer, a request's phases, prompt-reading progress, the launch sequence |
| `src/lib/apps.ts` | the Connect wizard's apps and their exact settings |
| `src/components/shell` | the layout, navigation, the API-open banner, the switch strip, the alert bell, the ⌘K palette |
| `src/components/viz` | sparklines, rings, bars, the memory strata, uPlot charts, the QR code |
| `src/pages` | one file per page |
| `src/shims/react-style-singleton.ts` | keeps Radix's scroll lock from adding a `<style>` element (the CSP forbids it) |

Design rules, kept everywhere: one color per meaning (reading the prompt violet, thinking indigo, answering teal, warnings
amber, errors rose, fine green; memory layers in earth tones), monospaced tabular figures for every number, plain words
first with engine terms in tooltips, real data only, and motion only where it means something (counters ease, lanes slide,
the idle hero breathes while the live connection is up; `prefers-reduced-motion` turns it off).

