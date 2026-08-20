# @dsh-desktop/security-scanner

与 Electron、Desktop UI 和插件安装事务无关的静态扫描核心。它读取 npm/GitHub tar 归档，只报告明确的归档逃逸、恶意安装脚本、数据外传、下载执行、编码执行和代码混淆等阻断级行为。普通网络访问、环境变量读取、命令调用、生命周期脚本和代码质量信号不会形成风险项。

报告同时列出制品 manifest 中的生产依赖，并为调用方补充锁树与 OSV 严重漏洞查询预留结构化字段。缺少签名、缺少 provenance、发布时间较新或在线情报暂时不可用可以记录为信号，但不应作为风险项展示或阻止安装。

DSH 专用规则通过独立规则包传入：

```ts
import { dshRulePack, scanArtifact } from '@dsh-desktop/security-scanner'

const report = await scanArtifact(
  {
    filePath: './plugin.tgz',
    identity: {
      source: 'npm',
      name: 'example-plugin',
      version: '1.0.0',
      digest: 'sha512 hex digest'
    }
  },
  { rulePacks: [dshRulePack] }
)
```

核心库不负责下载制品、查询 OSV、弹出 UI、停止 DSH 或决定是否执行安装。调用方应仅在 `recommendation` 为 `block` 或存在 `critical` 风险项时阻止安装；覆盖不完整可以保留说明，但不属于恶意代码结论。
