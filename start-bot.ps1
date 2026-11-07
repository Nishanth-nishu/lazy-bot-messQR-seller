# Keeps the mess bot running in its own window, independent of any editor or app:
# if the bot stops or crashes, it is restarted after 30 seconds. Output goes to
# the window and to logs\bot-YYYY-MM-DD.log. Close the window (or Ctrl+C) to stop it.

$ErrorActionPreference = 'Continue'

# Only one copy may run: two bots on the same WhatsApp session would fight each other.
$mutex = New-Object System.Threading.Mutex($false, 'Global\MessQrBotLauncher')
if (-not $mutex.WaitOne(0)) { Write-Host 'Mess QR bot is already running in another window.'; Start-Sleep -Seconds 5; exit }
$mainJs = Join-Path $PSScriptRoot 'main.js'
$running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($mainJs) }
if ($running) { Write-Host "Mess QR bot is already running (node PID $($running.ProcessId -join ', '))."; Start-Sleep -Seconds 5; exit }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8 # keep emoji/₹ readable in the log
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force -Path logs | Out-Null
$Host.UI.RawUI.WindowTitle = 'Mess QR bot'

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

while ($true) {
    $log = Join-Path 'logs' ('bot-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
    "==== started $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====" | Out-File -FilePath $log -Append -Encoding utf8
    & $node $mainJs 2>&1 | ForEach-Object { $_; $_ | Out-File -FilePath $log -Append -Encoding utf8 }
    $msg = "==== bot stopped (exit $LASTEXITCODE) at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - restarting in 30s ===="
    $msg
    $msg | Out-File -FilePath $log -Append -Encoding utf8
    Start-Sleep -Seconds 30
}
