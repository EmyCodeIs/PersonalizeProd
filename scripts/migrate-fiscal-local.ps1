param(
  [string]$SourcePath = (Join-Path (Split-Path $PSScriptRoot -Parent) '..\PersonalizeNF')
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$SourcePath = (Resolve-Path $SourcePath).Path

Write-Host "Migrando dados fiscais de $SourcePath" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data\fiscal') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'storage\fiscal-documents') | Out-Null

$SourceDb = Join-Path $SourcePath 'data\personalize-nf.sqlite'
if (Test-Path $SourceDb) { Copy-Item $SourceDb (Join-Path $Root 'data\fiscal\personalize-nf.sqlite') -Force }
foreach ($suffix in @('-wal','-shm')) {
  if (Test-Path ($SourceDb + $suffix)) { Copy-Item ($SourceDb + $suffix) ((Join-Path $Root 'data\fiscal\personalize-nf.sqlite') + $suffix) -Force }
}
$SourceDocs = Join-Path $SourcePath 'storage\documents'
if (Test-Path $SourceDocs) { Copy-Item (Join-Path $SourceDocs '*') (Join-Path $Root 'storage\fiscal-documents') -Recurse -Force }

$SourceEnv = Join-Path $SourcePath '.env'
$TargetEnv = Join-Path $Root '.env'
if (Test-Path $SourceEnv) {
  $allowed = '^(DEMO_MODE|DEMO_APPROVAL_DELAY_MS|ALLOW_PRODUCTION|FOCUS_|DPS_SERIES|COMPANY_|SERVICE_|ADMIN_NAME|ADMIN_EMAIL|ADMIN_PASSWORD|SESSION_SECRET)'
  $target = if (Test-Path $TargetEnv) { [System.Collections.Generic.List[string]](Get-Content $TargetEnv) } else { [System.Collections.Generic.List[string]]::new() }
  foreach ($line in Get-Content $SourceEnv) {
    if ($line -notmatch '^([A-Z0-9_]+)=(.*)$') { continue }
    $key = $Matches[1]
    if ($key -notmatch $allowed) { continue }
    $index = -1
    for ($i = 0; $i -lt $target.Count; $i++) { if ($target[$i] -match "^$([regex]::Escape($key))=") { $index = $i; break } }
    if ($index -ge 0) { $target[$index] = $line } else { $target.Add($line) }
  }
  Set-Content -Path $TargetEnv -Value $target -Encoding UTF8
}

Write-Host 'Migração concluída. O PersonalizeNF separado pode permanecer como backup até a validação final.' -ForegroundColor Green
