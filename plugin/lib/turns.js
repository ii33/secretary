// Turn folding: convert DSH session events into "turn.completed" envelopes.
// Contract defined by plugin/test/turns.test.mjs

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

function roleForPreset(preset) {
  // The secretary / gm / dm presets map 1:1 to roles. Unknown presets keep
  // their name so downstream code can still tell them apart.
  return preset || 'secretary'
}

export class TurnBuffer {
  constructor({ sessionId, cwd, preset, project, source = 'dsh', sourceVersion = 'dsh', cold = false }) {
    this.sessionId = sessionId
    this.cwd = cwd
    this.preset = preset
    this.project = project
    this.source = source
    this.sourceVersion = sourceVersion
    this.cold = cold
    this.current = null
  }

  consume(event) {
    if (!event || typeof event.type !== 'string') return null
    switch (event.type) {
      case 'agent-preset/selected': {
        const next = event.data && event.data.agentPreset
        if (next) this.preset = next
        return null
      }
      case 'turn/start': {
        this.current = {
          turn: event.data && event.data.turn,
          userText: '',
          assistantText: ''
        }
        return null
      }
      case 'user/message': {
        if (!this.current) return null
        const source = event.data && event.data.source
        // Time-context injections are bookkeeping, not user intent.
        if (source && source.kind === 'time-context') return null
        if (source && source.kind && source.kind !== 'user') return null
        const text = textOf(event.data && event.data.content)
        if (text) this.current.userText = this.current.userText
          ? `${this.current.userText}\n${text}`
          : text
        return null
      }
      case 'assistant/message': {
        if (!this.current) return null
        const message = event.data && event.data.message
        const text = textOf(message && message.content)
        if (text) this.current.assistantText = this.current.assistantText
          ? `${this.current.assistantText}\n${text}`
          : text
        return null
      }
      case 'turn/end': {
        if (!this.current) return null
        return this.finish(event.time, false)
      }
      default:
        return null
    }
  }

  flush(time) {
    if (!this.current) return null
    return this.finish(time, true)
  }

  finish(time, interrupted) {
    const turn = this.current
    this.current = null
    const preset = this.preset
    const envelope = {
      source: this.source,
      source_version: this.sourceVersion,
      event_type: 'turn.completed',
      external_session: this.sessionId,
      external_seq: turn.turn,
      project: this.project,
      occurred_at: time,
      payload: {
        role: roleForPreset(preset),
        preset,
        user_text: turn.userText,
        assistant_text: turn.assistantText
      }
    }
    if (this.cold) envelope.cold = true
    if (interrupted) envelope.payload.interrupted = true
    return envelope
  }
}

export function eventsToEnvelopes(snapshot, project, source = 'dsh', options = {}) {
  if (!snapshot || !snapshot.session || !Array.isArray(snapshot.events)) return []
  const session = snapshot.session
  const targetPresets = Array.isArray(options.targetPresets) ? options.targetPresets : null
  const buffer = new TurnBuffer({
    sessionId: session.id,
    cwd: session.cwd,
    preset: session.agentPreset,
    project,
    source,
    sourceVersion: session.sourceVersion || source,
    cold: options.cold === true
  })
  const envelopes = []
  for (const event of snapshot.events) {
    const envelope = buffer.consume(event)
    if (envelope) envelopes.push(envelope)
  }
  const tail = buffer.flush(session.updatedAt || Date.now())
  if (tail) envelopes.push(tail)
  if (!targetPresets) return envelopes
  return envelopes.filter((env) => targetPresets.includes(env.payload.preset))
}
