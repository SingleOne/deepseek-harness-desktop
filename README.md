# deepseek-harness-desktop

`deepseek-harness-desktop` 是官方 DeepSeek Harness Web UI 的轻量桌面启动器。应用不实现、不代理 DSH 功能，也不保存 DSH 配置。

## 行为边界

- DSH 功能、凭据、模型、会话、插件、工作区和权限全部由官方 DSH 提供。
- DSH 由 npm 全局安装目录提供，`deepseek-harness-desktop` 不内置或固定 DSH 版本。
- DSH 更新与 `deepseek-harness-desktop` 更新分别检查、分别提示。
- 只有用户确认后才更新 DSH；用户可以继续运行已安装的旧版本。
- 启动日志只保留在当前进程内存中，不写入文件。
- 应用不使用 `electron-store`、`localStorage` 或自定义 `DSH_HOME`。
- Electron 必需的临时运行目录位于系统 `%TEMP%`，正常退出时清理，不写入用户配置目录。

## 启动流程

1. 独立检查 `deepseek-harness-desktop` 更新。
2. 从 npm 全局目录读取已安装 DSH 版本。
3. 从 npm `dist-tags.latest` 查询最新 DSH 版本。
4. 有更新时由用户选择更新、继续当前版本或取消启动。
5. 使用用户最终选择的已安装 DSH 版本启动 `dsh web`。
6. 本地服务就绪后默认关闭启动页，直接加载官方 DSH Web UI。

调试启动：

```powershell
.\deepseek-harness-desktop.exe --launcher-debug
```

带 `--launcher-debug` 时，启动页会保留在前台，右侧显示本次启动的详细命令、标准输出、错误输出和 HTTP 等待日志；点击“进入 DSH Web UI”后再切换到官方页面。未带参数时只执行正常启动步骤，DSH 就绪后直接进入官方页面。

如果没有安装 DSH，应用会先询问是否安装 npm 当前的 `latest` 版本。

## 开发

要求本机存在 Node.js 与 npm。

```powershell
npm install
npm run dev
```

开发时启用详细启动日志并保留启动窗口：

```powershell
npm run dev:debug
```

等价的完整传参写法是 `npm run dev -- -- --launcher-debug`。其中第一个 `--` 由 npm 处理，第二个 `--` 告诉 electron-vite 将后面的 `--launcher-debug` 继续传给 Electron。

静态检查与构建：

```powershell
npm run typecheck
npm run build
```

Windows 安装包：

```powershell
npm run package:win
```

## deepseek-harness-desktop 更新源

构建时通过 `DEEPSEEK_HARNESS_DESKTOP_UPDATE_MANIFEST_URL` 指定独立更新源：

```powershell
$env:DEEPSEEK_HARNESS_DESKTOP_UPDATE_MANIFEST_URL = 'https://example.com/deepseek-harness-desktop/latest.json'
npm run package:win
```

支持项目自己的 JSON 清单：

```json
{
  "version": "0.2.0",
  "downloadUrl": "https://example.com/deepseek-harness-desktop-0.2.0-x64.exe"
}
```

也支持 GitHub `releases/latest` API 返回的 `tag_name` 与 `html_url`。未配置更新源时只跳过 `deepseek-harness-desktop` 更新检查，不影响独立的 DSH 更新检查。
