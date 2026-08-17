# deepseek-harness-desktop

[中文](README.md)

`deepseek-harness-desktop` is a desktop shell for the official DeepSeek Harness Web UI. It helps check for DeepSeek Harness updates and provides browsing, search, installation, and removal of community plugins in the main window.

The marketplace uses a community catalog for discovery, while all changes are delegated to the official `dsh plugin --profile web` command. The desktop shell does not store model credentials or sessions; plugins and their configuration are managed by the DSH web profile.

Some GitHub plugins build during installation through a `prepare` script, which pnpm blocks by default. The desktop app verifies the repository and exact commit reported by pnpm, then—after a second user confirmation—adds only that key to the web profile's `allowBuilds` map and retries automatically. The approval does not apply to other dependencies or commits.

## Notification Center integration

With the standalone [`dsh-notify-center`](https://github.com/SingleOne/dsh-notify-center) plugin installed, the desktop app starts an authenticated notification bridge bound only to `127.0.0.1`. Its random endpoint and ephemeral token are injected only into the DSH Web child process launched by this app. The plugin owns notification rules, settings UI, native fallback notifications, and webhook delivery; the desktop app only presents Electron system notifications and restores and navigates the window when a notification is clicked.

If the bridge is unavailable or Electron notifications are unsupported, the plugin automatically falls back to its own Windows, macOS, or Linux notification implementation. The plugin therefore remains fully usable without this desktop app, and webhooks are always delivered directly by the plugin.

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
