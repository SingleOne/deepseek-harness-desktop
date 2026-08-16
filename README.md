# deepseek-harness-desktop

[English](README_EN.md)

`deepseek-harness-desktop` 是官方 DeepSeek Harness Web UI 的桌面外壳，会辅助检查 DeepSeek Harness 更新，并在主窗口提供社区插件的浏览、搜索、安装和卸载功能。

插件市场使用社区目录进行发现，所有安装和卸载操作均委托给 DSH 官方 `dsh plugin --profile web` 命令。桌面端不保存模型凭据和会话；插件及其配置由 DSH web profile 管理。

部分 GitHub 插件使用 `prepare` 脚本在安装时构建。pnpm 默认拦截这类脚本；桌面端会校验 pnpm 返回的仓库和精确提交，在用户第二次确认后将对应 key 写入 web profile 的 `allowBuilds` 并自动重试。授权只覆盖所选仓库的该次 Git 提交，不会放开其他依赖。

## 通知中心集成

安装独立的 [`dsh-notify-center`](https://github.com/SingleOne/dsh-notify-center) 插件后，桌面端会在每次启动时创建仅监听 `127.0.0.1` 的认证通知桥接，并只把随机端点和临时令牌注入由本 App 启动的 DSH Web 子进程。插件负责通知规则、设置页面、本机通知回退和 Webhook 投递；桌面端只负责 Electron 系统通知，以及用户点击通知后的窗口恢复和会话定位。

桥接不可用或系统不支持 Electron 通知时，插件会自动回退到自身的 Windows、macOS 或 Linux 原生通知。因此插件可以脱离本桌面 App 独立运行；Webhook 也始终由插件直接发送。

## 开发

需要 Node.js 和 npm。

```powershell
npm install
npm run dev
```

```powershell
npm run dev:debug
npm run check
npm run package:win
```
