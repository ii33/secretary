#!/usr/bin/env pwsh
<#
  一条命令验收 secretary-office（插件 + Python 核心）。

  用法：
      pwsh -File D:\secretary-office\scripts\check.ps1
      pwsh -File D:\secretary-office\scripts\check.ps1 -SkipStatic   # 只跑测试

  四道门：
      1. 静态门  —— client.js 必须能当**普通脚本**解析（顶层不许 export/import，上次因此整个应用起不来）；
                    pyproject.toml 必须是合法 TOML；四处版本号必须一致。
      2. 体检    —— core 的 doctor：python / sqlite / fts5 / 数据目录可写。
      3. 核心门  —— core/tests/test_smoke.py（8 个用例，自起隔离核心，不碰真实数据）。
      4. 契约门  —— plugin/test/*.test.mjs（15 个用例，含宿主适配器与代理）。

  退出码：0 = 全绿；1 = 有门失败。任何一门失败都会打印该门的输出尾部。
#>
param([switch]$SkipStatic)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$CoreDir = Join-Path $Root 'core'
$PluginDir = Join-Path $Root 'plugin'

function Find-Exe {
    param([string[]]$Patterns, [string]$FallbackName)
    foreach ($pattern in $Patterns) {
        $hit = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $FallbackName
}

$Node = Find-Exe -Patterns @(
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe')
) -FallbackName 'node'

$Python = Find-Exe -Patterns @(
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\*\dependencies\python\python.exe')
) -FallbackName 'python'

$results = [System.Collections.Generic.List[object]]::new()

function Step {
    param([string]$Name, [scriptblock]$Body)
    $started = Get-Date
    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    $ok = $false
    $output = ''
    try {
        $output = (& $Body 2>&1 | Out-String)
        $ok = $true
    } catch {
        $output = ($_ | Out-String)
        $ok = $false
    }
    $ms = [int]((Get-Date) - $started).TotalMilliseconds
    if ($ok) {
        Write-Host ("  PASS  ({0} ms)" -f $ms) -ForegroundColor Green
    } else {
        Write-Host ("  FAIL  ({0} ms)" -f $ms) -ForegroundColor Red
        ($output -split "`n" | Select-Object -Last 25) | ForEach-Object { Write-Host "    $_" }
    }
    $results.Add([pscustomobject]@{ Step = $Name; Ok = $ok; Ms = $ms })
}

Write-Host "node    = $Node"
Write-Host "python  = $Python"
Write-Host "root    = $Root"

# ---------------------------------------------------------------- 1. 静态门
if (-not $SkipStatic) {
    Step '1a. client.js 可作普通脚本（防 web boot SyntaxError）' {
        $script = @"
const vm = require('node:vm'), fs = require('node:fs');
const src = fs.readFileSync(String.raw``$($PluginDir)\client.js``, 'utf8');
const exports = (src.match(/^\s*export\b/mg) || []).length;
const imports = (src.match(/^\s*import\b/mg) || []).length;
if (exports > 0 || imports > 0) throw new Error('顶层 export=' + exports + ' import=' + imports + '（必须为 0）');
new vm.Script(src);
console.log('ok: 顶层 export=0 import=0，解析通过');
"@
        & $Node -e $script
        if ($LASTEXITCODE -ne 0) { throw 'client.js 静态检查失败' }
    }

    Step '1b. pyproject.toml 合法 + 版本四处一致' {
        $script = @"
import json, pathlib, sys, tomllib
root = pathlib.Path(r'$Root')
pyproject = tomllib.load(open(root / 'core' / 'pyproject.toml', 'rb'))
versions = {
    'plugin/package.json': json.load(open(root / 'plugin' / 'package.json', encoding='utf-8'))['version'],
    'core/pyproject.toml': pyproject['project']['version'],
}
init_text = (root / 'core' / 'secretary_core' / '__init__.py').read_text(encoding='utf-8')
for line in init_text.splitlines():
    if line.startswith('__version__'):
        versions['core/__init__.py'] = line.split('=', 1)[1].strip().strip('"\'')
        break
unique = set(versions.values())
for name, value in versions.items():
    print('  {0:24} {1}'.format(name, value))
if len(unique) != 1:
    raise SystemExit('版本号不一致：' + repr(versions))
print('ok:', unique.pop())
"@
        & $Python -X utf8 -c $script
        if ($LASTEXITCODE -ne 0) { throw '版本或 TOML 检查失败' }
    }
}

# ---------------------------------------------------------------- 2. 体检
Step '2. doctor（python / sqlite / fts5 / 数据目录）' {
    $script = @"
import sys
sys.path.insert(0, r'$CoreDir')
from secretary_core import cli
code = cli.main(['doctor'])
sys.exit(code)
"@
    $out = & $Python -X utf8 -c $script
    $out | ForEach-Object { Write-Host "    $_" }
    $text = ($out | Out-String)
    if ($text -notmatch 'fts5:\s*ok') { throw 'doctor: fts5 不可用' }
    if ($text -notmatch 'writable:\s*yes') { throw 'doctor: 数据目录不可写' }
    if ($LASTEXITCODE -ne 0) { throw 'doctor 返回非零' }
}

# ---------------------------------------------------------------- 3. 核心门
Step '3. 核心冒烟（core/tests/test_smoke.py）' {
    Push-Location $CoreDir
    try {
        $out = & $Python -X utf8 'tests\test_smoke.py' 2>&1
        $code = $LASTEXITCODE
        $out | Select-Object -Last 6 | ForEach-Object { Write-Host "    $_" }
        if ($code -ne 0) { throw "test_smoke.py 退出码 $code" }
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------- 4. 契约门
Step '4. Node 契约测试（plugin/test/*.test.mjs）' {
    Push-Location $PluginDir
    try {
        $files = Get-ChildItem (Join-Path $PluginDir 'test') -Filter '*.test.mjs' |
            ForEach-Object { "test/$($_.Name)" }
        $out = & $Node --test @files 2>&1
        $code = $LASTEXITCODE
        $out | Select-String -Pattern '^(ℹ (tests|pass|fail)|✖)' | ForEach-Object { Write-Host "    $($_.Line)" }
        if ($code -ne 0) { throw "Node 契约测试退出码 $code" }
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------- 汇总
Write-Host "`n================ 汇总 ================" -ForegroundColor Cyan
$results | ForEach-Object {
    $color = if ($_.Ok) { 'Green' } else { 'Red' }
    Write-Host ("  {0,-46} {1,-6} {2,6} ms" -f $_.Step, $(if ($_.Ok) { 'PASS' } else { 'FAIL' }), $_.Ms) -ForegroundColor $color
}
$failed = @($results | Where-Object { -not $_.Ok })
if ($failed.Count -eq 0) {
    Write-Host "`n结果：全绿（$($results.Count)/$($results.Count)）" -ForegroundColor Green
    exit 0
}
Write-Host "`n结果：$($failed.Count) 门失败 / 共 $($results.Count)" -ForegroundColor Red
exit 1
