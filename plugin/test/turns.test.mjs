import assert from 'node:assert/strict'
import test from 'node:test'

import { TurnBuffer, eventsToEnvelopes } from '../lib/turns.js'

const header = { id: 's1', cwd: 'D:/work/demo', agentPreset: 'secretary' }

test('turn buffer keeps user/assistant text and drops reasoning/time-context', () => {
  const buffer = new TurnBuffer({ sessionId: 's1', cwd: header.cwd, preset: 'secretary', project: 'demo' })
  assert.equal(buffer.consume({ type: 'turn/start', time: 1000, data: { turn: 1 } }), null)
  buffer.consume({
    type: 'user/message',
    time: 1001,
    data: { source: { kind: 'time-context' }, content: [{ type: 'text', text: '时间：...' }] }
  })
  buffer.consume({
    type: 'user/message',
    time: 1002,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '窗口列表怎么改？' }] }
  })
  buffer.consume({
    type: 'assistant/message',
    time: 1003,
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'secret thinking' },
          { type: 'text', text: '改成两级：膜系、沉积、仿真。' }
        ]
      }
    }
  })
  const envelope = buffer.consume({ type: 'turn/end', time: 1004, data: { turn: 1 } })
  assert.ok(envelope)
  assert.equal(envelope.event_type, 'turn.completed')
  assert.equal(envelope.external_seq, 1)
  assert.equal(envelope.payload.user_text, '窗口列表怎么改？')
  assert.equal(envelope.payload.assistant_text, '改成两级：膜系、沉积、仿真。')
  assert.ok(!envelope.payload.assistant_text.includes('secret thinking'))
})

test('flush emits an interrupted turn', () => {
  const buffer = new TurnBuffer({ sessionId: 's1', cwd: header.cwd, preset: 'secretary', project: 'demo' })
  buffer.consume({ type: 'turn/start', time: 1, data: { turn: 2 } })
  buffer.consume({ type: 'user/message', time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } })
  const envelope = buffer.flush(3)
  assert.equal(envelope.payload.user_text, 'hello')
})

test('eventsToEnvelopes folds a full snapshot', () => {
  const snapshot = {
    session: header,
    events: [
      { type: 'turn/start', time: 1, data: { turn: 1 } },
      { type: 'user/message', time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant/message', time: 3, data: { message: { content: [{ type: 'text', text: 'b' }] } } },
      { type: 'turn/end', time: 4, data: { turn: 1 } }
    ]
  }
  const envelopes = eventsToEnvelopes(snapshot, 'demo')
  assert.equal(envelopes.length, 1)
  assert.equal(envelopes[0].payload.user_text, 'a')
  assert.equal(envelopes[0].payload.assistant_text, 'b')
})

test('target preset set includes GM but excludes DM', () => {
  const events = [
    { type: 'turn/start', time: 1, data: { turn: 1 } },
    { type: 'user/message', time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'brief' }] } },
    { type: 'assistant/message', time: 3, data: { message: { content: [{ type: 'text', text: 'report' }] } } },
    { type: 'turn/end', time: 4, data: { turn: 1 } }
  ]
  const gm = eventsToEnvelopes(
    { session: { ...header, agentPreset: 'gm' }, events },
    'demo',
    'dsh',
    { targetPresets: ['secretary', 'gm'] }
  )
  assert.equal(gm.length, 1)
  assert.equal(gm[0].payload.role, 'gm')
  const dm = eventsToEnvelopes(
    { session: { ...header, agentPreset: 'dm' }, events },
    'demo',
    'dsh',
    { targetPresets: ['secretary', 'gm'] }
  )
  assert.equal(dm.length, 0)
})

test('preset switch labels the turn with the selected preset', () => {
  const events = [
    { type: 'agent-preset/selected', time: 1, data: { agentPreset: 'secretary' } },
    { type: 'turn/start', time: 2, data: { turn: 1 } },
    { type: 'user/message', time: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant/message', time: 4, data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
    { type: 'turn/end', time: 5, data: { turn: 1 } }
  ]
  const envelopes = eventsToEnvelopes(
    { session: { ...header, agentPreset: 'generic' }, events },
    'demo',
    'dsh',
    { targetPresets: ['secretary', 'gm'] }
  )
  assert.equal(envelopes.length, 1)
  assert.equal(envelopes[0].payload.preset, 'secretary')
  assert.equal(envelopes[0].payload.role, 'secretary')
})
