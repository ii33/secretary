import { flatMembers } from './lib/flat-members.js'
// DSH host adapter: wire session events into the secretary core.
// Contract defined by plugin/test/host.test.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'

import { registerConsoleRoutes } from './lib/console-proxy.js'
import { CoreManager } from './lib/core.js'
import { projectForCwd, managedProjects, managedProjectsPath } from './lib/project.js'
import { TurnBuffer, eventsToEnvelopes } from './lib/turns.js'

const BUILTIN_PRESETS = JSON.parse(readFileSync(new URL('./builtin-presets.json', import.meta.url), 'utf8'))

const TARGET_PRESETS = ['es', 'secretary', 'gm']

/**
 * DSH 把「已归档会话」记在 ~/.dsh/storages/workspace.json 的
 * global.archivedSessionIds（不在 session 文件里）。这里读出来用于过滤。
 */
function readArchivedSessionIds() {
  const homes = []
  if (process.env.DSH_HOME) homes.push(process.env.DSH_HOME)
  homes.push(join(homedir(), '.dsh'))
  const ids = new Set()
  for (const home of homes) {
    for (const file of [
      join(home, 'storages', 'workspace.json'),
      join(home, 'profiles', 'desktop', 'storages', 'workspace.json'),
    ]) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        const list = data && data.global && data.global.archivedSessionIds
        if (Array.isArray(list)) {
          for (const item of list) ids.add(item)
        }
      } catch {
        /* 尝试下一个候选路径 */
      }
    }
  }
  return ids
}

/** 归档 id 前缀不敏感匹配（`session-xxx` 与 `xxx` 视为同一个）。 */
function isArchivedId(archivedIds, id) {
  if (!id) return false
  if (archivedIds.has(id)) return true
  const bare = String(id).replace(/^session-/, '')
  return archivedIds.has(bare) || archivedIds.has(`session-${bare}`)
}

/**
 * 会话的收录方式（用「深度 + 该轮实际 preset」判断，避免会话中途切换预设时误判）：
 *   - 'hot'   ES↔用户（顶层 secretary）→ 热记忆
 *   - 'cold'  ES↔GM（delegationDepth=1）→ 直接进冷备
 *   - 'skip'  顾问 / 普通会话 / GM↔DM↔worker（depth>=2）→ 不收录
 */
function captureMode(depth, preset) {
  const known = preset || ''
  if (depth === undefined || depth === null) {
    // 没有深度信息：按预设兜底
    if ((known === 'es' || known === 'secretary')) return 'hot'
    if (known === 'gm') return 'cold'
    return 'skip'
  }
  if (depth <= 0) {
    // 顶层：只有 ES(secretary) 进热记忆；顾问、普通会话不收录
    return (known === 'es' || known === 'secretary') ? 'hot' : 'skip'
  }
  if (depth === 1) return 'cold'
  return 'skip'
}

// 项目简报缓存：project -> { text, at }。
// systemPrompt 的 text() 是同步函数，不能在里面 await，所以采用
// "缓存 + 后台刷新（stale-while-revalidate）"：有缓存先返回（哪怕略旧），
// 同时异步刷新；没有缓存时返回含「项目简报」标题的兜底文案。
const BRIEF_TTL_MS = 60_000
const briefCache = new Map()

function fallbackBrief(project) {
  return [
    '## 项目简报',
    '',
    `项目：${project}`,
    '记忆由 secretary-core 维护；回答前可参考项目历史与约定。'
  ].join('\n')
}

function briefFor(cwd) {
  const project = cwd ? projectForCwd(cwd) : 'default'
  const cached = briefCache.get(project)
  if (cached) return cached.text
  return fallbackBrief(project)
}

/** 后台刷新某个项目的简报；失败静默（下次再试）。 */
const refreshing = new Set()
async function refreshBrief(manager, project) {
  // 核心尚未就绪时直接跳过，避免触发重复 spawn。
  if (!project || !manager.baseUrl) return
  // 同一项目已有刷新在飞时不再叠加。
  if (refreshing.has(project)) return
  refreshing.add(project)
  try {
    const res = await manager.request('GET', `/v1/brief?project=${encodeURIComponent(project)}`)
    if (res && typeof res.text === 'string' && res.text.trim()) {
      briefCache.set(project, { text: res.text, at: Date.now() })
    }
  } catch {
    /* core 未就绪或项目无数据：保留旧缓存 */
  } finally {
    refreshing.delete(project)
  }
}

/** 刷新全部已知项目 + 指定项目的简报。 */
async function refreshBriefs(manager, extraProject) {
  const projects = new Set()
  if (extraProject) projects.add(extraProject)
  try {
    const res = await manager.request('GET', '/v1/projects')
    for (const row of res?.projects || []) {
      if (row && row.id) projects.add(String(row.id))
    }
  } catch {
    /* ignore */
  }
  await Promise.all([...projects].map((project) => refreshBrief(manager, project)))
}

function briefIsStale(project) {
  const cached = briefCache.get(project)
  return !cached || Date.now() - cached.at > BRIEF_TTL_MS
}

/** 从会话快照里取最后的 session/title。 */
function pickSessionTitle(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.events)) return ''
  let title = ''
  for (const event of snapshot.events) {
    if (event && event.type === 'session/title') {
      title = (event.data && (event.data.title || event.data.text)) || title
    }
  }
  return title
}

/** 会话是否有实际内容（有标题，或至少一条用户消息）；空会话不入树。 */
function hasSessionContent(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.events)) return false
  for (const event of snapshot.events) {
    if (!event) continue
    if (event.type === 'session/title') return true
    if (event.type === 'user/message') {
      const kind = event.data && event.data.source && event.data.source.kind
      if (!kind || kind === 'user') return true
    }
  }
  return false
}

/**
 * 用 host 的 sessionQuery 构建「ES/顾问 → GM → DM → worker」会话树。
 * 返回根节点数组（每个节点含 id/title/preset/parentId/children）；无法构建时返回 null。
 */
async function buildOrgTree(ctx, project) {
  const sessionQuery = ctx.get('sessionQuery')
  if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') throw new Error('DSH sessionQuery 服务尚未就绪，请稍后刷新')
  let sessions = []
  try {
    sessions = await sessionQuery.listSessions()
  } catch (error) {
    throw new Error('读取 DSH 会话列表失败：' + String(error))
  }
  const archivedIds = readArchivedSessionIds()
  const flat = []
  for (const entry of sessions || []) {
    const header = (entry && entry.header) || entry || {}
    const id = header.id
    if (!id) continue
    // Filter the corpus by header before replaying any event log.
    const headerCwd = header.cwd || header.identity?.cwd || ''
    if (project && (!headerCwd || projectForCwd(headerCwd) !== project)) continue
    if (isArchivedId(archivedIds,id) || header.archived === true || header.isArchived === true || header.archivedAt || header.state === 'archived') continue
    // Organization uses immutable headers; never replay full conversation logs here.
    let snapshot = {session:header,events:[]}
    if (typeof sessionQuery.readTitle === 'function') {
      try {
        const title = await sessionQuery.readTitle(id)
        if (title?.title) snapshot.events.push({type:'session/title',data:{title:title.title}})
      } catch { /* A title failure does not hide the session. */ }
    }
    const session = (snapshot && snapshot.session) || {}
    // cwd / parent / depth 都在 session 首行里，字段名兼容多种写法。
    const cwd =
      session.cwd || (session.identity && session.identity.cwd) ||
      header.cwd || (header.identity && header.identity.cwd) || ''
    const parent =
      session.parentSession || session.parentSessionId ||
      header.parentSession || header.parentSessionId || ''
    const depthRaw =
      typeof session.delegationDepth === 'number' ? session.delegationDepth
      : typeof header.delegationDepth === 'number' ? header.delegationDepth
      : undefined
    const depth = depthRaw === undefined ? (parent ? 1 : 0) : depthRaw
    const preset = session.agentPreset || header.agentPreset || ''
    const title = header.title || session.title || pickSessionTitle(snapshot) || ''
    const archived =
      isArchivedId(archivedIds, id) ||
      header.archived === true || session.archived === true ||
      header.isArchived === true || session.isArchived === true ||
      Boolean(header.archivedAt) || Boolean(session.archivedAt) ||
      header.state === 'archived' || session.state === 'archived'
    if (archived) continue
    // 只保留当前项目；拿不到 cwd 的无法判定项目，跳过，避免串项目。
    if (project && !cwd) continue
    if (project && projectForCwd(cwd) !== project) continue
    // 空会话（没有标题、也没有用户消息）不入树，避免一堆空白项。
    // Newly created sessions are organization members even before the first message.
    flat.push({ id, title, preset, parent, depth, cwd })
  }
  if (flat.length === 0) return []
  const byId = new Map(flat.map((node) => [node.id, { ...node, children: [] }]))
  const roots = []
  for (const node of byId.values()) {
    if (node.parent && byId.has(node.parent)) {
      byId.get(node.parent).children.push(node)
    } else {
      roots.push(node)
    }
  }
  // 顶层排序：ES(secretary) → 顾问(advisor) → 普通会话
  const rank = (preset) => ((preset === 'es' || preset === 'secretary') ? 0 : preset === 'advisor' ? 1 : 2)
  roots.sort((a, b) => rank(a.preset) - rank(b.preset))
  for (const node of byId.values()) {
    if (node.children.length > 1) {
      node.children.sort((a, b) => (a.depth || 0) - (b.depth || 0))
    }
  }
  return roots
}

/** 把人员架构结果写一份快照，便于排查「归档会话为何仍在」这类问题。 */
function dumpOrgDebug(project, tree) {
  try {
    const ids = readArchivedSessionIds()
    const flatten = (node) => ({
      id: node.id,
      title: node.title,
      preset: node.preset,
      parent: node.parent || '',
      depth: node.depth,
      children: (node.children || []).map(flatten)
    })
    const payload = {
      project,
      archivedIds: [...ids],
      roots: tree.map(flatten)
    }
    writeFileSync(
      join(homedir(), '.secretary-office', 'org-debug.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    )
  } catch {
    /* 调试快照失败不影响主流程 */
  }
}

async function backfillHistory(ctx, manager) {
  const sessionQuery = ctx.get('sessionQuery')
  if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return
  let sessions = []
  try {
    sessions = await sessionQuery.listSessions()
  } catch {
    return
  }
  for (const entry of sessions || []) {
    const header = entry.header || entry
    if (!header || !header.id) continue
    let snapshot
    try {
      snapshot = await sessionQuery.readSession(header.id)
    } catch {
      continue
    }
    if (!snapshot) continue
    const cwd = (snapshot.session && snapshot.session.cwd) || header.cwd
    const project = cwd ? projectForCwd(cwd) : 'default'
    const depth =
      snapshot.session && typeof snapshot.session.delegationDepth === 'number'
        ? snapshot.session.delegationDepth
        : typeof header.delegationDepth === 'number'
          ? header.delegationDepth
          : undefined
    const envelopes = eventsToEnvelopes(snapshot, project, 'dsh', { targetPresets: TARGET_PRESETS })
    for (const envelope of envelopes) {
      // 用该轮实际 preset 判断收录方式
      const mode = captureMode(depth, envelope.payload.preset)
      if (mode === 'skip' || !envelope.project) continue
      if (mode === 'cold') envelope.cold = true
      try {
        await manager.sendRawEvent(envelope)
      } catch {
        /* skip individual failures */
      }
    }
  }
}

export function apply(ctx, options = {}) {
  const { coreDir, dataDir, python } = options
  if (dataDir) process.env.SECRETARY_OFFICE_HOME = dataDir
  const manager = new CoreManager({ coreDir, dataDir, python })
  const globalExportPath = join(dataDir || join(homedir(), '.secretary-office'), 'global-presets.json')
  const exported = new Set()
  try { for (const id of JSON.parse(readFileSync(globalExportPath, 'utf8'))) exported.add(id) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const registrations = new Map()
  let exportQueue = Promise.resolve()
  const exportBuiltin = id => {
    const job = exportQueue.then(async () => {
      const definition = BUILTIN_PRESETS.find(p => p.id === id)
      if (!definition) throw new Error('Unknown builtin preset: ' + id)
      const registry = ctx.get('agentPresets')
      if (!registry?.register || !registry?.list) throw new Error('DSH agentPresets service unavailable')
      if (!registrations.has(id)) {
        if ((await registry.list()).some(p=>p.id===id)) throw new Error('全局已有同名预设，未覆盖：' + id)
        const dispose = await registry.register(definition)
        const row = (await registry.list()).find(p=>p.id===id)
        if (!row || row.broken) { await dispose(); throw new Error('预设加载失败：' + JSON.stringify(row?.broken)) }
        try {
          mkdirSync(resolve(globalExportPath, '..'), {recursive:true})
          writeFileSync(globalExportPath, JSON.stringify([...new Set([...exported,id])]), 'utf8')
        } catch (error) { await dispose(); throw error }
        exported.add(id)
        registrations.set(id,dispose)
      }
      return {id,installed:true}
    })
    exportQueue = job.catch(()=>{})
    return job
  }
  ctx.inject(['agentPresets'], child => {
    child.effect(() => {
      let stopped = false
      const ready = (async()=>{for (const id of exported) {if(stopped) break; try {await exportBuiltin(id)} catch(error) {ctx.logger?.warn?.(String(error))}}})()
      return async()=>{stopped=true;await ready;await exportQueue;for(const dispose of registrations.values()) await dispose();registrations.clear()}
    })
  })
  const syncFlatMembers = async project => {
    const cfg = await manager.request('GET','/v1/organization?project='+encodeURIComponent(project))
    if (cfg.mode !== 'flat') return cfg
    const tree = await buildOrgTree(ctx,project)
    if (tree === null) return cfg
    const members = flatMembers(tree,cfg.members)
    if (JSON.stringify(members) === JSON.stringify(cfg.members)) return cfg
    return manager.request('POST','/v1/organization/sync',{project,members})
  }
  const buffers = new Map()
  ctx.effect(() => {
    let stopped = false, polling = false
    const tick = async () => {
      if (stopped || polling) return
      polling = true
      try {
        const controller = ctx.get('sessionController')
        if (!controller?.prompt) return
        for (const project of managedProjects()) await syncFlatMembers(project.id)
        const pending = await manager.request('GET', '/v1/rounds/pending')
        for (const activation of pending.items || []) {
          if (stopped) break
          const cfg = await manager.request('GET', '/v1/organization?project=' + encodeURIComponent(activation.project))
          const member = cfg.members.find(m => m.id === activation.member)
          if (!member) continue
          try {
            const inbox = await manager.request('GET', '/v1/member-messages?' + new URLSearchParams({project:activation.project,session_id:member.session_id}))
            const messages = inbox.items || []
            const content = '项目轮次 ' + activation.number + '\n成员：' + JSON.stringify(cfg.members.map(m => ({id:m.id,name:m.name,role:m.role,preset:m.preset}))) + '\n本轮任务：' + (activation.task || '处理收到的留言。') + (messages.length ? '\n未读留言：' + JSON.stringify(messages) : '')
            await manager.request('POST','/v1/rounds/activation',{project:activation.project,round_id:activation.round_id,member:member.id,status:'dispatched'})
            await controller.prompt({sessionId:member.session_id,requestId:'office-'+activation.round_id+'-'+member.id,mode:'followup',content:[{type:'text',text:content}]}, 'user-rpc')
            // Acknowledge only messages included in this activation.
            if (messages.length) await manager.request('POST','/v1/member-messages/ack',{project:activation.project,session_id:member.session_id,ids:messages.map(m=>m.id)})
          } catch (error) {
            await manager.request('POST','/v1/rounds/activation',{project:activation.project,round_id:activation.round_id,member:member.id,status:'failed',error:String(error)})
          }
        }
      } catch (error) { ctx.logger?.warn?.('office rounds: ' + String(error)) }
      finally { polling = false }
    }
    const timer = setInterval(tick, 2000)
    timer.unref?.()
    return () => { stopped = true; clearInterval(timer) }
  })

  // 控制台 API：把 `/office-console/api/*` 白名单代理挂到宿主 webServer 上。
  // webServer 可能在插件加载后才就绪（历史问题是"只重试 5 次然后永久放弃"），
  // 所以这里持续重试直到拿到服务或插件被销毁。
  ctx.effect(() => {
    let disposeRoute
    let cancelled = false
    let timer
    const helpers = {
      async workspaces() {
        const registry = ctx.get('workspaceRegistry')
        const rows = typeof registry?.list === 'function' ? await registry.list() : []
        return {workspaces:rows.map(w=>({id:w.id,title:w.title||w.path,path:w.path})).filter(w=>w.path),projects:managedProjects()}
      },
      async manageWorkspace(body) {
        const registry = ctx.get('workspaceRegistry')
        const rows = typeof registry?.list === 'function' ? await registry.list() : []
        const workspace = rows.find(w=>w.id===body.workspace_id)
        if (!workspace?.path) throw new Error('请选择 DSH 中现有的工作区项目')
        const path = resolve(workspace.path)
        const projects = managedProjects()
        let project = projects.find(p=>resolve(p.path).toLowerCase()===path.toLowerCase())
        if (!project) {
          project = {id:'workspace-'+createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0,20),name:workspace.title||path,path,workspace_id:workspace.id}
          await manager.request('POST','/v1/projects',{id:project.id})
          projects.push(project)
          mkdirSync(dataDir,{recursive:true})
          writeFileSync(managedProjectsPath(),JSON.stringify({projects},null,2),'utf8')
        }
        return project
      },
      organization: syncFlatMembers,
      async org(project) {
        const tree = await buildOrgTree(ctx, project)
        return {roots:tree || [],nodes:[]}
      },
      exportPreset: exportBuiltin,
      async presets() {
        const builtins = BUILTIN_PRESETS.map(({id,name,description})=>({id,name,description,builtin:true,installed:true}))
        try {
          const registry = ctx.get('agentPresets')
          if (typeof registry?.list !== 'function') return {presets:builtins,globalPresets:[],error:'DSH agentPresets service unavailable'}
          const globalPresets = await registry.list()
          return {presets:builtins,globalPresets}
        } catch (error) {
          return {presets:builtins,globalPresets:[],error:String(error)}
        }
      },
      async presetDocument(id, source) {
        const builtin = source !== "global" && BUILTIN_PRESETS.find(p=>p.id===id)
        if (builtin) return {agentPreset:id,name:builtin.name,content:JSON.stringify(builtin.plugins,null,2)}
        try {
          const presets = ctx.get('agentPresets')
          const document = typeof presets?.readDocument === 'function' ? await presets.readDocument(id) : undefined
          return { agentPreset: id, ...(document ?? {}) }
        } catch {
          return { agentPreset: id }
        }
      }
    }
    const attach = () => {
      if (cancelled) return
      const webServer = ctx.get('webServer')
      if (webServer === undefined || typeof webServer.register !== 'function') {
        timer = setTimeout(attach, 1000)
        if (typeof timer.unref === 'function') timer.unref()
        return
      }
      try {
        disposeRoute = registerConsoleRoutes(webServer, manager, helpers)
      } catch (error) {
        ctx.logger?.warn?.(`office: 控制台路由注册失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    attach()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      try {
        if (typeof disposeRoute === 'function') disposeRoute()
      } catch {
        /* ignore */
      }
    }
  })

  ctx.effect(() => {
    const systemPrompt = ctx.get('systemPrompt')
    if (!systemPrompt || typeof systemPrompt.context !== 'function') return () => {}
    const dispose = systemPrompt.context({
      // rc.3 的 PromptContext 要求 name + 有限 order（缺任一都会在装配时抛错）。
      // order 100：紧跟 harness 身份与 persona 前缀之后、第一方指引之前。
      name: 'office:project-brief',
      order: 100,
      text: (arg) => {
        const session = arg && arg.agent && arg.agent.session
        const cwd = session && session.header ? session.header.cwd : undefined
        const project = cwd ? projectForCwd(cwd) : null
        if (!project) return ''
        // 缓存过期就顺手在后台刷新（同步函数里不能 await）。
        if (briefIsStale(project)) {
          refreshBrief(manager, project).catch(() => {})
        }
        return briefFor(cwd)
      }
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  })

  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (!session || !session.id) return
      const header = session.header || {}
      const depth = typeof header.delegationDepth === 'number' ? header.delegationDepth : undefined
      let buffer = buffers.get(session.id)
      if (!buffer) {
        const cwd = header.cwd
        buffer = new TurnBuffer({
          sessionId: session.id,
          cwd,
          preset: header.agentPreset,
          project: cwd ? projectForCwd(cwd) : 'default'
        })
        buffers.set(session.id, buffer)
      }
      if (!projectForCwd(header.cwd)) return
      const envelope = buffer.consume(event)
      if (envelope) manager.request('POST','/v1/rounds/complete',{project:envelope.project,session_id:session.id}).catch(error=>ctx.logger?.warn?.(String(error)))
      if (!envelope) return
      // 用该轮实际 preset 判断（会话可能中途切换预设）
      const mode = captureMode(depth, envelope.payload.preset)
      if (mode === 'skip') return
      if (mode === 'cold') envelope.cold = true
      manager
        .sendRawEvent(envelope)
        .then(() => refreshBrief(manager, envelope.project))
        .catch(() => {})
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  })

  ctx.effect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await manager.start()
      } catch {
        return
      }
      if (cancelled) return
      await backfillHistory(ctx, manager)
      if (cancelled) return
      // 启动后预热简报缓存，让第一轮对话就能看到真实项目简报。
      await refreshBriefs(manager)
    })()
    return () => {
      cancelled = true
      manager.dispose()
    }
  })
}

export default { apply }
