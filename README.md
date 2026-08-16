# deepseek-harness-desktop

[English](README_EN.md)

`deepseek-harness-desktop` 是官方 DeepSeek Harness Web UI 的桌面外壳，会辅助检查 DeepSeek Harness 更新，并在主窗口提供社区插件的浏览、搜索、安装和卸载功能。

插件市场使用社区目录进行发现，所有安装和卸载操作均委托给 DSH 官方 `dsh plugin --profile web` 命令。桌面端不保存模型凭据和会话；插件及其配置由 DSH web profile 管理。

## 开发

需要 Node.js 和 npm。

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
