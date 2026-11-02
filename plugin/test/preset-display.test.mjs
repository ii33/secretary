import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const renderSource = source.slice(source.indexOf('          function renderPresets()'), source.indexOf('          function renderOrg()'))
function render(presets, presetError = '') {
  const h = (tag, props, ...children) => ({tag, props, children})
  const run = new Function('h', 'presets', 'presetError', `
    const section={},text={},muted={},cardStyle={},buttonStyle={},rowStyle={},badge={};
    const globalPresets=[]; const getJSON=()=>{}; const API=""; const fail=()=>{}; const importOpen=false,projectPresets=[],rolePolicies=[],exportContent='';
    const setImportOpen=()=>{},importPreset=()=>{},setExportContent=()=>{},removeProjectPreset=()=>{};
    ${renderSource}
    return renderPresets();`)
  return JSON.stringify(run(h, presets, presetError))
}
test('builtins remain visible with import panel closed and no project presets', () => {
  const result = render([{id:'es',installed:true},{id:'gm',installed:false},{id:'dm',broken:'tool unavailable'}])
  for (const text of ['插件内置预设（3）','es — 执行秘书','gm — 总经理','dm — 部门经理','已加载','未注册','加载失败：tool unavailable']) assert.ok(result.includes(text), text)
})
test('preset fetch failure is visible', () => {
  assert.ok(render([], 'registry unavailable').includes('预设读取失败：registry unavailable'))
})
