import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CoreManager, pythonCandidates } from '../lib/core.js'
import { apply as applyTools } from '../tools.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE_DIR = resolve(HERE, '..', '..', 'core')

test('advisor tools are read-only and can submit advice', async (t) => {
  if (pythonCandidates({}).length === 0) {
    t.skip('no Python interpreter found')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'office-advisor-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, '.dsh'), { recursive: true })
  writeFileSync(join(workspace, '.dsh', 'office.json'), JSON.stringify({ project: 'demo' }), 'utf8')
  const manager = new CoreManager({ coreDir: CORE_DIR, dataDir })
  const registered = new Map()
  const fakeCtx = {
    logger: { warn() {}, info() {} },
    tools: {
      register(definition) {
        if (!definition.output || typeof definition.output.render !== 'function') {
          throw new Error(`tool ${definition.name} must declare output.render`)
        }
        registered.set(definition.name, definition)
      }
    }
  }
  try {
    await manager.start()
    await manager.sendRawEvent({
      source: 'dsh-test',
      source_version: 'test',
      event_type: 'turn.completed',
      external_session: 's-advisor',
      external_seq: 1,
      project: 'demo',
      occurred_at: Date.now(),
      payload: { role: 'secretary', user_text: '先做记忆', assistant_text: '好' }
    })
    applyTools(fakeCtx, { dataDir, role: 'advisor' })
    assert.ok(registered.has('memory_search'))
    assert.ok(registered.has('memory_brief'))
    assert.ok(registered.has('taskboard_read'))
    assert.ok(registered.has('convention_read'))
    assert.equal(registered.has('taskboard_update'), false)
    assert.equal(registered.has('taskboard_add'), false)
    assert.equal(registered.has('convention_add'), false)
    assert.ok(registered.has('submit_advice'))
    assert.equal(registered.has('memory_note'), false)
    const exec = { agent: { session: { id: 'advisor-1', header: { cwd: workspace } } } }
    const memo = await registered.get('submit_advice').execute(
      { subject: '先做记忆', recommendation: '先完成 M2/M3', evidence: 'T1' },
      exec
    )
    assert.ok(memo.id.startsWith('A-'))
    const pendingBrief = await registered.get('memory_brief').execute({}, exec)
    assert.equal(pendingBrief.text.includes('顾问建议'), false)
    await manager.request('POST', `/v1/advice/${memo.id}/decision`, { decision: 'accepted' })
    const brief = await registered.get('memory_brief').execute({}, exec)
    assert.equal(brief.text.includes('顾问建议'), false)
    const recent = await registered.get('memory_recent').execute({ n: 5 }, exec)
    assert.ok(recent.results.some((row) => row.user.includes('采纳顾问建议')))
  } finally {
    manager.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('DM tools can read task board but cannot write it', () => {
  const registered = new Map()
  const fakeCtx = {
    logger: { warn() {}, info() {} },
    tools: { register(definition) { registered.set(definition.name, definition) } }
  }
  applyTools(fakeCtx, { role: 'dm' })
  assert.ok(registered.has('taskboard_read'))
  assert.ok(registered.has('convention_read'))
  assert.equal(registered.has('taskboard_update'), false)
  assert.equal(registered.has('taskboard_add'), false)
  assert.equal(registered.has('taskboard_remove'), false)
  assert.equal(registered.has('convention_add'), false)
  assert.equal(registered.has('memory_note'), false)
})

test('GM tools can read task board but cannot write memory/task board', () => {
  const registered = new Map()
  const fakeCtx = {
    logger: { warn() {}, info() {} },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
      }
    }
  }
  applyTools(fakeCtx, { role: 'gm' })
  assert.ok(registered.has('taskboard_read'))
  assert.ok(registered.has('convention_read'))
  assert.equal(registered.has('taskboard_update'), false)
  assert.equal(registered.has('taskboard_add'), false)
  assert.equal(registered.has('taskboard_remove'), false)
  assert.equal(registered.has('convention_add'), false)
  assert.equal(registered.has('memory_note'), false)
})

test('tools register and execute against the core', async (t) => {
  if (pythonCandidates({}).length === 0) {
    t.skip('no Python interpreter found')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'office-tools-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, '.dsh'), { recursive: true })
  writeFileSync(join(workspace, '.dsh', 'office.json'), JSON.stringify({ project: 'demo' }), 'utf8')

  const manager = new CoreManager({ coreDir: CORE_DIR, dataDir })
  const registered = new Map()
  const fakeCtx = {
    logger: { warn() {}, info() {} },
    tools: {
      register(definition) {
        if (!definition.output || typeof definition.output.render !== 'function') {
          throw new Error(`tool ${definition.name} must declare output.render`)
        }
        registered.set(definition.name, definition)
      }
    }
  }
  let toolsApplied = false
  try {
    await manager.start()
    await manager.sendRawEvent({
      source: 'dsh-test',
      source_version: 'test',
      event_type: 'turn.completed',
      external_session: 's-tools',
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
    applyTools(fakeCtx, { dataDir })
    toolsApplied = true
    for (const name of ['memory_search', 'memory_get', 'memory_recent', 'memory_note', 'memory_brief', 'taskboard_read', 'taskboard_add', 'taskboard_update', 'taskboard_remove', 'convention_read', 'convention_add', 'convention_update', 'convention_remove']) {
      assert.ok(registered.has(name), `missing tool ${name}`)
    }
    const exec = { agent: { session: { header: { cwd: workspace } } } }
    const board = await registered.get('taskboard_add').execute(
      { section: 'current', title: '当前', detail: '详情' },
      exec
    )
    assert.equal(board.title, '当前')
    const done = await registered.get('taskboard_update').execute(
      { id: board.id, status: 'done' },
      exec
    )
    assert.equal(done.status, 'done')
    const convention = await registered.get('convention_add').execute(
      { kind: 'avoid', title: '不要自动改 brief' },
      exec
    )
    assert.equal(convention.kind, 'avoid')
    const suspendedConvention = await registered.get('convention_update').execute(
      { id: convention.id, status: 'suspended' },
      exec
    )
    assert.equal(suspendedConvention.status, 'suspended')
    const search = await registered.get('memory_search').execute({ query: '窗口 两级' }, exec)
    assert.ok(search.results.length >= 1)
    const note = await registered.get('memory_note').execute(
      { kind: 'decision', text: '窗口下拉按类别分两级' },
      exec
    )
    assert.ok(note.id.startsWith('N-'))
    const fetched = await registered.get('memory_get').execute({ id: note.id }, exec)
    assert.equal(fetched.kind, 'decision')

    const applied = await manager.request('POST', '/v1/summarize', {
      project: 'demo',
      batch: 20,
      confirm: true
    })
    assert.equal(applied.status, 'ok')
    const summary = await registered.get('memory_get').execute({ id: applied.summary_id }, exec)
    assert.equal(summary.id, applied.summary_id)
  } finally {
    if (toolsApplied) {
      // No lifecycle is owned by the tools half; the manager owns the core.
    }
    manager.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
