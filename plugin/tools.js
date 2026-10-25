// Tool registration for the secretary / advisor / gm / dm roles.
// Contract defined by plugin/test/tools.test.mjs

import { CoreClient } from './lib/client.js'
import { projectForCwd } from './lib/project.js'

const FULL_TOOLS = [
  'memory_search', 'memory_get', 'memory_recent', 'memory_note', 'memory_brief',
  'taskboard_read', 'taskboard_add', 'taskboard_update', 'taskboard_remove',
  'convention_read', 'convention_add', 'convention_update', 'convention_remove'
]

const READONLY_TOOLS = ['taskboard_read', 'convention_read']

const ROLE_TOOLS = {
  secretary: FULL_TOOLS,
  advisor: ['memory_search', 'memory_brief', 'memory_recent', 'taskboard_read', 'convention_read', 'submit_advice'],
  gm: READONLY_TOOLS,
  dm: READONLY_TOOLS
}

function projectOf(exec) {
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined
  return cwd ? projectForCwd(cwd) : 'default'
}

function query(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value))
  }
  return search.toString()
}

function render(result) {
  if (typeof result === 'string') return result
  return JSON.stringify(result, null, 2)
}

function buildDefinitions(client) {
  const call = (method, path, body) => client.request(method, path, body)

  return {
    memory_search: {
      name: 'memory_search',
      description: 'Search project memory turns.',
      output: { render },
      execute: (args, exec) => call('GET', `/v1/search?${query({ project: projectOf(exec), q: args.query, limit: args.limit || 5 })}`)
    },
    memory_get: {
      name: 'memory_get',
      description: 'Fetch a memory note, summary, or advice by id.',
      output: { render },
      execute: (args) => call('GET', `/v1/get/${encodeURIComponent(args.id)}`)
    },
    memory_recent: {
      name: 'memory_recent',
      description: 'List recent memory turns.',
      output: { render },
      execute: (args, exec) => call('GET', `/v1/recent?${query({ project: projectOf(exec), n: args.n || 10 })}`)
    },
    memory_note: {
      name: 'memory_note',
      description: 'Record a durable memory note.',
      output: { render },
      execute: (args, exec) => call('POST', '/v1/notes', {
        project: projectOf(exec), kind: args.kind || 'note', text: args.text || ''
      })
    },
    memory_brief: {
      name: 'memory_brief',
      description: 'Return the project brief.',
      output: { render },
      execute: (args, exec) => call('GET', `/v1/brief?${query({ project: projectOf(exec) })}`)
    },
    taskboard_read: {
      name: 'taskboard_read',
      description: 'Read the project task board.',
      output: { render },
      execute: (args, exec) => call('GET', `/v1/taskboard?${query({ project: projectOf(exec) })}`)
    },
    taskboard_add: {
      name: 'taskboard_add',
      description: 'Add a task to the board.',
      output: { render },
      execute: (args, exec) => call('POST', '/v1/taskboard', {
        project: projectOf(exec), section: args.section || 'current',
        title: args.title || '', detail: args.detail || '', actor: args.actor || 'agent'
      })
    },
    taskboard_update: {
      name: 'taskboard_update',
      description: 'Update a task status.',
      output: { render },
      execute: (args, exec) => call('POST', '/v1/taskboard', {
        project: projectOf(exec), id: args.id, status: args.status, actor: args.actor || 'agent'
      })
    },
    taskboard_remove: {
      name: 'taskboard_remove',
      description: 'Remove a task from the board.',
      output: { render },
      execute: (args) => call('DELETE', `/v1/taskboard/${encodeURIComponent(args.id)}`)
    },
    convention_read: {
      name: 'convention_read',
      description: 'Read project conventions.',
      output: { render },
      execute: (args, exec) => call('GET', `/v1/conventions?${query({ project: projectOf(exec) })}`)
    },
    convention_add: {
      name: 'convention_add',
      description: 'Add a project convention.',
      output: { render },
      execute: (args, exec) => call('POST', '/v1/conventions', {
        project: projectOf(exec), kind: args.kind || 'avoid', title: args.title || '',
        actor: args.actor || 'agent'
      })
    },
    convention_update: {
      name: 'convention_update',
      description: 'Update a convention status.',
      output: { render },
      execute: (args, exec) => call('POST', '/v1/conventions', {
        project: projectOf(exec), id: args.id, status: args.status
      })
    },
    convention_remove: {
      name: 'convention_remove',
      description: 'Remove a convention.',
      output: { render },
      execute: (args) => call('DELETE', `/v1/conventions/${encodeURIComponent(args.id)}`)
    },
    submit_advice: {
      name: 'submit_advice',
      description: 'Submit an advisor recommendation.',
      output: { render },
      execute: (args, exec) => call('POST', '/v1/advice', {
        project: projectOf(exec), subject: args.subject || '',
        recommendation: args.recommendation || '', evidence: args.evidence || ''
      })
    }
  }
}

export function apply(ctx, options = {}) {
  const { dataDir, coreDir, role = 'secretary' } = options
  const client = new CoreClient({ dataDir, coreDir })
  const definitions = buildDefinitions(client)
  const names = ROLE_TOOLS[role] || ROLE_TOOLS.secretary
  for (const name of names) {
    const definition = definitions[name]
    if (definition) ctx.tools.register(definition)
  }
}

export default { apply }
