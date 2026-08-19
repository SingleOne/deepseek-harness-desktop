export type ScanSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical'

export type ScanRecommendation = 'pass' | 'review' | 'block' | 'incomplete'

export interface ArtifactIdentity {
  source?: 'npm' | 'github' | 'archive'
  name?: string
  version?: string
  commit?: string
  packagePath?: string
  digest?: string
}

export interface ScanArtifactInput {
  filePath?: string
  bytes?: Uint8Array
  identity?: ArtifactIdentity
}

export interface ScanLimits {
  maxArchiveBytes: number
  maxExpandedBytes: number
  maxFiles: number
  maxFileBytes: number
  maxAstFileBytes: number
}

export interface ArtifactEntry {
  path: string
  bytes: Uint8Array
  text?: string
}

export interface ScanLocation {
  line?: number
  column?: number
}

export interface ScanFinding {
  ruleId: string
  severity: ScanSeverity
  category:
    | 'archive'
    | 'manifest'
    | 'dynamic-execution'
    | 'sensitive-data'
    | 'network'
    | 'shell'
    | 'obfuscation'
    | 'dsh-patch'
    | 'dependency'
    | 'supply-chain'
    | 'code-quality'
  title: string
  description: string
  file?: string
  location?: ScanLocation
  evidence?: string
  engine: string
}

export interface ScanCoverage {
  complete: boolean
  scannedFiles: number
  skippedFiles: number
  scannedBytes: number
  astFiles: number
  parseErrors: number
  dependencyCoverage: 'artifact-manifest' | 'locked-tree'
  notes: string[]
}

export interface ScannedDependency {
  name: string
  spec: string
  scope: 'production' | 'optional'
  exactVersion?: string
}

export interface ResolvedDependency {
  name: string
  version: string
}

export interface SupplyChainSignals {
  osv: {
    status: 'not-run' | 'complete' | 'unavailable'
    queriedPackages: number
    vulnerabilityCount: number
  }
  registrySignature: {
    status: 'not-applicable' | 'verified' | 'missing' | 'invalid' | 'unavailable'
    keyId?: string
  }
  provenance: {
    status: 'not-applicable' | 'present-unverified' | 'absent'
    url?: string
  }
  releaseAge: {
    status: 'not-applicable' | 'mature' | 'too-new' | 'unknown'
    minimumHours: number
    publishedAt?: string
    ageHours?: number
  }
}

export interface RuleContext {
  entries: ArtifactEntry[]
  manifest?: Record<string, unknown>
  addFinding(finding: ScanFinding): void
}

export interface RulePack {
  id: string
  version: string
  scan(context: RuleContext): void | Promise<void>
}

export interface ScanOptions {
  limits?: Partial<ScanLimits>
  rulePacks?: RulePack[]
}

export interface ScanReport {
  schemaVersion: 1
  engine: {
    id: '@dsh-desktop/security-scanner'
    version: string
    rulePacks: Array<{ id: string; version: string }>
  }
  artifact: ArtifactIdentity
  recommendation: ScanRecommendation
  coverage: ScanCoverage
  dependencies: ScannedDependency[]
  resolvedDependencies: ResolvedDependency[]
  supplyChain: SupplyChainSignals
  findings: ScanFinding[]
  scannedAt: string
  durationMs: number
}
