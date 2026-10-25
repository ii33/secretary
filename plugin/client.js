// DSH UI module: 秘书办公室控制台（6 标签页 + 记忆管理 5 子标签 + 顶部项目下拉）。
// Contract defined by plugin/test/client.test.mjs
//
// 三条硬约束（都是踩过的坑）：
//   1. DSH 把 client.js 当**普通脚本**注入（不是 ESM）→ 顶层不能有 `export`。
//   2. slot 注册是 `ctx.slots.register(options, Component)`（组件是第二个参数）。
//   3. 整段包进 IIFE，避免与其它插件的顶层 const 撞名。
(function () {
  const MODULE_ID = '@local/dsh-office'
  const API = '/office-console/api'
  // 由 apply(ctx) 注入，供「进入会话」调用
  let workspaceApi = null

  async function getJSON(url) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`)
    return response.json()
  }

  async function postJSON(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`)
    return response.json()
  }

  function install(loader) {
    if (!loader || typeof loader.load !== 'function') return
    loader.load({
      id: MODULE_ID,
      factory(require) {
        const React = require('react')
        const h = React.createElement

        const text = { fontSize: 13, lineHeight: '20px', margin: '2px 0' }
        const muted = { ...text, opacity: 0.6 }
        const section = { marginTop: 16 }
        const badge = { fontSize: 11, opacity: 0.65, marginLeft: 6 }
        const inputStyle = {
          font: 'inherit', fontSize: 13, padding: '3px 8px', borderRadius: 4, width: '100%',
          border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', color: 'inherit',
          boxSizing: 'border-box', marginTop: 4
        }
        const buttonStyle = {
          font: 'inherit', fontSize: 12, padding: '2px 8px', cursor: 'pointer', borderRadius: 4,
          border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', color: 'inherit'
        }
        const tabButtonStyle = {
          font: 'inherit', fontSize: 13, padding: '6px 14px', cursor: 'pointer',
          border: '1px solid rgba(128,128,128,0.35)', borderBottom: 'none',
          borderRadius: '7px 7px 0 0', background: 'rgba(128,128,128,0.06)', color: 'inherit',
          marginBottom: -1
        }
        const activeTabStyle = {
          background: 'rgba(90,120,255,0.16)', borderColor: 'rgba(90,120,255,0.8)',
          fontWeight: 600, color: 'inherit'
        }
        const subtabStyle = {
          ...buttonStyle, borderRadius: 999, padding: '3px 12px', marginRight: 6, opacity: 0.7
        }
        const activeSubtabStyle = {
          background: 'rgba(90,120,255,0.16)', borderColor: 'rgba(90,120,255,0.8)',
          fontWeight: 600, opacity: 1
        }
        const subtabRowStyle = { display: 'flex', flexWrap: 'wrap', gap: 2, marginBottom: 10 }
        const rowStyle = { display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0' }
        const cardStyle = { border: '1px solid rgba(128,128,128,0.22)', borderRadius: 6, padding: '8px 10px', margin: '8px 0' }

        const TABS = [
          ['memory', '记忆管理'],
          ['presets', '项目预设'],
          ['org', '人员架构'],
          ['advice', '顾问建议'],
          ['taskboard', '任务板'],
          ['conventions', '项目约定']
        ]
        const MEMORY_SUBS = [
          ['brief', '简报'],
          ['search', '搜索'],
          ['recent', '最近'],
          ['compress', '压缩'],
          ['recycle', '归档·回收站']
        ]
        const TASK_SECTIONS = [['long_term', '长期目标'], ['stage', '阶段目标'], ['current', '当前任务']]
        const CONV_KINDS = [['avoid', '避免'], ['follow', '遵守']]
        const TASK_STATUS = { open: '进行中', done: '已达成', suspended: '已挂起' }
        const CONV_STATUS = { active: '生效', suspended: '已挂起' }
        const PRESET_LABELS = {
          secretary: '执行秘书', advisor: '顾问', gm: '总经理', dm: '部门经理',
          worker: '执行员', generic: '普通会话', standard: '普通会话'
        }

        function OfficeConsole() {
          const [projects, setProjects] = React.useState([])
          const [selected, setSelected] = React.useState('')
          const [activeTab, setActiveTab] = React.useState('memory')
          const [memorySub, setMemorySub] = React.useState('brief')
          const [taskSub, setTaskSub] = React.useState('long_term')
          const [convSub, setConvSub] = React.useState('avoid')
          const [error, setError] = React.useState('')
          const [loading, setLoading] = React.useState(true)
          const [message, setMessage] = React.useState('')

          const [brief, setBrief] = React.useState('')
          const [recent, setRecent] = React.useState([])
          const [recycle, setRecycle] = React.useState([])
          const [cold, setCold] = React.useState([])
          const [query, setQuery] = React.useState('')
          const [results, setResults] = React.useState([])
          const [searched, setSearched] = React.useState('')
          const [compressPreview, setCompressPreview] = React.useState(null)
          const [busy, setBusy] = React.useState(false)

          const [board, setBoard] = React.useState([])
          const [rules, setRules] = React.useState([])
          const [advice, setAdvice] = React.useState([])
          const [org, setOrg] = React.useState(null)
          const [agentNames, setAgentNames] = React.useState({})
          const [editingAgent, setEditingAgent] = React.useState('')
          const [agentDraft, setAgentDraft] = React.useState('')
          const [collapsedNodes, setCollapsedNodes] = React.useState({})
          const [presets, setPresets] = React.useState([])
          const [projectPresets, setProjectPresets] = React.useState([])
          const [importOpen, setImportOpen] = React.useState(false)
          const [exportContent, setExportContent] = React.useState('')
          const [stats, setStats] = React.useState(null)
          const [presetDoc, setPresetDoc] = React.useState('')
          const [presetDocTitle, setPresetDocTitle] = React.useState('')
          const [artifacts, setArtifacts] = React.useState([])
          const [rolePolicies, setRolePolicies] = React.useState([])

          const [editingTask, setEditingTask] = React.useState('')
          const [taskDraft, setTaskDraft] = React.useState({ title: '', detail: '' })
          const [newTaskSection, setNewTaskSection] = React.useState('')
          const [newTaskDraft, setNewTaskDraft] = React.useState({ title: '', detail: '' })

          const [editingConv, setEditingConv] = React.useState('')
          const [convDraft, setConvDraft] = React.useState({ title: '', detail: '' })
          const [newConvKind, setNewConvKind] = React.useState('')
          const [newConvDraft, setNewConvDraft] = React.useState({ title: '', detail: '' })

          const fail = (problem) => setMessage(problem && problem.message ? problem.message : String(problem))

          const loadProjects = React.useCallback(async () => {
            setLoading(true)
            setError('')
            try {
              const data = await getJSON(`${API}/projects`)
              const list = Array.isArray(data.projects) ? data.projects : []
              setProjects(list)
              setSelected((current) => (current === '' && list.length > 0 ? String(list[0].id) : current))
            } catch (problem) {
              setError(problem && problem.message ? problem.message : String(problem))
            } finally {
              setLoading(false)
            }
          }, [])

          React.useEffect(() => {
            loadProjects()
          }, [loadProjects])

          const reloadProject = React.useCallback(async (projectId) => {
            if (!projectId) return
            const p = encodeURIComponent(projectId)
            const [briefData, recentData, boardData, ruleData, adviceData, recycleData, coldData, statsData, artifactsData, rolesData] = await Promise.all([
              getJSON(`${API}/brief?project=${p}`).catch(() => ({ text: '' })),
              getJSON(`${API}/recent?project=${p}&n=8`).catch(() => ({ results: [] })),
              getJSON(`${API}/taskboard?project=${p}`).catch(() => ({ items: [] })),
              getJSON(`${API}/conventions?project=${p}`).catch(() => ({ items: [] })),
              getJSON(`${API}/advice?project=${p}`).catch(() => ({ items: [] })),
              getJSON(`${API}/recycle?project=${p}`).catch(() => ({ items: [] })),
              getJSON(`${API}/cold?project=${p}`).catch(() => ({ items: [] })),
              getJSON(`${API}/stats?project=${p}`).catch(() => null),
              getJSON(`${API}/artifacts?project=${p}`).catch(() => ({ items: [] })),
              getJSON(`${API}/roles?project=${p}`).catch(() => ({ items: [] }))
            ])
            setBrief(typeof briefData.text === 'string' ? briefData.text : '')
            setRecent(Array.isArray(recentData.results) ? recentData.results : [])
            setBoard(Array.isArray(boardData.items) ? boardData.items : [])
            setRules(Array.isArray(ruleData.items) ? ruleData.items : [])
            setAdvice(Array.isArray(adviceData.items) ? adviceData.items : [])
            setRecycle(Array.isArray(recycleData.items) ? recycleData.items : [])
            setCold(Array.isArray(coldData.items) ? coldData.items : [])
            setStats(statsData)
            setArtifacts(Array.isArray(artifactsData.items) ? artifactsData.items : [])
            setRolePolicies(Array.isArray(rolesData.items) ? rolesData.items : [])
          }, [])

          React.useEffect(() => {
            reloadProject(selected)
          }, [selected, reloadProject])

          React.useEffect(() => {
            if (activeTab === 'org' && selected !== '') {
              const p = encodeURIComponent(selected)
              Promise.all([
                getJSON(`${API}/org?project=${p}`).catch(() => null),
                getJSON(`${API}/agent-names?project=${p}`).catch(() => ({ names: {} }))
              ]).then(([orgData, namesData]) => {
                setOrg(orgData)
                setAgentNames(namesData && namesData.names ? namesData.names : {})
              })
            }
            if (activeTab === 'presets' && selected !== '') {
              const p = encodeURIComponent(selected)
              Promise.all([
                getJSON(`${API}/project-presets?project=${p}`).catch(() => ({ items: [] })),
                getJSON(`${API}/presets`).catch(() => ({ presets: [] }))
              ]).then(([pp, gp]) => {
                setProjectPresets(Array.isArray(pp.items) ? pp.items : [])
                setPresets(Array.isArray(gp.presets) ? gp.presets : [])
              })
            }
          }, [activeTab, selected])

          const doSearch = React.useCallback(async () => {
            const keyword = query.trim()
            if (keyword === '' || selected === '') {
              setResults([])
              setSearched('')
              return
            }
            try {
              const data = await getJSON(`${API}/search?project=${encodeURIComponent(selected)}&q=${encodeURIComponent(keyword)}&limit=10`)
              setResults(Array.isArray(data.results) ? data.results : [])
              setSearched(keyword)
            } catch (problem) {
              fail(problem)
            }
          }, [query, selected])

          const doCompressPreview = React.useCallback(async () => {
            if (selected === '') return
            setBusy(true)
            setMessage('')
            try {
              setCompressPreview(await getJSON(`${API}/compress/preview?project=${encodeURIComponent(selected)}&batch=20`))
            } catch (problem) {
              fail(problem)
            } finally {
              setBusy(false)
            }
          }, [selected])

          const doCompressConfirm = React.useCallback(async () => {
            if (selected === '') return
            setBusy(true)
            setMessage('')
            try {
              const data = await postJSON(`${API}/compress`, { project: selected, batch: 20, confirm: true })
              setMessage(`已压缩 ${data.processed || 0} 轮，写入 ${data.notes_written || 0} 条记忆`)
              setCompressPreview(null)
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            } finally {
              setBusy(false)
            }
          }, [selected, reloadProject])

          const doArchive = React.useCallback(async () => {
            if (selected === '') return
            try {
              const data = await postJSON(`${API}/archive`, { project: selected, now: false })
              setMessage(`已归档 ${data.archived || 0} 条`)
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            }
          }, [selected, reloadProject])

          const doPurge = React.useCallback(async () => {
            if (selected === '') return
            try {
              const data = await postJSON(`${API}/purge`, { project: selected })
              setMessage(`已彻底清除 ${data.purged || 0} 条`)
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            }
          }, [selected, reloadProject])

          const decideAdvice = React.useCallback(async (id, decision) => {
            try {
              await postJSON(`${API}/advice/${encodeURIComponent(id)}/decision`, { decision })
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            }
          }, [selected, reloadProject])

          const taskStatus = React.useCallback(async (id, status) => {
            try {
              await postJSON(`${API}/taskboard`, { project: selected, id, status })
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            }
          }, [selected, reloadProject])

          const saveTask = React.useCallback(async (id) => {
            try {
              await postJSON(`${API}/taskboard`, { project: selected, id, title: taskDraft.title, detail: taskDraft.detail })
              setEditingTask('')
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            }
          }, [selected, taskDraft, reloadProject])

          const addTask = React.useCallback(async (sectionId) => {
            if (!newTaskDraft.title.trim()) return
            try {
              await postJSON(`${API}/taskboard`, { project: selected, section: sectionId, title: newTaskDraft.title, detail: newTaskDraft.detail })
              setNewTaskSection('')
              setNewTaskDraft({ title: '', detail: '' })
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            }
          }, [selected, newTaskDraft, reloadProject])

          const removeTask = React.useCallback(async (id) => {
            try {
              await postJSON(`${API}/taskboard`, { project: selected, id, remove: true })
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            }
          }, [selected, reloadProject])

          const convStatus = React.useCallback(async (id, status) => {
            try {
              await postJSON(`${API}/conventions`, { project: selected, id, status })
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            }
          }, [selected, reloadProject])

          const saveConv = React.useCallback(async (id) => {
            try {
              await postJSON(`${API}/conventions`, { project: selected, id, title: convDraft.title, detail: convDraft.detail })
              setEditingConv('')
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            }
          }, [selected, convDraft, reloadProject])

          const addConv = React.useCallback(async (kind) => {
            if (!newConvDraft.title.trim()) return
            try {
              await postJSON(`${API}/conventions`, { project: selected, kind, title: newConvDraft.title, detail: newConvDraft.detail })
              setNewConvKind('')
              setNewConvDraft({ title: '', detail: '' })
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            }
          }, [selected, newConvDraft, reloadProject])

          const removeConv = React.useCallback(async (id) => {
            try {
              await postJSON(`${API}/conventions`, { project: selected, id, remove: true })
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            }
          }, [selected, reloadProject])

          const saveAgentName = React.useCallback(async (sessionId) => {
            if (selected === '' || !agentDraft.trim()) return
            try {
              await postJSON(`${API}/agent-names`, { project: selected, session_id: sessionId, name: agentDraft.trim() })
              setAgentNames((prev) => ({ ...prev, [sessionId]: agentDraft.trim() }))
              setEditingAgent('')
            } catch (problem) {
              fail(problem)
            }
          }, [selected, agentDraft])

          const reloadProjectPresets = React.useCallback(async () => {
            if (selected === '') return
            const data = await getJSON(`${API}/project-presets?project=${encodeURIComponent(selected)}`).catch(() => ({ items: [] }))
            setProjectPresets(Array.isArray(data.items) ? data.items : [])
          }, [selected])

          const importPreset = React.useCallback(async (presetId) => {
            if (selected === '') return
            try {
              const doc = await getJSON(`${API}/presets/${encodeURIComponent(presetId)}`).catch(() => null)
              const content = doc && typeof doc.content === 'string' ? doc.content : ''
              await postJSON(`${API}/project-presets`, {
                project: selected, id: presetId,
                name: (doc && doc.agentPreset) || presetId,
                content, source: 'imported'
              })
              setImportOpen(false)
              await reloadProjectPresets()
            } catch (problem) {
              fail(problem)
            }
          }, [selected, reloadProjectPresets])

          const removeProjectPreset = React.useCallback(async (presetId) => {
            if (selected === '') return
            try {
              const url = `${API}/project-presets/${encodeURIComponent(presetId)}?project=${encodeURIComponent(selected)}`
              const response = await fetch(url, { method: 'DELETE' })
              if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`)
              await reloadProjectPresets()
            } catch (problem) {
              fail(problem)
            }
          }, [selected, reloadProjectPresets])

          const recycleTurn = React.useCallback(async (id) => {
            try {
              await postJSON(`${API}/recycle`, { project: selected, id })
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            }
          }, [selected, reloadProject])

          const restoreTurn = React.useCallback(async (id) => {
            try {
              await postJSON(`${API}/restore`, { project: selected, id })
              await reloadProject(selected)
            } catch (problem) {
              fail(problem)
            }
          }, [selected, reloadProject])

          const viewPreset = React.useCallback(async (presetId) => {
            if (!presetId) return
            try {
              const doc = await getJSON(`${API}/presets/${encodeURIComponent(presetId)}`).catch(() => null)
              setPresetDocTitle(presetId)
              setPresetDoc(doc && typeof doc.content === 'string' ? doc.content : JSON.stringify(doc, null, 2))
            } catch (problem) {
              fail(problem)
            }
          }, [])

          const enterSession = React.useCallback((sessionId) => {
            try {
              if (workspaceApi && typeof workspaceApi.openSession === 'function') {
                workspaceApi.openSession(sessionId)
              } else {
                setMessage('当前环境不支持「进入会话」')
              }
            } catch (problem) {
              fail(problem)
            }
          }, [])

          // ---------------- 子标签辅助 ----------------

          function renderSubtabs(items, active, onPick) {
            return h('div', { style: subtabRowStyle },
              items.map(([id, label]) => h('button', {
                key: id, type: 'button', onClick: () => onPick(id),
                style: { ...subtabStyle, ...(active === id ? activeSubtabStyle : {}) }
              }, label)))
          }

          // ---------------- 记忆管理（5 子标签） ----------------

          function renderMemoryBrief() {
            return brief === ''
              ? h('p', { style: text }, '（暂无简报，可先压缩）')
              : h('pre', { style: { ...text, whiteSpace: 'pre-wrap', fontFamily: 'inherit', marginTop: 6 } }, brief)
          }

          function renderMemorySearch() {
            const rows = searched === ''
              ? null
              : results.length === 0
                ? h('p', { style: text }, `「${searched}」无结果`)
                : results.map((row, index) =>
                    h('div', { key: String(row.id !== undefined ? row.id : index), style: { ...text, margin: '6px 0' } },
                      h('div', null, String(row.user || '').slice(0, 160)),
                      h('div', { style: muted }, String(row.assistant || '').slice(0, 160))))
            return h('div', null,
              h('div', { style: rowStyle },
                h('input', {
                  type: 'text', value: query, placeholder: '输入关键词后回车', style: { ...inputStyle, marginTop: 0 },
                  onChange: (event) => setQuery(event.target.value),
                  onKeyDown: (event) => { if (event.key === 'Enter') doSearch() }
                }),
                h('button', { type: 'button', onClick: () => doSearch(), style: buttonStyle }, '搜索')
              ),
              rows
            )
          }

          function renderMemoryRecent() {
            const turnRows = recent.length === 0
              ? h('p', { style: text }, '（暂无记忆）')
              : recent.map((row, index) =>
                  h('div', { key: String(row.id !== undefined ? row.id : index), style: cardStyle },
                    h('div', { style: text },
                      h('span', { style: badge }, String(row.role || '')),
                      ' ',
                      String(row.user || '（无用户文本）').slice(0, 100)),
                    h('div', { style: rowStyle },
                      h('button', {
                        type: 'button', style: buttonStyle,
                        onClick: () => recycleTurn(row.id)
                      }, '删除到回收站'))))
            const artifactRows = artifacts.length === 0
              ? h('p', { style: muted }, '（暂无交付物）')
              : artifacts.map((item) =>
                  h('p', { key: String(item.id), style: text },
                    `[${item.kind || 'file'}] ${item.title || item.path || item.id}`))
            return h('div', null,
              turnRows,
              h('div', { style: section },
                h('strong', { style: text }, `交付物（${artifacts.length}）`),
                artifactRows))
          }

          function renderMemoryCompress() {
            const box = compressPreview === null
              ? h('p', { style: muted }, '预览会展示将写入的记忆条目与简报，不会写库。')
              : h('div', null,
                  h('p', { style: text }, `待压缩 ${(compressPreview.turn_ids || []).length} 轮 → 将写入 ${(compressPreview.notes || []).length} 条记忆`),
                  (compressPreview.notes || []).length === 0
                    ? h('p', { style: text }, '（没有可提取的决策/偏好/完成项/未决问题）')
                    : (compressPreview.notes || []).map((note, index) =>
                        h('p', { key: index, style: text }, `[${note.kind}] ${note.text}`)),
                  h('pre', { style: { ...text, whiteSpace: 'pre-wrap', fontFamily: 'inherit', marginTop: 6 } }, compressPreview.brief || ''))
            return h('div', null,
              h('div', { style: rowStyle },
                h('button', { type: 'button', onClick: () => doCompressPreview(), disabled: busy, style: buttonStyle }, busy ? '处理中…' : '预览压缩'),
                compressPreview === null ? null : h('button', { type: 'button', onClick: () => doCompressConfirm(), disabled: busy, style: buttonStyle }, '确认压缩')
              ),
              box
            )
          }

          function renderMemoryRecycle() {
            return h('div', null,
              h('div', { style: rowStyle },
                h('button', { type: 'button', onClick: () => doArchive(), style: buttonStyle }, '归档已压缩原文'),
                h('button', { type: 'button', onClick: () => doPurge(), style: buttonStyle }, '清空回收站')
              ),
              h('div', { style: section },
                h('strong', { style: text }, `冷备（${cold.length}）`),
                h('p', { style: muted }, 'ES↔GM 的对话直接进冷备，不参与热记忆检索。'),
                cold.length === 0
                  ? h('p', { style: muted }, '（冷备为空）')
                  : cold.map((row, index) =>
                      h('p', { key: String(row.id !== undefined ? row.id : index), style: text },
                        `T${row.id} · ${row.role || ''} · ${row.preset || ''} · ${row.length ? row.length + 'B' : ''}`))),
              h('div', { style: section },
                h('strong', { style: text }, `回收站（${recycle.length}）`),
                recycle.length === 0
                  ? h('p', { style: muted }, '（回收站为空）')
                  : recycle.map((row, index) =>
                      h('div', { key: String(row.id !== undefined ? row.id : index), style: cardStyle },
                        h('div', { style: text }, `#${row.id} ${String(row.user || '').slice(0, 80)}`),
                        h('div', { style: rowStyle },
                          h('button', {
                            type: 'button', style: buttonStyle,
                            onClick: () => restoreTurn(row.id)
                          }, '还原')))))
            )
          }

          function renderMemory() {
            const subBar = renderSubtabs(MEMORY_SUBS, memorySub, setMemorySub)
            const statsLine = stats
              ? h('p', { style: { ...muted, marginBottom: 8 } },
                  `热 ${stats.turns} · 待压缩 ${stats.hot_raw} · 已压缩 ${stats.processed} · 冷备 ${stats.cold} · 回收站 ${stats.recycle} · 记忆 ${stats.notes} · 待处理建议 ${stats.advice_pending}`)
              : null
            const body =
              memorySub === 'brief' ? renderMemoryBrief()
              : memorySub === 'search' ? renderMemorySearch()
              : memorySub === 'recent' ? renderMemoryRecent()
              : memorySub === 'compress' ? renderMemoryCompress()
              : renderMemoryRecycle()
            return h('div', null, statsLine, subBar, body)
          }

          // ---------------- 任务板（三列表） ----------------

          function renderTaskRow(item) {
            if (editingTask === item.id) {
              return h('div', { key: item.id, style: cardStyle },
                h('input', { value: taskDraft.title, placeholder: '标题', style: inputStyle,
                  onChange: (event) => setTaskDraft({ ...taskDraft, title: event.target.value }) }),
                h('input', { value: taskDraft.detail, placeholder: '详情', style: inputStyle,
                  onChange: (event) => setTaskDraft({ ...taskDraft, detail: event.target.value }) }),
                h('div', { style: rowStyle },
                  h('button', { type: 'button', onClick: () => saveTask(item.id), style: buttonStyle }, '保存'),
                  h('button', { type: 'button', onClick: () => setEditingTask(''), style: buttonStyle }, '取消'))
              )
            }
            return h('div', { key: item.id, style: cardStyle },
              h('div', { style: text },
                h('span', { style: badge }, TASK_STATUS[item.status] || item.status || ''),
                ' ',
                h('strong', null, String(item.title || '')),
                item.detail ? h('div', { style: muted }, String(item.detail)) : null),
              h('div', { style: rowStyle },
                h('button', { type: 'button', style: buttonStyle, onClick: () => { setEditingTask(item.id); setTaskDraft({ title: item.title || '', detail: item.detail || '' }) } }, '编辑'),
                item.status === 'suspended'
                  ? h('button', { type: 'button', style: buttonStyle, onClick: () => taskStatus(item.id, 'open') }, '激活')
                  : h('button', { type: 'button', style: buttonStyle, onClick: () => taskStatus(item.id, 'suspended') }, '挂起'),
                item.status !== 'done'
                  ? h('button', { type: 'button', style: buttonStyle, onClick: () => taskStatus(item.id, 'done') }, '达成')
                  : h('button', { type: 'button', style: buttonStyle, onClick: () => taskStatus(item.id, 'open') }, '重新打开'),
                h('button', { type: 'button', style: buttonStyle, onClick: () => removeTask(item.id) }, '移除'))
            )
          }

          function renderNewTask(sectionId) {
            if (newTaskSection === sectionId) {
              return h('div', { style: { ...cardStyle, borderStyle: 'dashed' } },
                h('input', { value: newTaskDraft.title, placeholder: '标题', style: inputStyle,
                  onChange: (event) => setNewTaskDraft({ ...newTaskDraft, title: event.target.value }) }),
                h('input', { value: newTaskDraft.detail, placeholder: '详情（可选）', style: inputStyle,
                  onChange: (event) => setNewTaskDraft({ ...newTaskDraft, detail: event.target.value }) }),
                h('div', { style: rowStyle },
                  h('button', { type: 'button', onClick: () => addTask(sectionId), style: buttonStyle }, '保存'),
                  h('button', { type: 'button', onClick: () => { setNewTaskSection(''); setNewTaskDraft({ title: '', detail: '' }) }, style: buttonStyle }, '取消'))
              )
            }
            return h('button', {
              type: 'button', style: { ...buttonStyle, marginTop: 4 },
              onClick: () => { setNewTaskSection(sectionId); setNewTaskDraft({ title: '', detail: '' }) }
            }, '＋ 新增')
          }

          function renderTaskboard() {
            const subBar = renderSubtabs(TASK_SECTIONS, taskSub, setTaskSub)
            const current = TASK_SECTIONS.find(([id]) => id === taskSub) || TASK_SECTIONS[0]
            const items = board.filter((item) => (item.section || 'current') === taskSub)
            return h('div', null,
              subBar,
              h('strong', { style: text }, `${current[1]}（${items.length}）`),
              items.length === 0 ? h('p', { style: muted }, '（空）') : items.map((item) => renderTaskRow(item)),
              renderNewTask(taskSub),
              h('p', { style: { ...muted, marginTop: 12, fontSize: 11 } }, 'ES、GM、DM 可见。')
            )
          }

          // ---------------- 项目约定（两列表） ----------------

          function renderConvRow(item) {
            if (editingConv === item.id) {
              return h('div', { key: item.id, style: cardStyle },
                h('input', { value: convDraft.title, placeholder: '标题', style: inputStyle,
                  onChange: (event) => setConvDraft({ ...convDraft, title: event.target.value }) }),
                h('input', { value: convDraft.detail, placeholder: '详情（可选）', style: inputStyle,
                  onChange: (event) => setConvDraft({ ...convDraft, detail: event.target.value }) }),
                h('div', { style: rowStyle },
                  h('button', { type: 'button', onClick: () => saveConv(item.id), style: buttonStyle }, '保存'),
                  h('button', { type: 'button', onClick: () => setEditingConv(''), style: buttonStyle }, '取消'))
              )
            }
            return h('div', { key: item.id, style: cardStyle },
              h('div', { style: text },
                h('span', { style: badge }, CONV_STATUS[item.status] || item.status || ''),
                ' ',
                h('strong', null, String(item.title || '')),
                item.detail ? h('div', { style: muted }, String(item.detail)) : null),
              h('div', { style: rowStyle },
                h('button', { type: 'button', style: buttonStyle, onClick: () => { setEditingConv(item.id); setConvDraft({ title: item.title || '', detail: item.detail || '' }) } }, '编辑'),
                item.status === 'suspended'
                  ? h('button', { type: 'button', style: buttonStyle, onClick: () => convStatus(item.id, 'active') }, '激活')
                  : h('button', { type: 'button', style: buttonStyle, onClick: () => convStatus(item.id, 'suspended') }, '挂起'),
                h('button', { type: 'button', style: buttonStyle, onClick: () => removeConv(item.id) }, '移除'))
            )
          }

          function renderNewConv(kind) {
            if (newConvKind === kind) {
              return h('div', { style: { ...cardStyle, borderStyle: 'dashed' } },
                h('input', { value: newConvDraft.title, placeholder: '标题', style: inputStyle,
                  onChange: (event) => setNewConvDraft({ ...newConvDraft, title: event.target.value }) }),
                h('input', { value: newConvDraft.detail, placeholder: '详情（可选）', style: inputStyle,
                  onChange: (event) => setNewConvDraft({ ...newConvDraft, detail: event.target.value }) }),
                h('div', { style: rowStyle },
                  h('button', { type: 'button', onClick: () => addConv(kind), style: buttonStyle }, '保存'),
                  h('button', { type: 'button', onClick: () => { setNewConvKind(''); setNewConvDraft({ title: '', detail: '' }) }, style: buttonStyle }, '取消'))
              )
            }
            return h('button', {
              type: 'button', style: { ...buttonStyle, marginTop: 4 },
              onClick: () => { setNewConvKind(kind); setNewConvDraft({ title: '', detail: '' }) }
            }, '＋ 新增')
          }

          function renderConventions() {
            const subBar = renderSubtabs(CONV_KINDS, convSub, setConvSub)
            const current = CONV_KINDS.find(([id]) => id === convSub) || CONV_KINDS[0]
            const items = rules.filter((item) => (item.kind || 'avoid') === convSub)
            return h('div', null,
              subBar,
              h('strong', { style: text }, `${current[1]}（${items.length}）`),
              items.length === 0 ? h('p', { style: muted }, '（空）') : items.map((item) => renderConvRow(item)),
              renderNewConv(convSub),
              h('p', { style: { ...muted, marginTop: 12, fontSize: 11 } }, 'ES、GM、DM 可见。')
            )
          }

          // ---------------- 其他 tab ----------------

          function renderPresets() {
            return h('div', null,
              h('div', { style: rowStyle },
                h('button', { type: 'button', style: buttonStyle, onClick: () => setImportOpen(!importOpen) }, importOpen ? '取消导入' : '从全局导入'),
                h('span', { style: muted }, '项目预设默认不进全局，导出后可手动安装')),
              importOpen
                ? h('div', { style: cardStyle },
                    h('div', { style: text }, '选择全局预设导入到本项目：'),
                    presets.length === 0
                      ? h('p', { style: text }, '（没有全局预设）')
                      : presets.map((preset) =>
                          h('div', { key: String(preset.id), style: rowStyle },
                            h('span', { style: text }, `${preset.id}${preset.name ? ' · ' + preset.name : ''}`),
                            h('button', { type: 'button', style: buttonStyle, onClick: () => importPreset(preset.id) }, '导入'))))
                : null,
              h('div', { style: section },
                h('strong', { style: text }, `项目自定义预设（${projectPresets.length}）`),
                projectPresets.length === 0
                  ? h('p', { style: muted }, '（暂无，可从上方全局预设导入）')
                  : projectPresets.map((item) =>
                      h('div', { key: item.id, style: cardStyle },
                        h('div', { style: text }, h('strong', null, String(item.name || item.id)), h('span', { style: badge }, String(item.source || 'custom'))),
                        h('div', { style: rowStyle },
                          h('button', { type: 'button', style: buttonStyle, onClick: () => setExportContent(item.content || '（无内容）') }, '导出'),
                          h('button', { type: 'button', style: buttonStyle, onClick: () => removeProjectPreset(item.id) }, '移除'))))),
              exportContent === ''
                ? null
                : h('div', { style: section },
                    h('strong', { style: text }, '导出内容（复制后到预设管理里安装）'),
                    h('pre', { style: { ...text, whiteSpace: 'pre-wrap', fontFamily: 'inherit', marginTop: 6 } }, exportContent)),
              h('div', { style: section },
                h('strong', { style: text }, `角色策略（${rolePolicies.length}，只读）`),
                rolePolicies.length === 0
                  ? h('p', { style: muted }, '（暂无角色策略）')
                  : rolePolicies.map((item) =>
                      h('p', { key: String(item.role), style: text },
                        `${item.role} · preset=${item.preset || '-'} · model=${item.model || '-'} · effort=${item.effort || '-'}`)))
            )
          }

          function renderOrg() {
            if (!org) return h('p', { style: text }, '（暂无人员架构数据）')
            const roots = Array.isArray(org.roots) ? org.roots : []
            // 默认名：预设名 + 同预设序号（执行秘书1、总经理1…）
            const defaults = {}
            const counts = {}
            const walk = (node) => {
              const preset = node.preset || 'generic'
              counts[preset] = (counts[preset] || 0) + 1
              defaults[node.id] = `${PRESET_LABELS[preset] || preset}${counts[preset]}`
              for (const child of node.children || []) walk(child)
            }
            roots.forEach(walk)

            const renderNode = (node, depth) => {
              const name = agentNames[node.id] || defaults[node.id] || node.id
              const isEditing = editingAgent === node.id
              const children = node.children || []
              const hasChildren = children.length > 0
              const isCollapsed = collapsedNodes[node.id] === true
              return h('div', { key: node.id, style: { margin: '4px 0', paddingLeft: depth === 0 ? 0 : 16 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  h('span', {
                    style: {
                      width: 14, display: 'inline-block', textAlign: 'center',
                      cursor: hasChildren ? 'pointer' : 'default',
                      opacity: hasChildren ? 0.85 : 0
                    },
                    title: hasChildren ? (isCollapsed ? '展开子代理' : '折叠子代理') : '',
                    onClick: hasChildren
                      ? () => setCollapsedNodes((prev) => ({ ...prev, [node.id]: !prev[node.id] }))
                      : undefined
                  }, hasChildren ? (isCollapsed ? '▶' : '▼') : ''),
                  h('span', { style: text }, depth === 0 ? '● ' : '└ '),
                  isEditing
                    ? h('input', {
                        value: agentDraft,
                        style: { ...inputStyle, width: 160, marginTop: 0 },
                        onChange: (event) => setAgentDraft(event.target.value),
                        onKeyDown: (event) => { if (event.key === 'Enter') saveAgentName(node.id) }
                      })
                    : h('strong', {
                        style: { cursor: 'pointer', borderBottom: '1px dashed rgba(128,128,128,0.4)' },
                        onClick: () => { setEditingAgent(node.id); setAgentDraft(name) }
                      }, name),
                  h('span', { style: badge }, node.title || '（无标题）'),
                  h('span', { style: badge }, node.preset || 'generic'),
                  hasChildren ? h('span', { style: badge }, `子代理 ${children.length}`) : null),
                h('div', { style: { ...rowStyle, marginLeft: 14 } },
                  node.preset
                    ? h('button', { type: 'button', style: buttonStyle, onClick: () => viewPreset(node.preset) }, '查看预设')
                    : null,
                  h('button', { type: 'button', style: buttonStyle, onClick: () => enterSession(node.id) }, '进入会话')),
                hasChildren && !isCollapsed
                  ? h('div', { style: { borderLeft: '1px dashed rgba(128,128,128,0.35)', marginLeft: 6, paddingLeft: 8 } },
                      children.map((child) => renderNode(child, depth + 1)))
                  : null
              )
            }

            const allParentIds = []
            const collect = (node) => {
              const children = node.children || []
              if (children.length > 0) {
                allParentIds.push(node.id)
                children.forEach(collect)
              }
            }
            roots.forEach(collect)

            return h('div', null,
              h('p', { style: muted }, 'ES / 顾问 / 普通会话并列；GM、DM、worker 为子代理。点名字可改，点 ▼/▶ 折叠。'),
              roots.length === 0
                ? h('p', { style: text }, '（暂无会话）')
                : h('div', null,
                    h('div', { style: rowStyle },
                      h('button', {
                        type: 'button', style: buttonStyle, onClick: () => {
                          const next = {}
                          for (const id of allParentIds) next[id] = true
                          setCollapsedNodes(next)
                        }
                      }, '全部折叠'),
                      h('button', { type: 'button', style: buttonStyle, onClick: () => setCollapsedNodes({}) }, '全部展开')),
                    roots.map((node) => renderNode(node, 0))),
              presetDoc === ''
                ? null
                : h('div', { style: section },
                    h('strong', { style: text }, `预设：${presetDocTitle}`),
                    h('pre', { style: { ...text, whiteSpace: 'pre-wrap', fontFamily: 'inherit', marginTop: 6 } }, presetDoc)))
          }

          function renderAdvice() {
            return advice.length === 0
              ? h('p', { style: text }, '（暂无顾问建议）')
              : advice.map((item, index) =>
                  h('div', { key: String(item.id || index), style: cardStyle },
                    h('div', { style: text }, h('strong', null, String(item.subject || '')), h('span', { style: badge }, String(item.status || ''))),
                    h('div', { style: muted }, String(item.recommendation || '')),
                    item.status === 'pending'
                      ? h('div', { style: rowStyle },
                          h('button', { type: 'button', onClick: () => decideAdvice(item.id, 'accepted'), style: buttonStyle }, '采纳'),
                          h('button', { type: 'button', onClick: () => decideAdvice(item.id, 'rejected'), style: buttonStyle }, '不采纳'))
                      : null)
                )
          }

          const content =
            activeTab === 'memory' ? renderMemory()
            : activeTab === 'presets' ? renderPresets()
            : activeTab === 'org' ? renderOrg()
            : activeTab === 'advice' ? renderAdvice()
            : activeTab === 'taskboard' ? renderTaskboard()
            : renderConventions()

          return h('div', { className: 'office-console', style: { padding: '12px 16px', fontSize: 13, overflow: 'auto', height: '100%' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h('strong', { style: { fontSize: 15 } }, '秘书办公室'),
              projects.length === 0
                ? h('span', { style: muted }, loading ? '加载中…' : '（无项目）')
                : h('select', {
                    value: selected,
                    onChange: (event) => setSelected(event.target.value),
                    style: { font: 'inherit', fontSize: 12, padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', color: 'inherit' }
                  }, projects.map((item) => h('option', { key: String(item.id), value: String(item.id) }, `${item.id}（${item.turns || 0}）`))),
              h('button', { type: 'button', onClick: () => loadProjects(), style: buttonStyle }, loading ? '刷新中…' : '刷新')
            ),
            error === '' ? null : h('p', { style: { ...text, color: '#d9534f' } }, `加载失败：${error}`),
            message === '' ? null : h('p', { style: text }, message),
            h('div', { style: { display: 'flex', gap: 4, marginTop: 12, borderBottom: '1px solid rgba(128,128,128,0.35)' } },
              TABS.map(([id, label]) => h('button', {
                key: id, type: 'button', onClick: () => setActiveTab(id),
                'data-active': activeTab === id ? 'true' : 'false',
                style: { ...tabButtonStyle, ...(activeTab === id ? activeTabStyle : { opacity: 0.72 }) }
              }, label))
            ),
            h('div', { style: { marginTop: 10 } }, content),
            h('p', { style: { ...muted, marginTop: 16, fontSize: 11 } }, '数据来源：/office-console/api（宿主白名单代理 → secretary-core）')
          )
        }

        function OfficeIcon(props) {
          const size = props && typeof props.size === 'number' ? props.size : 16
          return h('span', { style: { fontSize: Math.max(10, Math.round(size * 0.78)), lineHeight: 1 }, 'aria-hidden': 'true' }, '📋')
        }

        return {
          inject: ['slots', 'locale', 'uiWorkspace'],
          apply(ctx) {
            workspaceApi = ctx.uiWorkspace || null
            ctx.locale.register('office', { zh: { title: '秘书办公室' }, en: { title: 'Secretary Office' } })
            const t = ctx.locale.bind('office')
            ctx.slots.inject('main', () => {
              ctx.slots.register({ name: 'main', key: 'office-console' }, OfficeConsole)
            })
            ctx.slots.inject('sidebar.panellist', () => {
              ctx.slots.register({ name: 'sidebar.panellist', id: 'office-console', label: () => t('title') }, OfficeIcon)
            })
          }
        }
      }
    })
  }

  if (typeof globalThis !== 'undefined' && globalThis.window) {
    install(globalThis.window.__ModuleLoader__)
  }
})()
