import type { RulePack, ScanFinding } from '../types.js'

function finding(
  ruleId: string,
  severity: ScanFinding['severity'],
  title: string,
  description: string,
  file: string,
  evidence?: string
): ScanFinding {
  return {
    ruleId,
    severity,
    category: 'dsh-patch',
    title,
    description,
    file,
    evidence,
    engine: 'dsh-rule-pack'
  }
}

export const dshRulePack: RulePack = {
  id: '@dsh-desktop/rules-dsh',
  version: '0.2.0',
  scan(context) {
    for (const entry of context.entries) {
      if (!entry.text) continue
      const name = entry.path.toLowerCase()
      const isPatch = name.endsWith('cordis.patch.yml') || name.endsWith('cordis.patch.yaml')
      if (isPatch && /!!(?:js|javascript)|(?:^|\s)(?:eval|function)\s*\(/im.test(entry.text)) {
        context.addFinding(finding(
          'dsh.patch.dynamic-expression',
          'critical',
          'DSH patch 包含动态表达式',
          '配置 patch 中出现可执行 JavaScript 或动态函数表达式。',
          entry.path
        ))
      }
      if (isPatch && /(?:^|\n)\s*(?:sandbox|approval|guard)\s*:\s*(?:false|off|disabled)\b/im.test(entry.text)) {
        context.addFinding(finding(
          'dsh.patch.security-disable',
          'critical',
          'DSH patch 尝试关闭安全控制',
          '配置 patch 修改了 sandbox、approval 或 guard 安全项。',
          entry.path
        ))
      }
      if (isPatch && /(?:include|extends|path)\s*:\s*["']?(?:\.\.|[a-zA-Z]:[\\/]|\\\\|\/)/im.test(entry.text)) {
        context.addFinding(finding(
          'dsh.patch.external-path',
          'critical',
          'DSH patch 引用了包外路径',
          '配置 patch 中的 include、extends 或 path 可能逃逸插件目录。',
          entry.path
        ))
      }
    }
  }
}
