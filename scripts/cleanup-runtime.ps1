[CmdletBinding()]
param([switch]$DryRun, [string]$KeepGameDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'project-cleanup.psm1') -Force
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Read-Choice([string]$Prompt, [string[]]$Allowed, [string]$Default) {
    while ($true) {
        $answer = Read-Host $Prompt
        if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
        $answer = $answer.Trim().ToLowerInvariant()
        if ($answer -in $Allowed) { return $answer }
        Write-Host '输入无效，请按提示选择。'
    }
}

Write-Host '项目目录清理：保留最新对局，逐组确认删除范围' -ForegroundColor Cyan
Write-Host '源码、测试、正式资产、原始研究包、Git 历史不在清理范围。'
$node = (Get-Command node -ErrorAction Stop).Source
$json = & $node --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'list-local-games.mjs') $projectRoot
if ($LASTEXITCODE -ne 0) { throw '对局清单读取失败，未执行删除。' }
$inventory = $json | ConvertFrom-Json
$games = @($inventory.games)
if (!$games.Count) { throw '未找到可核验的对局，停止清理。请先检查运行目录。' }
if (@($inventory.errors).Count) {
    $inventory.errors | ForEach-Object { Write-Warning ("无法核验：{0}；{1}" -f $_.path, $_.error) }
    throw '部分运行目录无法核验，停止自动清理，避免把未知存档当历史删除。'
}
Write-Host "`n第 1 步：选择保留的完整对局（含 AI 私库、凭证和绑定）"
for ($i = 0; $i -lt $games.Count; $i++) {
    $game = $games[$i]
    $localActivity = if ($game.lastActivity) { [DateTimeOffset]::Parse($game.lastActivity).ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd HH:mm:ss zzz') } else { '未知' }
    Write-Host ('[{0}] {1} | tick {2} | 最后活动 {3}' -f ($i + 1), $game.relative, $game.tick, $localActivity)
    Write-Host ('    房间：' + $game.roomId)
}
if ($KeepGameDirectory) {
    $requested = if ([IO.Path]::IsPathRooted($KeepGameDirectory)) { [IO.Path]::GetFullPath($KeepGameDirectory) } else { [IO.Path]::GetFullPath((Join-Path $projectRoot $KeepGameDirectory)) }
    $selected = @($games | Where-Object { $_.directory -eq $requested -or $_.keepDirectory -eq $requested })
    if ($selected.Count -ne 1) { throw '指定保留目录不在已核验的对局清单中。' }
    $game = $selected[0]
} elseif ($DryRun) { $game = $games[0] }
else {
    $choice = Read-Choice '保留编号 [回车=1，q=退出]' (@('q') + @(1..$games.Count | ForEach-Object { [string]$_ })) '1'
    if ($choice -eq 'q') { return }
    $game = $games[[int]$choice - 1]
}
$protected = @($game.protectedDirectories)
$bindingsPath = Join-Path $game.directory 'controller-bindings.json'
if (Test-Path -LiteralPath $bindingsPath) {
    $bindings = Get-Content -LiteralPath $bindingsPath -Raw | ConvertFrom-Json
    if ($bindings.PSObject.Properties.Name -contains 'storeDirectory' -and $bindings.storeDirectory) {
        $protected += if ([IO.Path]::IsPathRooted($bindings.storeDirectory)) { [IO.Path]::GetFullPath($bindings.storeDirectory) } else { [IO.Path]::GetFullPath((Join-Path $projectRoot $bindings.storeDirectory)) }
    }
}
Write-Host ('始终保留：' + ($protected -join '；')) -ForegroundColor Green
Write-Host '扫描删除候选和大小，请稍候……'
$plan = @(Get-ProjectCleanupPlan $projectRoot $protected)
$descriptions = [ordered]@{
    '运行历史' = '删除其他对局、旧备份、阶段存档及运行临时数据；选中对局完整保留。'
    '报告与预览' = '删除 outputs、artifacts、临时截图、预览和根目录日志。'
    '构建产物' = '删除 dist 和网页打包文件；下次使用前运行 npm run web:build。'
    '研究派生产物' = '删除解包、格式化和验证输出；原始 APK 与来源文件保留，研究对照需重新提取。'
    '可重建依赖' = '删除 node_modules 和 .venv；之后需要 npm ci 或重新安装 Python 研究依赖。'
}
$step = 1
foreach ($group in $descriptions.Keys) {
    $step++
    $targets = @($plan | Where-Object { $_.Group -eq $group })
    Write-Host ("`n第 {0} 步：{1}" -f $step, $group) -ForegroundColor Cyan
    Write-Host $descriptions[$group]
    if (!$targets.Count) { Write-Host '没有可清理内容。'; continue }
    foreach ($target in $targets) { Write-Host ('  {0} | {1:N2} MiB | {2} 个文件，{3} 个链接' -f $target.Path, ($target.Bytes / 1MB), $target.Files, $target.Links) }
    Write-Host ('合计 {0} 项，{1:N2} GiB。' -f $targets.Count, (($targets | Measure-Object Bytes -Sum).Sum / 1GB))
    if ($DryRun) { Write-Host '预览模式：不删除、不结束进程、不写入报告。'; continue }
    $answer = Read-Choice '删除本组？[y=删除，n=跳过，s=逐项选择，q=退出；回车=跳过]' @('y','n','s','q') 'n'
    if ($answer -eq 'q') { break }
    if ($answer -eq 'n') { continue }
    if ($answer -eq 's') {
        $chosen = @()
        foreach ($target in $targets) {
            $itemAnswer = Read-Choice ('删除 {0}（{1:N2} MiB）？[y/n/q，回车=跳过]' -f $target.Path, ($target.Bytes / 1MB)) @('y','n','q') 'n'
            if ($itemAnswer -eq 'q') { return }
            if ($itemAnswer -eq 'y') { $chosen += $target }
        }
        $targets = @($chosen)
    }
    if (!$targets.Count) { continue }
    Test-CleanupServices
    $reportDirectory = Join-Path $projectRoot 'runtime/.cleanup'
    if (!(Test-Path -LiteralPath $reportDirectory)) { New-Item -ItemType Directory -Path $reportDirectory | Out-Null }
    $reportPath = Join-Path $reportDirectory ((Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.json')
    $results = @(Invoke-CleanupSelection $projectRoot $targets $protected $reportPath)
    Write-Host ('已删除 {0} 项；未完整删除 {1} 项。记录：{2}' -f @($results | Where-Object { $_.Status -eq '已删除' }).Count, @($results | Where-Object { $_.Status -ne '已删除' }).Count, $reportPath)
}
Write-Host "`n清理会话结束。保留对局：$($game.directory)"
