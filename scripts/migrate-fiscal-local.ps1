param(
  [string]$SourcePath = (Join-Path (Split-Path $PSScriptRoot -Parent) '..\PersonalizeNF')
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$SourcePath = (Resolve-Path $SourcePath).Path

function Read-EnvMap([string]$Path) {
  $map = [ordered]@{}
  if (-not (Test-Path $Path)) { return $map }
  foreach ($line in Get-Content $Path) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') { $map[$Matches[1]] = $Matches[2] }
  }
  return $map
}

function Upsert-EnvLine([System.Collections.Generic.List[string]]$Lines, [string]$Key, [string]$Value, [bool]$Overwrite = $true) {
  $index = -1
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    if ($Lines[$i] -match "^$([regex]::Escape($Key))=") { $index = $i; break }
  }
  if ($index -ge 0) {
    if ($Overwrite) { $Lines[$index] = "$Key=$Value" }
  } else {
    $Lines.Add("$Key=$Value")
  }
}

Write-Host 'Feche o PersonalizeNF e o PersonalizeProd antes de continuar.' -ForegroundColor Yellow
Write-Host "Migrando somente os dados fiscais de $SourcePath" -ForegroundColor Cyan

$FiscalData = Join-Path $Root 'data\fiscal'
$FiscalDocuments = Join-Path $Root 'storage\fiscal-documents'
New-Item -ItemType Directory -Force -Path $FiscalData | Out-Null
New-Item -ItemType Directory -Force -Path $FiscalDocuments | Out-Null

$SourceDb = Join-Path $SourcePath 'data\personalize-nf.sqlite'
$TargetDb = Join-Path $FiscalData 'personalize-nf.sqlite'
if (Test-Path $SourceDb) {
  if (Test-Path $TargetDb) { Copy-Item $TargetDb "$TargetDb.backup" -Force }
  Copy-Item $SourceDb $TargetDb -Force
  foreach ($suffix in @('-wal', '-shm')) {
    $sourceSidecar = $SourceDb + $suffix
    $targetSidecar = $TargetDb + $suffix
    if (Test-Path $sourceSidecar) { Copy-Item $sourceSidecar $targetSidecar -Force }
    elseif (Test-Path $targetSidecar) { Remove-Item $targetSidecar -Force }
  }
  Write-Host 'Banco e histórico fiscal copiados.' -ForegroundColor Green
} else {
  Write-Host 'Banco antigo não encontrado; um banco fiscal novo será criado.' -ForegroundColor Yellow
}

$SourceDocs = Join-Path $SourcePath 'storage\documents'
if (Test-Path $SourceDocs) {
  Copy-Item (Join-Path $SourceDocs '*') $FiscalDocuments -Recurse -Force
  Write-Host 'PDF e XML anteriores copiados.' -ForegroundColor Green
}

$SourceEnv = Join-Path $SourcePath '.env'
$TargetEnv = Join-Path $Root '.env'
$targetLines = [System.Collections.Generic.List[string]]::new()
if (Test-Path $TargetEnv) {
  Copy-Item $TargetEnv "$TargetEnv.before-fiscal-migration" -Force
  foreach ($line in Get-Content $TargetEnv) { $targetLines.Add([string]$line) }
}

if (Test-Path $SourceEnv) {
  $sourceMap = Read-EnvMap $SourceEnv
  foreach ($key in $sourceMap.Keys) {
    if ($key -match '^(ADMIN_|SESSION_SECRET$|DEMO_MODE|DEMO_APPROVAL_DELAY_MS|ALLOW_PRODUCTION|FOCUS_|DPS_SERIES|COMPANY_|SERVICE_)') {
      Upsert-EnvLine $targetLines $key ([string]$sourceMap[$key]) $true
    }
  }
}

$defaults = [ordered]@{
  FISCAL_HOST = '127.0.0.1'
  FISCAL_PORT = '3031'
  FISCAL_DATA_DIRECTORY = './data/fiscal'
  FISCAL_DOCUMENT_DIRECTORY = './storage/fiscal-documents'
}
foreach ($key in $defaults.Keys) { Upsert-EnvLine $targetLines $key $defaults[$key] $false }

[System.IO.File]::WriteAllLines($TargetEnv, $targetLines, [System.Text.UTF8Encoding]::new($false))
Write-Host 'Configuração fiscal copiada sem alterar conexão, logs ou inicialização do bot.' -ForegroundColor Green
Write-Host 'Migração concluída. Mantenha a pasta PersonalizeNF como backup até validar tudo.' -ForegroundColor Green
