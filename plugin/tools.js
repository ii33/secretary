// Tool registration for the secretary / advisor / gm / dm roles.
// Contract defined by plugin/test/tools.test.mjs

import { AsyncLocalStorage } from 'node:async_hooks'
import { CoreClient } from './lib/client.js'
import { projectForCwd } from './lib/project.js'

const FULL_TOOLS = [
  'memory_search', 'memory_get', 'memory_recent', 'memory_note', 'memory_brief',
  'taskboard_read', 'taskboard_add', 'taskboard_update', 'taskboard_remove',
  'convention_read', 'convention_add', 'convention_update', 'convention_remove'
]

const READONLY_TOOLS = ['taskboard_read', 'convention_read']

const ROLE_TOOLS = {
  es: FULL_TOOLS,
  secretary: FULL_TOOLS,
  advisor: ['memory_search', 'memory_brief', 'memory_recent', 'taskboard_read', 'convention_read', 'submit_advice'],
  gm: READONLY_TOOLS,
  dm: READONLY_TOOLS
}

function projectOf(exec) {
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined
  const project = cwd ? projectForCwd(cwd) : null
  if (!project) throw new Error('当前工作区尚未纳入秘书办公室管理，请先在插件中选择项目并点击纳入管理')
  return project
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

const execution = new AsyncLocalStorage()
function buildDefinitions(client) {
  const call = (method, path, body) => {
    const exec = execution.getStore()
    const session = exec?.agent?.session?.id
    if (method === 'GET' || method === 'DELETE') path += (path.includes('?') ? '&' : '?') + query({ session_id: session })
    else body = { ...body, session_id: session }
    return client.request(method, path, body)
  }

  return {
    office_members: {name:'office_members',description:'List this project architecture and member IDs.',output:{render},execute:(args,exec)=>call('GET','/v1/organization?'+query({project:projectOf(exec)}))},
    office_message: {name:'office_message',description:'Leave a message for a member in this project. recipient is a member ID.',output:{render},execute:(args,exec)=>call('POST','/v1/member-messages',{project:projectOf(exec),recipient:args.recipient,text:args.text})},
    office_inbox: {name:'office_inbox',description:'Read and mark your unread project messages. Defaults to unread only.',output:{render},execute:(args,exec)=>call('POST','/v1/member-messages/read',{project:projectOf(exec)})},
    office_round: {name:'office_round',description:'Main member: release a round with assignments mapping child member IDs to tasks. Members with unread messages also activate.',output:{render},execute:(args,exec)=>call('POST','/v1/rounds',{project:projectOf(exec),assignments:args.assignments||{}})},
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
      execute: (args, exec) => call('GET', `/v1/get/${encodeURIComponent(args.id)}?${query({ project: projectOf(exec) })}`)
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
      execute: (args, exec) => call('DELETE', `/v1/taskboard/${encodeURIComponent(args.id)}?${query({ project: projectOf(exec) })}`)
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
      execute: (args, exec) => call('DELETE', `/v1/conventions/${encodeURIComponent(args.id)}?${query({ project: projectOf(exec) })}`)
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

export const inject = ['tools']
export const name = 'office-tools'
export function apply(ctx, options = {}) {
  const { dataDir, coreDir, role = 'es' } = options
  const client = new CoreClient({ dataDir, coreDir })
  const definitions = buildDefinitions(client)
  const names = [...(ROLE_TOOLS[role] || ROLE_TOOLS.secretary), 'office_members', 'office_message', 'office_inbox', 'office_round']
  for (const name of names) {
    const definition = definitions[name]
    const fields = {query:'string',limit:'integer',id:'string',n:'integer',kind:'string',text:'string',section:'string',title:'string',detail:'string',status:'string',actor:'string',subject:'string',recommendation:'string',evidence:'string',recipient:'string'}
    const parameters = Object.fromEntries(Object.entries(fields).map(([key,type])=>[key,{type,description:key}]))
    parameters.assignments = {type:'object',additionalProperties:true,properties:{},description:'Member ID to task text'}
    if (definition) ctx.tools.register({ ...definition, parameters:{type:'object',properties:parameters,additionalProperties:false}, output:{schema:{},render:(_args,value)=>[{type:'text',text:render(value)}]}, execute: (args, exec) => execution.run(exec, async () => { if (name.startsWith("office_")) { const cfg = await client.request("GET", "/v1/organization?" + query({project:projectOf(exec)})); if (cfg.mode !== "flat") throw new Error("Member messaging and rounds require flat architecture"); } return definition.execute(args, exec) }) })
  }
}

export default { apply, inject, name }
