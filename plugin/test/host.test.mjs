import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { CoreClient } from '../lib/client.js'
import { pythonCandidates } from '../lib/core.js'
import { apply as applyHost } from '../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE_DIR = resolve(HERE, '..', '..', 'core')

function fakeSnapshot() {
  return {
    session: { id: 'history', cwd: '/tmp/history', agentPreset: 'generic', createdAt: 1 },
    events: [
      { type: 'agent-preset/selected', time: 0, data: { agentPreset: 'secretary' } },
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      {
        type: 'user/message',
        time: 2,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '历史里的窗口列表' }] }
      },
      {
        type: 'assistant/message',
        time: 3,
        data: { message: { content: [{ type: 'text', text: '历史回复：按两级分组。' }] } }
      },
      { type: 'turn/end', time: 4, data: { turn: 1 } }
    ]
  }
}

async function waitFor(fn, timeoutMs = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await fn()
    if (value) return value
    await delay(50)
  }
  throw new Error('waitFor timeout')
}

test('host adapter backfills and records live turns', async (t) => {
  if (pythonCandidates({}).length === 0) {
    t.skip('no Python interpreter found')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'office-host-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, '.dsh'), { recursive: true })
  writeFileSync(join(workspace, '.dsh', 'office.json'), JSON.stringify({ project: 'demo' }), 'utf8')

  let handler
  const disposers = []
  const systemContexts = []
  const fakeCtx = {
    logger: { warn() {}, info() {} },
    on(name, fn) {
      if (name === 'session/event') handler = fn
      return () => {
        handler = undefined
      }
    },
    effect(register) {
      const cleanup = register()
      disposers.push(cleanup)
      return cleanup
    },
    get(name) {
      if (name === 'systemPrompt') {
        return {
          context(definition) {
            systemContexts.push(definition)
            return () => {}
          }
        }
      }
      if (name !== 'sessionQuery') return undefined
      return {
        async listSessions() {
          return [{ header: { id: 'history', cwd: workspace, agentPreset: 'generic' } }]
        },
        async readSession() {
          const snapshot = fakeSnapshot()
          snapshot.session.cwd = workspace
          return snapshot
        }
      }
    }
  }

  try {
    applyHost(fakeCtx, { coreDir: CORE_DIR, dataDir })
    assert.equal(systemContexts.length, 1)
    const contextText = systemContexts[0].text({
      agent: { session: { id: 'brief-test', header: { agentPreset: 'secretary', cwd: workspace } } }
    })
    assert.match(contextText, /项目简报/)
    const client = new CoreClient({ dataDir })
    await waitFor(() => existsSync(join(dataDir, '.run', 'core.json')))
    await waitFor(async () => {
      try {
        await client.ensure()
        return true
      } catch {
        return false
      }
    })
    const params = new URLSearchParams({ project: 'demo', q: '历史 窗口' })
    const history = await waitFor(async () => {
      try {
        const result = await client.request('GET', `/v1/search?${params.toString()}`)
        return result.results?.length ? result : null
      } catch {
        return null
      }
    })
    assert.ok(history.results.length >= 1)

    handler(
      { id: 'live', header: { agentPreset: 'generic', cwd: workspace } },
      { type: 'agent-preset/selected', time: 9, data: { agentPreset: 'secretary' } }
    )
    handler(
      { id: 'live', header: { agentPreset: 'generic', cwd: workspace } },
      { type: 'turn/start', time: 10, data: { turn: 1 } }
    )
    handler(
      { id: 'live', header: { agentPreset: 'generic', cwd: workspace } },
      {
        type: 'user/message',
        time: 11,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '实时窗口列表' }] }
      }
    )
    handler(
      { id: 'live', header: { agentPreset: 'generic', cwd: workspace } },
      {
        type: 'assistant/message',
        time: 12,
        data: { message: { content: [{ type: 'text', text: '实时回复：两级。' }] } }
      }
    )
    handler(
      { id: 'live', header: { agentPreset: 'generic', cwd: workspace } },
      { type: 'turn/end', time: 13, data: { turn: 1 } }
    )
    const liveParams = new URLSearchParams({ project: 'demo', q: '实时 窗口' })
    const live = await waitFor(async () => {
      try {
        const result = await client.request('GET', `/v1/search?${liveParams.toString()}`)
        return result.results?.length ? result : null
      } catch {
        return null
      }
    })
    assert.ok(live.results.length >= 1)
  } finally {
    for (const cleanup of disposers) {
      try {
        cleanup?.()
      } catch {
        /* ignore */
      }
    }
    await delay(500)
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      /* Windows can keep the SQLite file locked for a moment after SIGTERM. */
    }
  }
})
