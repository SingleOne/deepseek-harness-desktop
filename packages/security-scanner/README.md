# @dsh-desktop/security-scanner

与 Electron、Desktop UI 和插件安装事务无关的静态扫描核心。它读取 npm/GitHub tar 归档，执行有界归档解析、manifest、内容组合规则和 JS-X-Ray AST 检测，并返回结构化覆盖报告。报告同时列出制品 manifest 中的生产依赖，并为调用方补充锁树、OSV、registry 签名、provenance 与发布时间信号预留了结构化字段。

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

核心库不负责下载制品、查询 OSV、弹出 UI、停止 DSH 或决定是否执行安装。调用方应根据 `coverage`、`findings` 和 `recommendation` 应用自己的策略；扫描不完整时不得把结果当作安全通过。
