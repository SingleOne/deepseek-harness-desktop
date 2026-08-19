import { scanArtifact, dshRulePack } from '../../packages/security-scanner/src'
import type { ArtifactIdentity } from '../../packages/security-scanner/src'

interface ScanWorkerRequest {
  type: 'scan'
  filePath: string
  identity: ArtifactIdentity
}

const parentPort = process.parentPort
if (!parentPort) throw new Error('安全扫描 worker 缺少父进程消息端口')

parentPort.on('message', (event) => {
  const request = event.data as ScanWorkerRequest
  if (request?.type !== 'scan' || typeof request.filePath !== 'string') {
    parentPort.postMessage({ type: 'error', error: '无效的扫描请求' })
    return
  }
  void scanArtifact(
    { filePath: request.filePath, identity: request.identity },
    { rulePacks: [dshRulePack] }
  ).then(
    (report) => parentPort.postMessage({ type: 'result', report }),
    (error: unknown) => parentPort.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
  )
})
