import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { registerConsoleRoutes } from '../lib/console-proxy.js'
import { CoreManager, pythonCandidates } from '../lib/core.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE_DIR = resolve(HERE, '..', '..', 'core')

function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = url
  return req
}

function response() {
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const res = {
    status: undefined,
    body: undefined,
    writeHead(status) { this.status = status },
    end(text) {
      this.body = text ? JSON.parse(text) : undefined
      resolveDone()
    }
  }
  return { res, done }
}

test('console proxy maps whitelisted routes and confirms summarize', async (t) => {
  if (pythonCandidates({}).length === 0) {
    t.skip('no Python interpreter found')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'office-console-'))
  const dataDir = join(root, 'data')
  const manager = new CoreManager({ coreDir: CORE_DIR, dataDir })
  let route
  const fakeWebServer = {
    register(definition) {
      route = definition
      return () => {}
    }
  }
  try {
    await manager.start()
    await manager.sendRawEvent({
      source: 'test',
      source_version: 'test',
      event_type: 'turn.completed',
      external_session: 's-console',
      external_seq: 1,
      project: 'demo',
      occurred_at: Date.now(),
      payload: {
        role: 'secretary',
        user_text: '决定窗口列表分两级。',
        assistant_text: '收到，按两级分组。'
      }
    })
    const dispose = registerConsoleRoutes(fakeWebServer, manager, {
      org: async () => ({ roots: [], nodes: [] }),
      presets: async () => ({ presets: [] }),
      presetDocument: async (id) => ({ agentPreset: id, content: 'plugins: []' }),
      importPreset: async () => ({ path: '/tmp/x.yml' })
    })
    assert.equal(route.path, '/office-console/api')

    const projects = response()
    await route.handler(request('GET', '/office-console/api/projects'), projects.res)
    await projects.done
    assert.equal(projects.res.status, 200)
    assert.ok(projects.res.body.projects.some((item) => item.id === 'demo'))

    const org = response()
    await route.handler(request('GET', '/office-console/api/org?project=demo'), org.res)
    await org.done
    assert.equal(org.res.status, 200)
    assert.deepEqual(org.res.body.roots, [])
    const preset = response()
    await route.handler(request('GET', '/office-console/api/presets/gm'), preset.res)
    await preset.done
    assert.equal(preset.res.body.agentPreset, 'gm')

    const preview = response()
    await route.handler(
      request('GET', '/office-console/api/summarize/preview?project=demo&batch=20'),
      preview.res
    )
    await preview.done
    assert.equal(preview.res.body.status, 'preview')

    const applied = response()
    await route.handler(
      request('POST', '/office-console/api/summarize', { project: 'demo', batch: 20, confirm: true }),
      applied.res
    )
    await applied.done
    assert.equal(applied.res.body.status, 'ok')

    const board = response()
    await route.handler(
      request('GET', '/office-console/api/taskboard?project=demo'),
      board.res
    )
    await board.done
    assert.equal(board.res.status, 200)
    const addedBoard = response()
    await route.handler(
      request('POST', '/office-console/api/taskboard', {
        project: 'demo',
        section: 'current',
        title: '当前任务',
        detail: '详情',
        actor: 'user'
      }),
      addedBoard.res
    )
    await addedBoard.done
    assert.equal(addedBoard.res.body.title, '当前任务')
    const doneBoard = response()
    await route.handler(
      request('POST', '/office-console/api/taskboard', {
        project: 'demo',
        id: addedBoard.res.body.id,
        status: 'done'
      }),
      doneBoard.res
    )
    await doneBoard.done
    assert.equal(doneBoard.res.body.status, 'done')

    const addedConvention = response()
    await route.handler(
      request('POST', '/office-console/api/conventions', {
        project: 'demo',
        kind: 'avoid',
        title: '不要自动改 brief',
        actor: 'user'
      }),
      addedConvention.res
    )
    await addedConvention.done
    assert.equal(addedConvention.res.body.kind, 'avoid')
    const conventions = response()
    await route.handler(
      request('GET', '/office-console/api/conventions?project=demo'),
      conventions.res
    )
    await conventions.done
    assert.equal(conventions.res.body.items.length, 1)

    const archived = response()
    await route.handler(
      request('POST', '/office-console/api/archive', { project: 'demo', now: true }),
      archived.res
    )
    await archived.done
    assert.equal(archived.res.body.status, 'ok')
    assert.equal(archived.res.body.archived, 1)

    const memo = response()
    await route.handler(
      request('POST', '/office-console/api/advice', {
        project: 'demo',
        subject: '测试建议',
        recommendation: '建议先做测试'
      }),
      memo.res
    )
    await memo.done
    assert.equal(memo.res.body.subject, '测试建议')

    const delivered = response()
    await route.handler(
      request('POST', `/office-console/api/advice/${memo.res.body.id}/delivered`, {}),
      delivered.res
    )
    await delivered.done
    assert.equal(delivered.res.status, 200)
    assert.equal(delivered.res.body.status, 'delivered')

    const decided = response()
    await route.handler(
      request('POST', `/office-console/api/advice/${memo.res.body.id}/decision`, {
        decision: 'accepted'
      }),
      decided.res
    )
    await decided.done
    assert.equal(decided.res.status, 200)
    assert.equal(decided.res.body.status, 'accepted')

    const unknown = response()
    await route.handler(request('GET', '/office-console/api/raw-events'), unknown.res)
    await unknown.done
    assert.equal(unknown.res.status, 404)

    dispose()
  } finally {
    manager.dispose()
    await new Promise((resolve) => setTimeout(resolve, 300))
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      /* Windows may keep the SQLite file locked briefly after SIGTERM. */
    }
  }
})
