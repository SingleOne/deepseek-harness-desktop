# deepseek-harness-desktop

[中文](README.md)

`deepseek-harness-desktop` is a lightweight desktop shell for the official DeepSeek Harness Web UI. It handles startup and update checks, and provides community plugin management and system notification integration. Model credentials, sessions, and plugin configuration remain managed by DSH.

## Plugin marketplace

Marketplace data comes from the [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) project. Plugins can be searched, filtered by category, and sorted by Star count, with npm and GitHub sources clearly identified.

Installation and removal are delegated to the official `dsh plugin --profile web` command. The app asks for confirmation and restarts DSH when needed. GitHub plugins that require a `prepare` script receive an additional repository and commit confirmation before builds are allowed.

Installed plugins are checked for updates once at every app startup: npm plugins are compared with the latest registry version, while GitHub plugins are compared with their remote commit. The available-update count is shown on the Installed tab and persisted locally; the previous result is retained when the current check is unavailable. Plugins are never upgraded automatically.

Marketplace entries are community-maintained and are not reviewed or endorsed by DeepSeek. Install only plugins you trust.

## Notification Center integration

With [`dsh-notify-center`](https://github.com/SingleOne/dsh-notify-center) installed, the desktop app uses an authenticated bridge bound only to `127.0.0.1` to show Electron system notifications and restore and navigate the window when a notification is clicked. If the bridge is unavailable, the plugin falls back to its own native notification implementation.

![截屏1](./assets/scree_shot_pluginmarket_zh.png)

## Requirements

The desktop app requires Node.js 22.13 or later and npm. On macOS, it reads PATH from the login shell so that Node.js installations managed by Homebrew, nvm, and similar tools can be discovered.

## Development

Node.js and npm are required.

```powershell
npm install
npm run dev
```

```powershell
npm run dev:debug
npm run check
npm run package:win
npm run package:mac
```

`package:mac` must run on macOS. It produces separate Apple Silicon (arm64) and Intel (x64) DMG files in `release`. Public distribution also requires Apple Developer ID signing and notarization.

## Acknowledgements

[linux.do](https://linux.do)
