# AI Usage Meter

A local browser dashboard for **Claude Code** and **Codex** usage and cost. It also covers every other agent [ccusage](https://github.com/ccusage/ccusage) detects (Copilot, OpenCode, Gemini and more).

All data stays on your machine. The server reads your local agent logs through ccusage and listens on `127.0.0.1` only.

## Quick start

Requires [Node.js](https://nodejs.org) 18.17 or newer.

```bash
git clone https://github.com/thprinkleth/ai-usage-meter.git
cd ai-usage-meter
npm install
npm start
```

Your browser opens at http://127.0.0.1:4646. If that port is taken, the next free one is used.

### Without cloning

```bash
npx github:thprinkleth/ai-usage-meter
```

## Features

- **Overview**: cost for today, the last 7 days, this month and all time, split by agent. Also the live Claude 5-hour block with projected cost and burn rate, daily and monthly charts, a calendar heatmap of the past year, a weekday-by-hour heatmap of Claude Code usage, top models, token mix (including cache use), top Claude projects and the most expensive sessions. Refreshes every 60 seconds.
- **Report explorer**: every ccusage report for Claude Code, Codex, all agents combined and each other agent. Each one has four views:
  - **Visual**: charts plus tables you can sort and expand
  - **JSON**
  - **Terminal**: ccusage's own colored table
  - **Help**

  Every report shows the matching `ccusage …` command to copy, and exports to JSON or CSV.
- **Claude projects and 5-hour blocks**: cost per project over time, and blocks tracked against a token limit (a number or `max`). The Overview card and the blocks Visual view start each block at your first message and predict when Claude's limit resets, using ccusage's costs and the timestamps in your local transcripts. Use on another device or on claude.ai isn't visible to them, so it can shift a real window. The Terminal and JSON views show ccusage's own hour-rounded blocks.
- **Statusline**: preview `ccusage statusline` against any of your Claude sessions, then copy the `settings.json` snippet to install it.
- **Full ccusage coverage**: the options panel is generated from `ccusage --help` at startup. Every command and flag of the installed version shows up automatically, and a Coverage page lists them all.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4646` | Port to listen on (fixed; no fallback when set) |
| `HOST` | `127.0.0.1` | Interface to bind |
| `CLAUDE_CONFIG_DIR` | `~/.claude`, `~/.config/claude` | Where Claude Code data lives (read by ccusage and for exact block times) |
| `CODEX_HOME` | `~/.codex` | Where Codex data lives (read by ccusage) |

`npm run serve` starts the server without opening a browser.

## Updating ccusage

```bash
npm run update-ccusage
```

Restart afterwards. New commands and flags appear automatically.

## License

MIT
