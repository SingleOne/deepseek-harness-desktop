# DSH 版本变更记录

本文档用于记录官方 `@deepseek-ai/dsh` 的版本变化，方便桌面端后续适配、排查兼容性问题和设计插件能力时直接查阅。

## 0.1.0-rc.7

- 发布时间：2026-08-17
- 对比基线：`0.1.0-rc.6`
- npm 包：[`@deepseek-ai/dsh@0.1.0-rc.7`](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.1.0-rc.7)
- 官方代码对比：[rc.6 → rc.7](https://github.com/deepseek-ai/deepseek-harness/compare/fb82698709c39f1860b0ab0ed147e1fa30c1d5d0...dsh-v0.1.0-rc.7)

### 主要变化

- 增强图片与富媒体支持：完善 ACP 图片消息、MCP 图片结果、Code Mode 嵌套图片结果传递，以及多图片顺序处理。
- 新增插件自有设置界面：插件可以在 Web 设置页注册并展示自己的配置卡片。
- 改进子 Agent：Codex 和 Claude Code 子 Agent 支持一次性后台任务。
- 优化模型调用：DeepSeek 支持较低推理强度；修复达到 `max_tokens` 后继续生成时的上下文回放状态问题。
- 改进 Web UI：用户提问卡片可以折叠；修复 Safari 输入框换行布局、超长历史记录分页栈溢出、PowerShell 终端界面重复加载等问题。
- 改进终端运行：持久化 Bash 保留受控提示符，减少命令结束后的等待时间；升级 `node-pty` 并改善 Python Runtime 的预编译回退。
- 调整预设名称：原来的 Code 预设改名为 `PTC Mode`。
- 优化发布与加载性能：移除 Web module-preload polyfill，并修复 npm 包发布顺序、可选依赖检查和浏览器依赖打包问题。

### 影响概览

本版本的重点是富媒体链路、插件设置扩展、后台子 Agent，以及 Web 和终端稳定性。桌面端后续升级 DSH 时，应重点回归插件设置页、图片消息链路、子 Agent 后台任务和内嵌终端。

### 记录说明

官方仓库没有为 `rc.7` 提供独立的手写 changelog；以上内容根据 npm 正式发布版本和官方仓库中 `rc.6` 发布提交到 `rc.7` 标签之间的实际变更整理，不以普通提交哈希作为版本是否可用的判断依据。
