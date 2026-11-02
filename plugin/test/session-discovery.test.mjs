import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const source=readFileSync(new URL('../index.js',import.meta.url),'utf8')
const start=source.indexOf('async function buildOrgTree(')
const end=source.indexOf('function dumpOrgDebug',start)
const build=new Function('readArchivedSessionIds','isArchivedId','projectForCwd','pickSessionTitle',source.slice(start,end)+';return buildOrgTree')(()=>new Set(),()=>false,cwd=>cwd==='C:/test'?'test':'other',snapshot=>snapshot.events?.find(e=>e.type==='session/title')?.data.title || '')
const header={id:'empty',cwd:'C:/test',agentPreset:'standard',delegationDepth:0}
test('empty newly created top-level sessions appear, other projects do not',async()=>{
 const ctx={get:()=>({listSessions:async()=>[{header},{header:{...header,id:'foreign',cwd:'C:/other'}}],readSession:async id=>({session:id==='empty'?header:{...header,cwd:'C:/other'},events:[]})})}
 const tree=await build(ctx,'test');assert.deepEqual(tree.map(n=>n.id),['empty']);assert.equal(tree[0].preset,'standard')
})
test('missing session service reports an error instead of an empty tree',async()=>{
 await assert.rejects(build({get:()=>undefined},'test'),/sessionQuery/)
})

test('organization does not replay conversation logs, including unrelated or broken sessions',async()=>{
 let replays=0,titles=0
 const ctx={get:()=>({listSessions:async()=>[{header},{header:{...header,id:'foreign',cwd:'C:/other'}}],readSession:async()=>{replays++;throw Error('replay failed')},readTitle:async()=>{titles++;return {title:'分析插件与内置工具差异'}}})}
 const tree=await build(ctx,'test')
 assert.equal(replays,0);assert.equal(titles,1);assert.equal(tree[0].title,'分析插件与内置工具差异')
})
