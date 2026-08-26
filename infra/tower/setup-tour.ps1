# Copie la config SSH WeFlix sur ta tour Windows.
# Lancer dans PowerShell :  .\infra\tower\setup-tour.ps1

$ErrorActionPreference = "Stop"
$sshDir = Join-Path $env:USERPROFILE ".ssh"
$keyName = "weflix_vps_ed25519"
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$sourceKey = Join-Path $PSScriptRoot $keyName
$sourceConfig = Join-Path $PSScriptRoot "ssh-config"

New-Item -ItemType Directory -Force -Path $sshDir | Out-Null

if (-not (Test-Path $sourceKey)) {
  Write-Error "Cle privee introuvable : $sourceKey`nCopie le dossier infra/tower depuis ton Mac."
}

Copy-Item -Force $sourceKey (Join-Path $sshDir $keyName)
Copy-Item -Force "$sourceKey.pub" (Join-Path $sshDir "$keyName.pub")
Copy-Item -Force $sourceConfig (Join-Path $sshDir "config")

icacls (Join-Path $sshDir $keyName) /inheritance:r | Out-Null
icacls (Join-Path $sshDir $keyName) /grant:r "$($env:USERNAME):(R)" | Out-Null

Write-Host "OK — config SSH installee dans $sshDir"
Write-Host "Test : ssh weflix-vps"
Write-Host "Cursor : Ctrl+Shift+P -> Remote-SSH: Connect to Host -> weflix-vps"
