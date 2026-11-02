import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const source=readFileSync(new URL('../client.js',import.meta.url),'utf8')
const start=source.indexOf('          const flat =')
const end=source.indexOf('          function renderFlatOverview()',start)
const tabs=new Function('architectureDraft','selected',source.slice(start,end)+';return panelTabs')
test('tree and flat have independent navigation',()=>{
 const tree=tabs({project:'a',mode:'tree'},'a').map(t=>t[0])
 const flat=tabs({project:'a',mode:'flat'},'a').map(t=>t[0])
 assert.ok(tree.includes('advice'));assert.ok(!flat.includes('advice'))
 for(const tab of ['rounds','messages']){assert.ok(flat.includes(tab));assert.ok(!tree.includes(tab))}
 for(const tab of ['org','presets','taskboard','conventions']){assert.ok(tree.includes(tab));assert.ok(flat.includes(tab))}
})
test('previous project configuration cannot select the new project flat panel',()=>{
 assert.ok(!tabs({project:'a',mode:'flat'},'b').some(t=>t[0]==='messages'))
})
