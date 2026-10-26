#requires -Version 7.0
<#
  The tray companion: one icon for the running instance.

  `dsh-upgrade tray` starts this script and passes every path it needs, so the script never
  guesses where the tool, the configuration, or node lives. All work is done by the CLI in a
  child process: the tray only decides *when* to call it and how to report the result.

  Long actions (stage, apply, rollback) run as background processes and are reported when they
  finish, so the icon keeps answering while a build runs. The one action that must leave the
  tool's process tree is the build on a machine whose protection driver refuses a child
  process the right to delete a large temporary file: that build runs in an elevated console
  and the tray finishes the stage with `stage --resume`.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string] $ToolRoot,
  [Parameter(Mandatory)][string] $Cli,
  [Parameter(Mandatory)][string] $ConfigPath,
  [Parameter(Mandatory)][string] $Node
)

$ErrorActionPreference = 'Stop'
# A tray has no console: a terminating error before the message loop would otherwise vanish.
trap {
  try { [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'DeepSeek Harness') | Out-Null } catch { }
  exit 1
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$mutex = [System.Threading.Mutex]::new($false, 'Local\dsh-upgrade-tray')
if (-not $mutex.WaitOne(0)) {
  [System.Windows.Forms.MessageBox]::Show('托盘已经在运行。', 'DeepSeek Harness') | Out-Null
  exit 0
}

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$root = [string]$config.root
$webPort = if ($null -ne $config.webPort) { [int]$config.webPort } else { 3080 }
$url = "http://127.0.0.1:$webPort"
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-upgrade-tray'
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

$script:job = $null
$script:notify = $null

function Show-Balloon {
  param(
    [string] $Text,
    [string] $Title = 'DeepSeek Harness',
    [System.Windows.Forms.ToolTipIcon] $Icon = [System.Windows.Forms.ToolTipIcon]::Info
  )
  if ($Text.Length -gt 250) { $Text = $Text.Substring(0, 247) + '…' }
  $script:notify.ShowBalloonTip(8000, $Title, $Text, $Icon)
}

function ConvertFrom-CliJson {
  param([string] $Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
  foreach ($line in ($Text -split "`r?`n")) {
    $trimmed = $line.TrimStart()
    if ($trimmed.StartsWith('{')) {
      try { return $trimmed | ConvertFrom-Json } catch { continue }
    }
  }
  return $null
}

function Get-FailureText {
  param($Result)
  $text = ((@($Result.Err, $Result.Out) | Where-Object { $_ }) -join "`n").Trim()
  if ($text -eq '') { return "退出码 $($Result.ExitCode)" }
  $lines = @($text -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
  $tail = @($lines | Select-Object -Last 3)
  return $tail -join ' / '
}

function ConvertTo-Argument {
  param([string] $Value)
  # Start-Process joins its argument list with spaces and does not quote the elements, so a
  # path like C:\Program Files\nodejs\node.exe must be quoted here or it arrives as two.
  if ($Value -eq '') { return '""' }
  if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
  return $Value
}

function Invoke-CliSync {
  param([string[]] $Arguments, [int] $TimeoutSeconds = 120)
  $stamp = [guid]::NewGuid().ToString('n')
  $outFile = Join-Path $tempDir "$stamp.out"
  $errFile = Join-Path $tempDir "$stamp.err"
  $process = Start-Process -FilePath $Node -ArgumentList (@($Cli, '--config', $ConfigPath) + $Arguments | ForEach-Object { ConvertTo-Argument $_ }) -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    try { $process.Kill($true) } catch { }
    return [pscustomobject]@{ ExitCode = -1; Out = ''; Err = "超过 $TimeoutSeconds 秒没有结束" }
  }
  $out = ''; $err = ''
  if (Test-Path -LiteralPath $outFile) { $out = Get-Content -LiteralPath $outFile -Raw }
  if (Test-Path -LiteralPath $errFile) { $err = Get-Content -LiteralPath $errFile -Raw }
  return [pscustomobject]@{ ExitCode = $process.ExitCode; Out = $out; Err = $err }
}

function Read-Status {
  $result = Invoke-CliSync -Arguments @('status', '--json') -TimeoutSeconds 60
  if ($result.ExitCode -ne 0) { return $null }
  return ConvertFrom-CliJson $result.Out
}

function Set-MenuState {
  $busy = $null -ne $script:job
  foreach ($item in @($script:upgradeItem, $script:rollbackItem, $script:checkItem)) {
    if ($null -ne $item) { $item.Enabled = -not $busy }
  }
  if ($busy) {
    $script:statusItem.Text = "正在$($script:job.Label)…"
  } else {
    $script:statusItem.Text = '就绪'
  }
}

function Update-Status {
  $status = Read-Status
  if ($null -eq $status) {
    $script:notify.Text = 'DeepSeek Harness · 读取状态失败'
    $script:openItem.Text = '打开 DSH'
    return
  }
  $tag = '未部署'
  if ($null -ne $status.deployed) { $tag = [string]$status.deployed.tag }
  $slot = '-'
  if ($null -ne $status.deployed) { $slot = [string]$status.deployed.slot }
  $checked = '从未'
  if ($null -ne $status.lastCheck) {
    try { $checked = ([datetime]$status.lastCheck).ToLocalTime().ToString('MM-dd HH:mm') } catch { $checked = '未知' }
  }
  $text = "dsh $tag · 槽 $slot · 检查 $checked"
  if ($null -ne $status.staged -and $null -ne $status.staged.tag) {
    $text = "$text · 已准备 $([string]$status.staged.tag)"
  }
  if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
  $script:notify.Text = $text
  $script:openItem.Text = "打开 DSH（$tag）"
  $script:errorItem.Text = if ($null -ne $status.lastError) { "上次错误：$([string]$status.lastError)" } else { '' }
  $script:errorItem.Visible = $null -ne $status.lastError
}

function Start-CliJob {
  param([string] $Kind, [string[]] $Arguments, [string] $Label)
  if ($null -ne $script:job) { Show-Balloon '另一项操作还在进行，请稍候。' -Icon Warning; return }
  $stamp = [guid]::NewGuid().ToString('n')
  $outFile = Join-Path $tempDir "$stamp.out"
  $errFile = Join-Path $tempDir "$stamp.err"
  $process = Start-Process -FilePath $Node -ArgumentList (@($Cli, '--config', $ConfigPath) + $Arguments | ForEach-Object { ConvertTo-Argument $_ }) -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  $script:job = [pscustomobject]@{ Kind = $Kind; Label = $Label; Process = $process; Out = $outFile; Err = $errFile }
  Set-MenuState
  Show-Balloon "$Label 已开始，完成后会提示。"
}

function Start-ElevatedBuild {
  param([string] $Slot, [string] $Tag)
  $slotPath = Join-Path (Join-Path $root 'dsh-slots') $Slot
  $quote = { param([string] $Value) "'" + $Value.Replace("'", "''") + "'" }
  $scriptPath = Join-Path $tempDir ("build-" + [guid]::NewGuid().ToString('n') + '.ps1')
  $lines = @(
    '$ErrorActionPreference = "Stop"'
    "Set-Location -LiteralPath $(& $quote $slotPath)"
    "Write-Host `"构建 $Tag（槽 $Slot）…`""
    'pnpm run build'
    'if ($LASTEXITCODE -ne 0) { Write-Host "构建失败，退出码 $LASTEXITCODE"; Read-Host "按 Enter 关闭"; exit 1 }'
    "& $(& $quote $Node) $(& $quote $Cli) stage --resume"
    'if ($LASTEXITCODE -ne 0) { Write-Host "收尾失败，退出码 $LASTEXITCODE"; Read-Host "按 Enter 关闭"; exit 1 }'
    'Write-Host "构建完成，可以回到托盘继续切换。"'
    'Read-Host "按 Enter 关闭"'
  )
  Set-Content -LiteralPath $scriptPath -Value ($lines -join "`r`n") -Encoding utf8
  $process = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (ConvertTo-Argument $scriptPath)) `
    -Verb RunAs -PassThru
  $script:job = [pscustomobject]@{ Kind = 'build'; Label = '管理员构建'; Process = $process; Out = $null; Err = $null }
  Set-MenuState
}

function Complete-Job {
  param($Job)
  $exit = $Job.Process.ExitCode
  $out = ''
  $err = ''
  if ($null -ne $Job.Out) {
    if (Test-Path -LiteralPath $Job.Out) { $out = Get-Content -LiteralPath $Job.Out -Raw }
    if (Test-Path -LiteralPath $Job.Err) { $err = Get-Content -LiteralPath $Job.Err -Raw }
  }

  switch ($Job.Kind) {
    'check' {
      $report = ConvertFrom-CliJson $out
      if ($exit -ne 0 -or $null -eq $report) {
        Show-Balloon "检查失败：$(Get-FailureText ([pscustomobject]@{ ExitCode = $exit; Out = $out; Err = $err }))" -Icon Warning
      } elseif ($report.newer) {
        Show-Balloon "发现新版本 $([string]$report.latest)（当前 $([string]$report.current)）。点“立即升级”开始。"
      } else {
        Show-Balloon "已是最新版本 $([string]$report.current)。"
      }
    }
    'stage' {
      if ($exit -eq 0) {
        $report = ConvertFrom-CliJson $out
        Show-Balloon "已准备 $([string]$report.tag)，现在切换到它。"
        Start-CliJob -Kind 'apply' -Arguments @('apply', '--json') -Label '切换'
      } else {
        $requestPath = Join-Path (Join-Path $root 'state') 'build-request.json'
        if ($exit -eq 3 -and (Test-Path -LiteralPath $requestPath)) {
          # A modal prompt from a timer tick has no owner window and stops the job poller, so the
          # build it asks about could never start. Offer it as a menu entry instead.
          $request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
          $script:pendingBuild = $request
          $script:buildItem.Text = "以管理员身份构建 $([string]$request.tag)"
          $script:buildItem.Visible = $true
          $script:buildItem.Enabled = $true
          Show-Balloon "这台机器只能在管理员控制台构建 $([string]$request.tag)；右键图标选“以管理员身份构建”。" -Icon Warning
        } else {
          Show-Balloon "准备失败：$(Get-FailureText ([pscustomobject]@{ ExitCode = $exit; Out = $out; Err = $err }))" -Icon Error
        }
      }
    }
    'build' {
      if ($exit -eq 0) {
        $status = Read-Status
        if ($null -ne $status -and $null -ne $status.staged) {
          Show-Balloon "已准备 $([string]$status.staged.tag)，现在切换到它。"
          Start-CliJob -Kind 'apply' -Arguments @('apply', '--json') -Label '切换'
        } else {
          Show-Balloon '构建结束，但没有可切换的版本。请再试一次“立即升级”。' -Icon Warning
        }
      } else {
        Show-Balloon '管理员构建没有成功，请查看那个窗口里的输出。' -Icon Error
      }
    }
    'apply' {
      if ($exit -eq 0) {
        Show-Balloon '已切换，服务正在重启。'
        Start-Sleep -Milliseconds 300
        $script:refreshTimer.Start()
      } else {
        Show-Balloon "切换失败：$(Get-FailureText ([pscustomobject]@{ ExitCode = $exit; Out = $out; Err = $err }))" -Icon Error
      }
    }
    'rollback' {
      if ($exit -eq 0) {
        Show-Balloon '已回滚，服务正在重启。'
        $script:refreshTimer.Start()
      } else {
        Show-Balloon "回滚失败：$(Get-FailureText ([pscustomobject]@{ ExitCode = $exit; Out = $out; Err = $err }))" -Icon Error
      }
    }
    default {
      Show-Balloon "$($Job.Label) 结束（退出码 $exit）。"
    }
  }
  Update-Status
  Set-MenuState
}

function Step-Job {
  if ($null -eq $script:job) { return }
  $process = $script:job.Process
  try { $process.Refresh() } catch { }
  if (-not $process.HasExited) { return }
  $job = $script:job
  $script:job = $null
  try {
    Complete-Job -Job $job
  } catch {
    Show-Balloon "处理结果时出错：$($_.Exception.Message)" -Icon Error
    Update-Status
    Set-MenuState
  }
}

function Invoke-OpenDashboard {
  Start-Process -FilePath $url | Out-Null
}

function Invoke-OpenFolder {
  param([string] $Path)
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
  Start-Process -FilePath 'explorer.exe' -ArgumentList @((ConvertTo-Argument $Path)) | Out-Null
}

function Invoke-Check {
  Start-CliJob -Kind 'check' -Arguments @('check', '--json') -Label '检查更新'
}

function Invoke-Upgrade {
  $answer = [System.Windows.Forms.MessageBox]::Show(
    '现在升级吗？切换期间服务会重启几秒。', 'DeepSeek Harness', 'YesNo', 'Question')
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
  $status = Read-Status
  if ($null -ne $status -and $null -ne $status.staged) {
    Start-CliJob -Kind 'apply' -Arguments @('apply', '--json') -Label '切换'
  } else {
    Start-CliJob -Kind 'stage' -Arguments @('stage', '--json') -Label '准备新版本'
  }
}

function Invoke-Rollback {
  $answer = [System.Windows.Forms.MessageBox]::Show(
    '回滚到上一个版本吗？服务会重启几秒。', 'DeepSeek Harness', 'YesNo', 'Question')
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
  Start-CliJob -Kind 'rollback' -Arguments @('rollback', '--json') -Label '回滚'
}

function Invoke-Quit {
  if ($null -ne $script:job) {
    $answer = [System.Windows.Forms.MessageBox]::Show(
      "还有操作在进行（$($script:job.Label)）。现在退出托盘不会中断它，继续吗？",
      'DeepSeek Harness', 'YesNo', 'Warning')
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
  }
  $script:notify.Visible = $false
  $script:notify.Dispose()
  [System.Windows.Forms.Application]::ExitThread()
}

$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$script:openItem = [System.Windows.Forms.ToolStripMenuItem]::new('打开 DSH')
$script:openItem.Font = [System.Drawing.Font]::new($script:openItem.Font, [System.Drawing.FontStyle]::Bold)
$script:openItem.add_Click({ Invoke-OpenDashboard })
$script:checkItem = [System.Windows.Forms.ToolStripMenuItem]::new('检查更新')
$script:checkItem.add_Click({ Invoke-Check })
$script:upgradeItem = [System.Windows.Forms.ToolStripMenuItem]::new('立即升级')
$script:upgradeItem.add_Click({ Invoke-Upgrade })
$script:rollbackItem = [System.Windows.Forms.ToolStripMenuItem]::new('回滚')
$script:rollbackItem.add_Click({ Invoke-Rollback })
$script:statusItem = [System.Windows.Forms.ToolStripMenuItem]::new('就绪')
$script:statusItem.Enabled = $false
$script:errorItem = [System.Windows.Forms.ToolStripMenuItem]::new('')
$script:errorItem.Enabled = $false
$script:errorItem.Visible = $false
$script:pendingBuild = $null
$script:buildItem = [System.Windows.Forms.ToolStripMenuItem]::new('以管理员身份构建')
$script:buildItem.Visible = $false
$script:buildItem.add_Click({
  if ($null -eq $script:pendingBuild) { return }
  $request = $script:pendingBuild
  $script:pendingBuild = $null
  $script:buildItem.Visible = $false
  $script:buildItem.Enabled = $false
  Start-ElevatedBuild -Slot ([string]$request.slot) -Tag ([string]$request.tag)
})

[void]$menu.Items.Add($script:openItem)
[void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
[void]$menu.Items.Add($script:statusItem)
[void]$menu.Items.Add($script:errorItem)
[void]$menu.Items.Add($script:buildItem)
[void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
[void]$menu.Items.Add($script:checkItem)
[void]$menu.Items.Add($script:upgradeItem)
[void]$menu.Items.Add($script:rollbackItem)
[void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
$logItem = [System.Windows.Forms.ToolStripMenuItem]::new('日志文件夹')
$logItem.add_Click({ Invoke-OpenFolder -Path (Join-Path $root 'logs') })
[void]$menu.Items.Add($logItem)
$dataItem = [System.Windows.Forms.ToolStripMenuItem]::new('打开数据文件夹')
$dataItem.add_Click({ Invoke-OpenFolder -Path $root })
[void]$menu.Items.Add($dataItem)
[void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
$quitItem = [System.Windows.Forms.ToolStripMenuItem]::new('退出')
$quitItem.add_Click({ Invoke-Quit })
[void]$menu.Items.Add($quitItem)
# No $menu.add_Opening handler: it would run the CLI synchronously and freeze the message loop.
# The tooltip is refreshed by the timer and after every action instead.

$script:notify = [System.Windows.Forms.NotifyIcon]::new()
$script:notify.Icon = [System.Drawing.SystemIcons]::Application
$script:notify.Text = 'DeepSeek Harness'
$script:notify.ContextMenuStrip = $menu
$script:notify.add_MouseDoubleClick({ Invoke-OpenDashboard })
$script:notify.Visible = $true

$script:jobTimer = [System.Windows.Forms.Timer]::new()
$script:jobTimer.Interval = 1000
$script:jobTimer.add_Tick({ Step-Job })
$script:jobTimer.Start()

$script:refreshTimer = [System.Windows.Forms.Timer]::new()
$script:refreshTimer.Interval = 15000
$script:refreshTimer.add_Tick({
  $script:refreshTimer.Stop()
  Update-Status
})

$context = [System.Windows.Forms.ApplicationContext]::new()
[System.Windows.Forms.Application]::add_ApplicationExit({
  $script:notify.Visible = $false
})
Update-Status
try {
  [System.Windows.Forms.Application]::Run($context)
} finally {
  $script:jobTimer.Stop()
  $script:refreshTimer.Stop()
  $script:notify.Dispose()
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
