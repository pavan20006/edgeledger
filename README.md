# EdgeLedger

A small, local-first trading journal. Log every trade with your plan, notes and chart screenshots —
then see whether the edge is real: win rate, average R, profit factor, P&L by day and by setup.

No accounts, no cloud, no subscriptions. One Node process, one SQLite file, everything on your machine.

![Node.js](https://img.shields.io/badge/node-%E2%89%A522.5-3c873a?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-6d8cff)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

![EdgeLedger dashboard](docs/screenshot.png)

---

## Why another trading journal?

Most journals are either spreadsheets that stop being useful after 50 trades, or SaaS products that
want a subscription and your trade history. EdgeLedger is deliberately small: it records what you did,
answers the three questions that actually improve a trader — *am I winning, how much am I risking, and
which setup pays?* — and stays out of the way.

- **Fast to log.** A single form, keyboard shortcuts, auto-calculated P&L and R while you type.
- **Evidence, not vibes.** Every metric is shown with the sample size behind it.
- **Your data stays yours.** A SQLite file in the project folder. Back it up by copying one directory.
- **No build step.** Vanilla JavaScript, hand-rolled SVG charts, zero npm dependencies.

## Features

- **Trade log** — symbol, direction, setup, size, entry, stop, target, exit, fees, entry/exit times,
  notes and a 1–5 execution grade. Leave the exit empty to keep a position open.
- **Chart screenshots** — drag and drop, paste from the clipboard, or browse. Up to 8 images per trade,
  stored in the database, with thumbnails and a full-size viewer.
- **Performance summary** — net P&L, win rate, average R per trade, planned R:R, profit factor and
  average win/loss.
- **Equity curve** — cumulative net P&L with hover details and 7-day / 30-day / all-time ranges.
- **P&L by day** — a month calendar heatmap with daily results, monthly totals and click-to-filter.
- **P&L by setup** — setups ranked by net P&L with win rate, trade count and average R. Click one to
  filter the journal.
- **Filters and search** — by setup, direction, result (wins / losses / open), calendar day, or free
  text across symbol, setup and notes.
- **CSV export** — exports exactly what you are looking at, ready for a spreadsheet.
- **Sample data** — one click loads a realistic 23-trade demo journal so you can explore before
  entering your own trades.
- **Works on a phone** — responsive layout; screenshots can be attached straight from the camera roll.

## Requirements

- **Node.js 22.5 or newer** — the app uses Node's built-in `node:sqlite` module, so there is nothing to
  install. Check with `node --version`; if you need it, download it from [nodejs.org](https://nodejs.org).
- Any modern browser (Chrome, Edge, Firefox, Safari).

## Installation

```bash
git clone https://github.com/<your-username>/EdgeLedger.git
cd EdgeLedger
npm start
```

Then open **http://127.0.0.1:4173**.

There is no `npm install` step — the project has no dependencies. The database is created automatically
in `data/` the first time you start the server.

### Windows shortcut

Double-click **`start.cmd`**. It starts the server and opens the browser for you.

## Usage

1. **Log your first trade.** Fill in symbol, direction, size and entry price at minimum. A stop price
   unlocks R-multiple math; a target unlocks planned R:R. Leave *Exit* blank for an open position.
2. **Attach the chart.** Drop an image on the screenshot box, or just paste one with `Ctrl+V`.
3. **Review.** The dashboard updates immediately. Click any row to edit it, add a note, or close an
   open position by filling in the exit price.
4. **Find your edge.** Open *P&L by setup* to see which playbook actually makes money, and click a day
   on the calendar to review that session.
5. **Export when you need it.** *Export* downloads the currently filtered trades as CSV.

Keyboard: `N` new trade · `/` search · `Ctrl/⌘ + Enter` save · `Esc` close the image viewer.

## How the numbers are calculated

| Metric | Formula |
| --- | --- |
| Net P&L | `(exit − entry) × size × direction − fees` |
| Risk | `|entry − stop| × size` |
| R multiple | `P&L ÷ risk` |
| Planned R:R | `|target − entry| ÷ |entry − stop|` |
| Win rate | winning closed trades ÷ closed trades |
| Profit factor | gross profit ÷ gross loss |
| Avg R | mean R multiple across closed trades |
| P&L by day | realized P&L grouped by **exit** date |

Notes:

- Only **closed** trades (those with an exit price) count toward win rate, P&L and R.
- Fees are subtracted from P&L but not from the risk used for R.
- If a trade has no stop, R is shown as `—` instead of inventing a number.
- Times are stored exactly as entered (local wall-clock), with no timezone conversion.
- Currency is a **display choice** — selecting EUR relabels the numbers, it does not convert them.

## Data, backup and privacy

```
data/journal.db        your trades + screenshots (SQLite, WAL mode)
data/journal.db-wal
data/journal.db-shm
```

- Everything lives in that one file. To back up, stop the server and copy the `data/` folder.
- `data/` is listed in `.gitignore`, so your journal is never committed to Git.
- The server has no authentication and binds to `127.0.0.1` by default. It is a personal, single-user
  tool — do not expose it to the internet.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `PORT` / `--port` | `4173` | HTTP port |
| `HOST` / `--host` | `127.0.0.1` | Bind address |
| `JOURNAL_DB` | `data/journal.db` | Database file location |
| `--open` | off | Open the browser after starting |

```bash
npm start -- --port 8080     # different port
npm run open                 # start and open the browser
npm run dev                  # restart automatically when files change
```

## Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| Server | Node.js `node:http` | No framework needed for a small JSON API |
| Database | `node:sqlite` (built in) | One file, real SQL, zero dependencies |
| Frontend | Vanilla JS + CSS | No build step, no bundler, instant start |
| Charts | Hand-written SVG | No chart library to download or break |

## Project structure

```
EdgeLedger/
├── server.js            HTTP server, JSON API, SQLite schema and queries
├── public/
│   ├── index.html       page shell
│   ├── styles.css       dark theme, layout, responsive rules
│   └── app.js           state, rendering, stats, charts, editor
├── start.cmd            Windows one-click launcher
├── data/                created on first run — your journal (gitignored)
├── package.json
└── README.md
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Cannot find module 'node:sqlite'` | Node is older than 22.5 — update Node |
| `Port 4173 is already in use` | It is probably already running — just open the URL, or `npm start -- --port 4174` |
| Page says **Can't reach the journal server** | The HTML was opened from disk. Start `npm start` and use the http:// address |
| `'node' is not recognized` | Node.js is not installed or not on your PATH |
| Blank page / connection refused | The server window was closed — start it again and keep it open |

## License

No license has been added yet. Without one, the code is "all rights reserved" by default. If you want
others to reuse it, add a `LICENSE` file (MIT is a common, permissive choice for small tools).
