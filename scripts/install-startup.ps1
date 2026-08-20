# Registers DnD Immerse to start with Windows, and to keep itself running.
#
# `npm run serve` restarts the server if it crashes, but nothing restarts the
# supervisor if the machine reboots - and Windows reboots itself for updates.
# This is the other half: a Scheduled Task that runs the supervisor at logon and
# restarts it if it ever exits.
#
# Run once, from an ordinary PowerShell prompt in the repository root:
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
#
# To undo it:
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1 -Remove
#
# At *logon* rather than at boot on purpose. A boot trigger has to run as
# SYSTEM or store your password, and SYSTEM has a different profile, a
# different PATH and no access to a per-user node install - which turns one
# clear failure into three obscure ones. This machine is a desktop somebody
# signs into; that is when the table needs to be up.

param(
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$TaskName = 'DnD Immerse'
$Root = Split-Path -Parent $PSScriptRoot

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed the '$TaskName' scheduled task."
    } else {
        Write-Host "No '$TaskName' scheduled task to remove."
    }
    exit 0
}

# The node that is on PATH now, by absolute path: a Scheduled Task does not
# inherit this shell's PATH, and "node" alone is the classic way for one of
# these to work when you test it and fail silently at logon.
$NodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCommand) {
    Write-Error "node is not on PATH. Install Node 20 or newer, then run this again."
}
$Node = $NodeCommand.Source

$ServeScript = Join-Path $Root 'scripts\serve.mjs'
if (-not (Test-Path $ServeScript)) {
    Write-Error "Could not find $ServeScript - run this from the repository."
}

Write-Host "node       $Node"
Write-Host "repository $Root"

$Action = New-ScheduledTaskAction -Execute $Node -Argument "`"$ServeScript`"" -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# No time limit, because this is meant to run for weeks; and restart it if it
# stops, because the supervisor exiting is exactly the case this exists for.
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description 'Runs the DnD Immerse table, restarting it if it stops.' | Out-Null

Write-Host ""
Write-Host "Registered '$TaskName' to start at logon."
Write-Host ""
Write-Host "  Start it now      Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Stop it           Stop-ScheduledTask  -TaskName '$TaskName'"
Write-Host "  Is it running     Get-ScheduledTask   -TaskName '$TaskName'"
Write-Host "  What it did       data\logs\server-<date>.log"
Write-Host ""
Write-Host "It backs up to data\backups on every start, keeping the last ten."
