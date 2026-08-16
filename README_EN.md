# deepseek-harness-desktop

[中文](README.md)

`deepseek-harness-desktop` is a desktop shell for the official DeepSeek Harness Web UI. It helps check for DeepSeek Harness updates and provides browsing, search, installation, and removal of community plugins in the main window.

The marketplace uses a community catalog for discovery, while all changes are delegated to the official `dsh plugin --profile web` command. The desktop shell does not store model credentials or sessions; plugins and their configuration are managed by the DSH web profile.

## Development

Node.js and npm are required.

```powershell
npm install
npm run dev
```

```powershell
npm run dev:debug
npm run typecheck
npm run build
npm run package:win
```
