<#
  Registers the Vegas print agent so it starts on its own with Windows.

  Run once, in PowerShell, from this folder:

      Set-ExecutionPolicy -Scope Process Bypass -Force
      .\install.ps1

  It creates a Scheduled Task that starts at logon, runs hidden, and restarts
  itself if it ever stops. Nothing to open, nothing to remember.
#>

$ErrorActionPreference = 'Stop'

function Hold($msg) {
  if ($msg) { Write-Host "" ; Write-Host $msg -ForegroundColor Yellow }
  Write-Host ""
  Read-Host "Press Enter to close"
}
trap { Write-Host ""; Write-Host "FAILED: $_" -ForegroundColor Red; Hold "Send this message to Claude if you are stuck."; exit 1 }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'Vegas print agent'

Write-Host "Vegas print agent - install" -ForegroundColor Cyan
Write-Host "Folder: $here"

# --- Node -------------------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  Write-Host ""
  Write-Host "Node.js is not installed." -ForegroundColor Red
  Write-Host "Install the LTS build from https://nodejs.org, then run this again."
  Hold
  exit 1
}
Write-Host "Node: $($node.Source)"

# --- The key (optional) -----------------------------------------------------
# Only needed so orders sent from a phone reach this printer. Without it the
# agent still prints everything asked of it directly, so installation is never
# blocked on getting a file across.
if (-not (Test-Path (Join-Path $here 'service-account.json'))) {
  Write-Host ""
  Write-Host "No service-account.json here - installing as a local printer service." -ForegroundColor Yellow
  Write-Host "This till will print. Orders sent from phones will not, until the key is added."
}

# --- Dependencies -----------------------------------------------------------
if (-not (Test-Path (Join-Path $here 'node_modules'))) {
  Write-Host "Installing dependencies (once, needs internet)..."
  Push-Location $here
  npm install --omit=dev
  Pop-Location
}

# --- Printers ---------------------------------------------------------------
Write-Host ""
Write-Host "Printers Windows knows about:" -ForegroundColor Cyan
Get-Printer | Select-Object -ExpandProperty Name | ForEach-Object { Write-Host "  $_" }
Write-Host "Put these exact names into config.json (bar / kitchen / bill)."

# --- The task ---------------------------------------------------------------
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Replaced the previous task."
}

$action = New-ScheduledTaskAction -Execute $node.Source -Argument 'agent.cjs' -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Description 'Prints slips queued by the Vegas Motel & Resto website.' | Out-Null

Start-ScheduledTask -TaskName $taskName

Write-Host ""
Write-Host "Done - the agent is running and will start with Windows." -ForegroundColor Green
Write-Host "Check it:   Get-ScheduledTask -TaskName '$taskName'"
Write-Host "Stop it:    Stop-ScheduledTask -TaskName '$taskName'"
Write-Host "Remove it:  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
Hold
