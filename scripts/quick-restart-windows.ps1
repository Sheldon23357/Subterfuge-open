param(
  [Parameter(Mandatory=$true)][ValidateSet('discover','stop','start')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Config
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$taskConfig=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Config)) | ConvertFrom-Json
$taskRoot=[IO.Path]::GetFullPath($taskConfig.root).TrimEnd('\','/')
function FullPath([string]$Path) {
  if([IO.Path]::IsPathRooted($Path)){return [IO.Path]::GetFullPath($Path)}
  return [IO.Path]::GetFullPath((Join-Path $taskRoot $Path))
}
function ArgsOf([string]$Line) {
  # Our entry points reject embedded quotes/control characters, so ordinary Windows
  # quoted paths suffice here. Do not turn these strings into shell commands.
  return @([regex]::Matches($Line,'"([^"\r\n]*)"|([^\s"]+)') | ForEach-Object {
    if($_.Groups[1].Success){$_.Groups[1].Value}else{$_.Groups[2].Value}
  })
}
function Identity($Process) {
  return @{pid=[int]$Process.ProcessId;created=$Process.CreationDate.ToUniversalTime().ToString('o');command=$Process.CommandLine}
}
if($Action -eq 'discover') {
  $taskAll=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")
  $taskListeners=@(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in $taskConfig.ports})
  $taskFound=@{}
  foreach($taskStage in @('game','agent')) {
    $taskPort=if($taskStage -eq 'game'){$taskConfig.ports[0]}else{$taskConfig.ports[2]}
    $taskOwners=@($taskListeners | Where-Object {$_.LocalPort -eq $taskPort} | Select-Object -ExpandProperty OwningProcess -Unique)
    if($taskOwners.Count -ne 1){throw "Expected one listener on $taskPort"}
    $taskChild=@($taskAll | Where-Object {$_.ProcessId -eq $taskOwners[0]})
    if($taskChild.Count -ne 1){throw 'Listener is not a visible Node process'}
    $taskChild=$taskChild[0];$taskChildArgs=ArgsOf $taskChild.CommandLine
    $taskEntry=if($taskStage -eq 'game'){'dist/packages/server/src/main.js'}else{'dist/packages/ai/src/application/agent-cli.js'}
    if($taskChildArgs.Count -lt 2 -or (FullPath $taskChildArgs[1]) -ne (FullPath $taskEntry)){throw "Unexpected $taskStage listener entry"}
    $taskParent=@($taskAll | Where-Object {$_.ProcessId -eq $taskChild.ParentProcessId})
    if($taskParent.Count -ne 1){throw 'Expected a development supervisor'}
    $taskParent=$taskParent[0];$taskArgs=ArgsOf $taskParent.CommandLine
    if($taskArgs.Count -lt 2 -or (FullPath $taskArgs[1]) -ne (FullPath "scripts/dev-$($taskStage -replace 'game','web').mjs")){throw 'Unexpected supervisor'}
    if($taskArgs | Where-Object {$_ -match '[\r\n"]|--(?:api-key|token|secret)'}){throw 'Unsupported or secret-bearing launch arguments'}
    $taskFound[$taskStage]=@{child=(Identity $taskChild);parent=(Identity $taskParent);args=@($taskArgs | Select-Object -Skip 1);executable=$taskParent.ExecutablePath}
  }
  if(@($taskListeners | Where-Object {$_.LocalPort -eq $taskConfig.ports[1] -and $_.OwningProcess -eq $taskFound.game.child.pid}).Count -eq 0){throw 'Player port is not owned by the game process'}
  $taskFound | ConvertTo-Json -Depth 8 -Compress
  exit
}
if($Action -eq 'stop') {
  # Validate every identity before the first mutation; recheck again immediately
  # before stopping to guard against PID reuse. Parents first, then listeners.
  $taskTargets=@($taskConfig.processes.agent.parent,$taskConfig.processes.game.parent,$taskConfig.processes.agent.child,$taskConfig.processes.game.child)
  foreach($taskTarget in $taskTargets) {
    $taskLive=Get-CimInstance Win32_Process -Filter "ProcessId = $($taskTarget.pid)"
    if(!$taskLive -or $taskLive.CommandLine -cne $taskTarget.command -or $taskLive.CreationDate.ToUniversalTime().ToString('o') -ne $taskTarget.created){throw 'Process identity changed; rediscover before stopping'}
  }
  foreach($taskTarget in $taskTargets) {
    $taskLive=Get-CimInstance Win32_Process -Filter "ProcessId = $($taskTarget.pid)"
    if(!$taskLive){continue}
    if($taskLive.CommandLine -cne $taskTarget.command -or $taskLive.CreationDate.ToUniversalTime().ToString('o') -ne $taskTarget.created){throw 'PID reused; refusing stop'}
    Stop-Process -Id $taskTarget.pid -Force
  }
  @{stopped=$true} | ConvertTo-Json -Compress
  exit
}
foreach($taskKey in $taskConfig.environment.PSObject.Properties) {
  [Environment]::SetEnvironmentVariable($taskKey.Name,[string]$taskKey.Value,'Process')
}
$taskLaunch=$taskConfig.processes.($taskConfig.stage)
$taskQuoted=@($taskLaunch.args | ForEach-Object {
  if($_ -match '["\r\n]' -or $_.EndsWith('\')){throw 'Unsupported launch argument'}
  '"'+$_+'"'
}) -join ' '
$taskStarted=Start-Process -FilePath $taskLaunch.executable -ArgumentList $taskQuoted -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $taskConfig.stdout -RedirectStandardError $taskConfig.stderr -PassThru
@{pid=$taskStarted.Id;stage=$taskConfig.stage} | ConvertTo-Json -Compress
