import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CoreManager, pythonCandidates } from '../lib/core.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE_DIR = resolve(HERE, '..', '..', 'core')

test('core manager starts Python core and records a turn', async (t) => {
  if (pythonCandidates({}).length === 0) {
    t.skip('no Python interpreter found')
    return
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'office-core-'))
  const manager = new CoreManager({ coreDir: CORE_DIR, dataDir })
  try {
    await manager.start()
    const result = await manager.sendRawEvent({
      source: 'dsh-test',
      source_version: 'test',
      event_type: 'turn.completed',
      external_session: 's-test',
      external_seq: 1,
      project: 'demo',
      occurred_at: Date.now(),
      payload: {
        role: 'secretary',
        preset: 'secretary',
        user_text: '窗口列表改为两级',
        assistant_text: '收到，按膜系、沉积、仿真分两级。'
      }
    })
    assert.equal(result.status, 'ok')
    const params = new URLSearchParams({ project: 'demo', q: '窗口 两级' })
    const search = await manager.request('GET', `/v1/search?${params.toString()}`)
    assert.ok(Array.isArray(search.results))
    assert.ok(search.results.length >= 1)
  } finally {
    manager.dispose()
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      /* Windows can keep the SQLite file locked briefly after SIGTERM. */
    }
  }
})
