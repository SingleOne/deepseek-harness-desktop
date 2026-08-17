# deepseek-harness-desktop

[English](README_EN.md)

`deepseek-harness-desktop` 是官方 DeepSeek Harness Web UI 的桌面外壳，会辅助检查 DeepSeek Harness 更新，并提供社区插件管理与系统通知集成。桌面端不保存模型凭据和会话，这些数据仍由 DSH 管理。

## 插件市场

主窗口顶部的“插件市场”用于浏览社区插件目录，支持按插件名称、作者或功能搜索和按类别筛选。目录可以包含 npm 和 GitHub 来源；市场内容来自社区，并不代表 DeepSeek 官方审核或推荐，安装前应自行确认插件仓库及其代码可信。

点击“安装”后，桌面端会显示第三方代码安全提示，并在用户确认后暂时停止当前 DSH Web 进程，通过 DSH 官方命令把插件加入 `web` profile：

```text
dsh plugin --profile web add <插件来源>
```

安装完成后，桌面端会检查插件是否声明为有效的 DSH bundle，解析 profile 配置并重新启动 DSH。没有正确加入 `dsh.profile.bundles` 的包会被恢复移除，避免无效依赖残留在 profile 中。

“已安装”页面只显示当前 `web` profile 中有效的第三方 bundle，并提供刷新和卸载入口。卸载同样由 DSH 官方命令完成，操作期间会安全停止并在结束后重新启动 DSH：

```text
dsh plugin --profile web remove <包名>
```

DSH 的插件命令会把依赖管理委托给 pnpm。桌面 App 启动后会先检测当前环境中的 `pnpm`；如果系统 pnpm 不可用，则只为插件管理子进程注入安装包自带的固定版本 pnpm。该回退不会全局安装 pnpm，也不会修改用户的系统 PATH 或现有 Node.js 环境。

部分 GitHub 插件使用 `prepare` 脚本在安装时构建。pnpm 默认拦截这类脚本；桌面端会校验 pnpm 返回的仓库和精确提交，在用户再次确认后将对应 key 写入 `web` profile 的 `pnpm-workspace.yaml` → `allowBuilds`，随后自动重试。授权只覆盖所选仓库的该次 Git 提交，不会放开其他依赖。

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

## 鸣谢

[linux.do](https://linux.do)
