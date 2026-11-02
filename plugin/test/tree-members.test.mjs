import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const source=readFileSync(new URL('../client.js',import.meta.url),'utf8')
const start=source.indexOf('          function renderOrg()')
const end=source.indexOf('          const flat =',start)
const render=new Function('architectureDraft',`
 const h=(tag,props,...children)=>({tag,children});const muted={},cardStyle={},presets=[];
 const setArchitectureDraft=()=>{},setActiveTab=()=>{},setMessage=()=>{},selected='p';
 const renderFlatOverview=()=>h('div',null,'自动成员'); const renderOrgTree=()=>h('div',null,'识别的会话树');
 ${source.slice(start,end)}
 return JSON.stringify(renderOrg());`)
test('membership is automatic in both panels',()=>{
 const tree=render({mode:'tree',members:[]})
 assert.ok(tree.includes('识别的会话树'));assert.ok(tree.includes('无需手动添加'))
 assert.ok(!tree.includes('添加成员'));assert.ok(!tree.includes('session_id'))
 assert.ok(!render({mode:'flat',members:[]}).includes('添加成员'))
})
