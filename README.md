# Discord Channel Tabs (Experimental)

A Chrome/Edge Manifest V3 extension that brings a lightweight tab bar to [discord.com/app](https://discord.com/app). It mirrors key workflows from the original BetterDiscord ChannelTabs plugin while avoiding unsupported client mods.

## Features

- Pinned tabs for guild channels, DMs, and the friends view
- Unread and mention badges with toast notifications
- Middle-click close and drag-to-reorder tab management
- Persistent tab layout via `chrome.storage` (with safe local fallback)
- Robust navigation helpers that survive Discord route changes
- Automatic avatar/icon hydration for guilds, DMs, and friends tabs

## Quick Start

1. **Install dependencies**
   ```sh
   npm install
   ```
2. **Build the extension**
   ```sh
   npm run build
   ```
   Bundled assets are emitted to `dist/`.
3. **Load in your browser**
   - Open `chrome://extensions` or `edge://extensions`
   - Enable *Developer mode*
   - Choose *Load unpacked* and select the `dist` directory
4. Visit [discord.com/app](https://discord.com/app) and confirm the `[DiscordTabs]` logs appear in DevTools.

## Development Workflow

- `npm run watch` keeps esbuild running in watch mode. After each rebuild, refresh the extension from the extensions page and reload Discord.
- `npm run clean` removes the generated `dist/` output.
- Runtime state and helpers are exposed under `window.DiscordTabsDebug` for quick inspection.

## Troubleshooting

- Discord’s internal module layout changes often. If the tab bar stops rendering, check the console for `DiscordTabs` warnings and adjust the store discovery heuristics in `src/content/index.ts`.
- Ensure no other extensions inject conflicting styles into the Discord header; the tab bar expects control of the left side of the title bar.

## Contributing

Issues and PRs are welcome. Please avoid submitting logs or configs that contain personal guild/channel IDs or authentication tokens.

## License

No license has been specified yet. Until one is added, treat the project as “all rights reserved.”
