$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ManifestPath = Join-Path $RepoRoot 'extension\manifest.json'

if (-not (Test-Path $ManifestPath)) {
  throw "manifest.json não encontrado em $ManifestPath"
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'Git não encontrado no PATH.'
}

Push-Location $RepoRoot
try {
  $insideRepo = (& git rev-parse --is-inside-work-tree 2>$null)
  if ($insideRepo -ne 'true') {
    throw 'Esta pasta ainda não é um repositório Git. Inicialize/publice o repositório primeiro.'
  }

  $manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
  $parts = @($manifest.version -split '\.')
  if ($parts.Count -lt 3) {
    throw "Versão inválida no manifest: $($manifest.version)"
  }

  $major = [int]$parts[0]
  $minor = [int]$parts[1]
  $patch = [int]$parts[2] + 1
  $manifest.version = "$major.$minor.$patch"
  $manifest | ConvertTo-Json -Depth 20 | Set-Content -Path $ManifestPath -Encoding UTF8

  Get-Content $ManifestPath -Raw | ConvertFrom-Json | Out-Null

  & git add -A
  $status = & git status --porcelain
  if (-not $status) {
    Write-Host 'Nenhuma alteração para publicar.' -ForegroundColor Yellow
    exit 0
  }

  $message = "SPX Toolkit v$($manifest.version)"
  & git commit -m $message
  & git push origin HEAD:main

  Write-Host "Publicado: $message" -ForegroundColor Green
} finally {
  Pop-Location
}
