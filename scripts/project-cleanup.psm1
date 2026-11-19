Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-PathWithin([string]$Path, [string]$Parent) {
    $p = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $r = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    return $p.Equals($r, [StringComparison]::OrdinalIgnoreCase) -or $p.StartsWith($r + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-CleanupPath([string]$Root, [string]$Path) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($full.Equals($rootPath, [StringComparison]::OrdinalIgnoreCase) -or !(Test-PathWithin $full $rootPath)) { throw "清理路径越界或指向项目根目录：$full" }
    $cursor = Split-Path -Parent $full
    while (Test-PathWithin $cursor $rootPath) {
        if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "父目录是链接，拒绝清理：$cursor" }
        if ($cursor.Equals($rootPath, [StringComparison]::OrdinalIgnoreCase)) { break }
        $cursor = Split-Path -Parent $cursor
    }
    return $full
}

function Get-CleanupEntries([string]$Root, [string]$Path) {
    $full = Assert-CleanupPath $Root $Path
    if (!(Test-Path -LiteralPath $full)) { return }
    function Read-Tree($entry) {
        $entry
        if ($entry.PSIsContainer -and !($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            foreach ($child in Get-ChildItem -LiteralPath $entry.FullName -Force) { Read-Tree $child }
        }
    }
    Read-Tree (Get-Item -LiteralPath $full -Force)
}

function Get-CleanupTarget([string]$Root, [string]$Path, [string]$Group) {
    $entries = @(Get-CleanupEntries $Root $Path)
    if (!$entries.Count) { return }
    $files = @($entries | Where-Object { !$_.PSIsContainer -and !($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
    $bytes = 0L
    foreach ($file in $files) { $bytes += $file.Length }
    [pscustomobject]@{ Path = [IO.Path]::GetFullPath($Path); Group = $Group; Bytes = $bytes; Files = $files.Count; Links = @($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count }
}

function Get-ProjectCleanupPlan([string]$Root, [string[]]$ProtectedPaths) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    foreach ($marker in @('AGENTS.md', 'package.json', 'packages/server/src/main.ts')) { if (!(Test-Path -LiteralPath (Join-Path $rootPath $marker))) { throw "项目根目录核验失败：$marker" } }
    $protected = @($ProtectedPaths | ForEach-Object { Assert-CleanupPath $rootPath $_ })
    if (!$protected.Count) { throw '必须先选择要保留的对局，不能在缺少保留范围时清空运行目录。' }
    $protected += Join-Path $rootPath 'runtime/.cleanup'
    $tracked = @(& git -C $rootPath -c core.quotepath=false ls-files)
    if ($LASTEXITCODE -ne 0) { throw '无法读取 Git 跟踪清单。' }
    $targets = [Collections.Generic.List[object]]::new()
    function Add-Target([string]$Path, [string]$Group) {
        if (!(Test-Path -LiteralPath $Path)) { return }
        $full = Assert-CleanupPath $rootPath $Path
        if (@($protected | Where-Object { Test-PathWithin $full $_ }).Count) { return }
        if (@($protected | Where-Object { Test-PathWithin $_ $full }).Count) {
            foreach ($child in Get-ChildItem -LiteralPath $full -Force) { Add-Target $child.FullName $Group }
            return
        }
        $relative = $full.Substring($rootPath.Length + 1).Replace('\', '/')
        if (@($tracked | Where-Object { $_ -eq $relative -or $_.StartsWith($relative + '/', [StringComparison]::OrdinalIgnoreCase) }).Count) { throw "候选内容仍被 Git 跟踪，先从版本库清退：$relative" }
        $target = Get-CleanupTarget $rootPath $full $Group
        if ($null -ne $target) { $targets.Add($target) }
    }
    foreach ($name in @('runtime', 'runtime-lobby', 'runtime-rooms')) {
        $path = Join-Path $rootPath $name
        if (!(Test-Path -LiteralPath $path)) { continue }
        if ($name -eq 'runtime') { foreach ($child in Get-ChildItem -LiteralPath $path -Force) { Add-Target $child.FullName '运行历史' } }
        else { Add-Target $path '运行历史' }
    }
    foreach ($name in @('outputs', 'artifacts')) { Add-Target (Join-Path $rootPath $name) '报告与预览' }
    foreach ($entry in Get-ChildItem -LiteralPath $rootPath -Force) {
        if (($entry.PSIsContainer -and $entry.Name -like '.verify-*') -or (!$entry.PSIsContainer -and ($entry.Extension -in @('.log', '.err', '.tsbuildinfo') -or $entry.Name -match '^\.(ai-resume-.*\.json|ui-.*\.png|ai-.*-review\.png|map-fog-preview\.png|top-map-controls\.png)$'))) { Add-Target $entry.FullName '报告与预览' }
    }
    Add-Target (Join-Path $rootPath 'dist') '构建产物'
    foreach ($name in @('app.js', 'app.js.map', 'app.css', 'app.css.map', 'player.js', 'player.css', 'hall.js', 'hall.css', 'prediction-worker.js', 'fleet-arrival-worker.js', 'global-prediction-worker.js', 'lab-history-worker.js')) { Add-Target (Join-Path $rootPath ('packages/client/public/' + $name)) '构建产物' }
    foreach ($name in @('agent-console.js', 'agent-console.css')) { Add-Target (Join-Path $rootPath ('packages/client/agent-console-public/' + $name)) '构建产物' }
    foreach ($name in @('research/extracted', 'research/analysis', 'research/verification')) { Add-Target (Join-Path $rootPath $name) '研究派生产物' }
    foreach ($name in @('node_modules', '.venv')) { Add-Target (Join-Path $rootPath $name) '可重建依赖' }
    return $targets.ToArray()
}

function Remove-CleanupTarget([string]$Root, [string]$Path, [string[]]$ProtectedPaths) {
    $full = Assert-CleanupPath $Root $Path
    foreach ($protected in $ProtectedPaths) {
        if ((Test-PathWithin $full $protected) -or (Test-PathWithin $protected $full)) { throw "拒绝删除保留范围或其父目录：$full" }
    }
    if (!(Test-Path -LiteralPath $full)) { return }
    $entries = @(Get-CleanupEntries $Root $full)
    foreach ($link in @($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) {
        $linkPath = Assert-CleanupPath $Root $link.FullName
        # Delete the link itself without recursion, never its destination.
        if ($link.PSIsContainer) { [IO.Directory]::Delete($linkPath) } else { [IO.File]::Delete($linkPath) }
    }
    if (Test-Path -LiteralPath $full) {
        $full = Assert-CleanupPath $Root $full
        Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
    }
}

function Test-CleanupServices {
    $processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match '(?:scripts[/\\](?:dev-web|dev-agent)\.mjs|dist[/\\]packages[/\\](?:server[/\\](?:main|room-hub-main|game-server)\.js|ai[/\\]src[/\\]application[/\\]agent-cli\.js))' })
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(4310, 4311, 4312, 4400) })
    if ($processes.Count -or $listeners.Count) { throw '游戏或 AI 服务仍在运行（或常用端口被占用）。请先按正常流程暂停并关闭服务，再执行清理；本工具不会强制结束对局进程。' }
}

function Invoke-CleanupSelection([string]$Root, [object[]]$Targets, [string[]]$ProtectedPaths, [string]$ReportPath) {
    $results = [Collections.Generic.List[object]]::new()
    $index = 0
    foreach ($target in $Targets) {
        $index++
        if ($index % 25 -eq 1 -or $target.Bytes -ge 1GB) { Write-Host ('[{0}/{1}] 正在清理：{2}' -f $index, $Targets.Count, $target.Path) }
        try {
            $full = Assert-CleanupPath $Root $target.Path
            $relative = $full.Substring([IO.Path]::GetFullPath($Root).TrimEnd('\', '/').Length + 1).Replace('\', '/')
            $tracked = @(& git -C $Root -c core.quotepath=false ls-files -- $relative)
            if ($LASTEXITCODE -ne 0 -or $tracked.Count) { throw '该路径含 Git 跟踪文件，拒绝删除。' }
            Remove-CleanupTarget $Root $full $ProtectedPaths
            $results.Add([pscustomobject]@{ Path = $full; Status = '已删除'; Bytes = $target.Bytes })
        } catch {
            $results.Add([pscustomobject]@{ Path = $target.Path; Status = '未完整删除'; Error = $_.Exception.Message })
            Write-Warning ("未完整删除：{0}；{1}" -f $target.Path, $_.Exception.Message)
        }
        if ($ReportPath) { $results.ToArray() | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding UTF8 }
    }
    return $results.ToArray()
}

Export-ModuleMember -Function Test-PathWithin, Assert-CleanupPath, Get-CleanupEntries, Get-CleanupTarget, Get-ProjectCleanupPlan, Remove-CleanupTarget, Test-CleanupServices, Invoke-CleanupSelection
