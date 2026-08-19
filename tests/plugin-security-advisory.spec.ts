import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ScanReport } from '../packages/security-scanner/src'
import {
  PluginSecurityAdvisoryService,
  type NpmSupplyChainMetadata
} from '../src/main/plugin-security-advisory-service'

function report(): ScanReport {
  return {
    schemaVersion: 1,
    engine: {
      id: '@dsh-desktop/security-scanner',
      version: '0.3.0',
      rulePacks: []
    },
    artifact: { source: 'npm', name: 'safe-plugin', version: '1.0.0' },
    recommendation: 'pass',
    coverage: {
      complete: true,
      scannedFiles: 2,
      skippedFiles: 0,
      scannedBytes: 100,
      astFiles: 1,
      parseErrors: 0,
      dependencyCoverage: 'artifact-manifest',
      notes: []
    },
    dependencies: [
      { name: 'exact-dependency', spec: '2.0.0', exactVersion: '2.0.0', scope: 'production' },
      { name: 'range-dependency', spec: '^3.0.0', scope: 'production' }
    ],
    resolvedDependencies: [],
    supplyChain: {
      osv: { status: 'not-run', queriedPackages: 0, vulnerabilityCount: 0 },
      registrySignature: { status: 'not-applicable' },
      provenance: { status: 'not-applicable' },
      releaseAge: { status: 'not-applicable', minimumHours: 24 }
    },
    findings: [],
    scannedAt: '2026-08-19T00:00:00.000Z',
    durationMs: 5
  }
}

function metadata(signatures: NpmSupplyChainMetadata['signatures']): NpmSupplyChainMetadata {
  return {
    name: 'safe-plugin',
    version: '1.0.0',
    integrity: 'sha512-test-integrity',
    signatures,
    provenanceUrl: 'https://registry.npmjs.org/-/npm/v1/attestations/safe-plugin@1.0.0',
    publishedAt: '2026-08-17T00:00:00.000Z'
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('plugin supply-chain advisory service', () => {
  it('verifies npm registry signatures and queries only exact dependency versions', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const keyId = 'SHA256:test-key'
    const packageMetadata = metadata([{
      keyId,
      signature: sign(
        'sha256',
        Buffer.from('safe-plugin@1.0.0:sha512-test-integrity'),
        privateKey
      ).toString('base64')
    }])
    let osvBody: { queries: unknown[] } | undefined
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/-/npm/v1/keys')) {
        return json({ keys: [{ keyid: keyId, key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] })
      }
      if (url.endsWith('/v1/querybatch')) {
        osvBody = JSON.parse(String(init?.body)) as { queries: unknown[] }
        return json({ results: [{}, {}] })
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch

    const result = await new PluginSecurityAdvisoryService(
      fetchImpl,
      () => Date.parse('2026-08-19T00:00:00.000Z')
    ).enrich({ report: report(), source: 'npm', npm: packageMetadata })

    expect(result.recommendation).toBe('pass')
    expect(result.supplyChain.registrySignature).toEqual({ status: 'verified', keyId })
    expect(result.supplyChain.osv).toEqual({
      status: 'complete',
      queriedPackages: 2,
      vulnerabilityCount: 0
    })
    expect(osvBody?.queries).toHaveLength(2)
    expect(JSON.stringify(osvBody)).not.toContain('range-dependency')
  })

  it('adds review findings for OSV matches, missing signatures and a fresh release', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/v1/querybatch')) {
        return json({ results: [{ vulns: [{ id: 'GHSA-test-1234' }] }, {}] })
      }
      if (url.endsWith('/v1/vulns/GHSA-test-1234')) {
        return json({ id: 'GHSA-test-1234', summary: '测试依赖漏洞' })
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch
    const packageMetadata = {
      ...metadata([]),
      publishedAt: '2026-08-18T18:00:00.000Z'
    }

    const result = await new PluginSecurityAdvisoryService(
      fetchImpl,
      () => Date.parse('2026-08-19T00:00:00.000Z')
    ).enrich({ report: report(), source: 'npm', npm: packageMetadata })

    expect(result.recommendation).toBe('review')
    expect(result.supplyChain.releaseAge.status).toBe('too-new')
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'osv.GHSA-test-1234', severity: 'high' }),
      expect.objectContaining({ ruleId: 'supply-chain.registry-signature-missing' }),
      expect.objectContaining({ ruleId: 'supply-chain.release-too-new' })
    ]))
  })

  it('blocks an npm artifact whose registry signature is invalid', async () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const keyId = 'SHA256:test-key'
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/-/npm/v1/keys')) {
        return json({ keys: [{ keyid: keyId, key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }] })
      }
      if (url.endsWith('/v1/querybatch')) return json({ results: [{}, {}] })
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch

    const result = await new PluginSecurityAdvisoryService(fetchImpl).enrich({
      report: report(),
      source: 'npm',
      npm: metadata([{ keyId, signature: Buffer.from('invalid').toString('base64') }])
    })

    expect(result.recommendation).toBe('block')
    expect(result.supplyChain.registrySignature.status).toBe('invalid')
    expect(result.findings[0]).toEqual(expect.objectContaining({
      ruleId: 'supply-chain.registry-signature-invalid',
      severity: 'critical'
    }))
  })

  it('requires review instead of blocking when a historical signing key is unavailable', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/-/npm/v1/keys')) return json({ keys: [] })
      if (url.endsWith('/v1/querybatch')) return json({ results: [{}, {}] })
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch

    const result = await new PluginSecurityAdvisoryService(fetchImpl).enrich({
      report: report(),
      source: 'npm',
      npm: metadata([{ keyId: 'SHA256:retired-key', signature: 'dGVzdA==' }])
    })

    expect(result.recommendation).toBe('review')
    expect(result.supplyChain.registrySignature.status).toBe('unavailable')
    expect(result.findings).toContainEqual(expect.objectContaining({
      ruleId: 'supply-chain.registry-signature-key-unavailable',
      severity: 'medium'
    }))
  })
})
