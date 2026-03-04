# Pixel Agents — OpenClaw Edition

A VS Code extension that turns your OpenClaw AI agents into animated pixel art characters in a virtual office.

Each OpenClaw session you open spawns a character that walks around, sits at desks, and visually reflects what the agent is doing — typing when executing commands, reading when browsing the web, waiting when it needs your attention.

> Forked from [pablodelucca/pixel-agents](https://github.com/pablodelucca/pixel-agents) and adapted for [OpenClaw](https://github.com/openclaw/openclaw).

![Pixel Agents screenshot](webview-ui/public/Screenshot.jpg)

## Features

- **One agent, one character** — every OpenClaw session gets its own animated character
- **Live activity tracking** — characters animate based on what the agent is actually doing (exec, browser, canvas, discord, slack, and more)
- **Office layout editor** — design your office with floors, walls, and furniture using a built-in editor
- **Speech bubbles** — visual indicators when an agent is waiting for input or needs permission
- **Sound notifications** — optional chime when an agent finishes its turn
- **Sub-agent visualization** — sub-agents spawn as separate characters linked to their parent
- **Persistent layouts** — your office design is saved and shared across VS Code windows
- **Diverse characters** — 6 diverse characters based on the work of [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

## Requirements

- VS Code 1.109.0 or later
- [OpenClaw](https://github.com/openclaw/openclaw) installed with the gateway running (`openclaw status`)

## Getting Started

### Install from source

```bash
git clone https://github.com/DevvGwardo/pixel-agents.git
cd pixel-agents
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then press **F5** in VS Code to launch the Extension Development Host.

### Usage

1. Make sure your OpenClaw gateway is running (`openclaw gateway start`)
2. Open the **Pixel Agents** panel (it appears in the bottom panel area alongside your terminal)
3. Click **+ Agent** to spawn a new OpenClaw terminal and its character
4. Start working with your agent — watch the character react in real time
5. Click a character to select it, then click a seat to reassign it
6. Click **Layout** to open the office editor and customize your space

### How It Works

Pixel Agents watches OpenClaw's JSONL session transcript files (`~/.openclaw/agents/<agentId>/sessions/`) to track what each agent is doing. When an agent uses a tool (like `exec`, `browser`, or `canvas`), the extension detects it and updates the character's animation accordingly. No modifications to OpenClaw are needed — it's purely observational.

The webview runs a lightweight game loop with canvas rendering, BFS pathfinding, and a character state machine (idle → walk → type/read). Everything is pixel-perfect at integer zoom levels.

### OpenClaw Tool Animations

| OpenClaw Tool | Animation |
|---|---|
| `exec` | Typing (running commands) |
| `browser` | Reading (browsing the web) |
| `canvas` | Typing (drawing) |
| `nodes` | Typing (working with nodes) |
| `cron` | Typing (scheduling) |
| `discord` / `slack` | Typing (messaging) |
| `sessions` | Reading (managing sessions) |

## Layout Editor

The built-in editor lets you design your office:

- **Floor** — Full HSB color control
- **Walls** — Auto-tiling walls with color customization
- **Tools** — Select, paint, erase, place, eyedropper, pick
- **Undo/Redo** — 50 levels with Ctrl+Z / Ctrl+Y
- **Export/Import** — Share layouts as JSON files via the Settings modal

The grid is expandable up to 64x64 tiles. Click the ghost border outside the current grid to grow it.

### Office Assets

The office tileset used in this project is **[Office Interior Tileset (16x16)](https://donarg.itch.io/officetileset)** by **Donarg**, available on itch.io for **$2 USD**.

This is the only part of the project that is not freely available. To use the full furniture set, purchase the tileset and run:

```bash
npm run import-tileset
```

The extension works without it — you get default characters and basic layout, but the full furniture catalog requires the imported assets.

## Tech Stack

- **Extension**: TypeScript, VS Code Webview API, esbuild
- **Webview**: React 19, TypeScript, Vite, Canvas 2D

## Configuration

The extension auto-discovers your OpenClaw agent by scanning `~/.openclaw/agents/`. If you have multiple agents, it uses the first one found. To change this, edit `getProjectDirPath()` in `src/agentManager.ts`.

The terminal command used to start a session is `openclaw chat --session <id>`. If your setup uses a different command, update line 65 in `src/agentManager.ts`.

## Known Limitations

- **Agent-terminal sync** — connections between agents and terminal instances can desync, especially when terminals are rapidly opened/closed or restored across sessions
- **Heuristic-based status detection** — detection for when an agent is waiting or finished is based on heuristics (idle timers, turn-end events) and may occasionally misfire
- **Turn-end detection** — if OpenClaw doesn't emit a `turn_end` system event, the fallback 5-second idle timer handles it

## Credits

- Original extension by [Pablo De Lucca](https://github.com/pablodelucca/pixel-agents)
- Characters by [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)
- OpenClaw by [openclaw](https://github.com/openclaw/openclaw)

## License

This project is licensed under the [MIT License](LICENSE).
