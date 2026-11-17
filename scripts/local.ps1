param([switch]$Deploy,[switch]$Stop,[string]$NodePath='node')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Set-Location $projectRoot
$state=Join-Path $projectRoot '.local/forward.json'
New-Item -ItemType Directory -Force .local | Out-Null
function Invoke-Checked($Program,$Arguments) { & $Program @Arguments; if ($LASTEXITCODE -ne 0) { throw "$Program failed" } }
if ($Stop) {
  if (Test-Path $state) {
    $saved=Get-Content $state -Raw | ConvertFrom-Json
    $process=Get-CimInstance Win32_Process -Filter "ProcessId = $($saved.pid)"
    if ($process -and $process.CommandLine.Contains('observability') -and $process.CommandLine.Contains('19090:8090')) { Stop-Process -Id $saved.pid }
    Remove-Item -LiteralPath $state
  }
  Write-Host 'Owned observatory port-forward stopped. Collector remains in Minikube.'
  return
}
$kubectl=(Get-Command kubectl).Source
$matchingKubectl=Join-Path $env:USERPROFILE '.minikube/cache/windows/amd64/v1.34.0/kubectl.exe'
if (Test-Path $matchingKubectl) { $kubectl=$matchingKubectl }
if ($Deploy) {
  Invoke-Checked $NodePath @('scripts/render.mjs')
  Invoke-Checked 'minikube' @('-p','minikube','image','build','-t','gta-observatory:demo','.')
  Invoke-Checked $kubectl @('--context=minikube','apply','-f','.local/resources.json')
  Invoke-Checked $kubectl @('--context=minikube','-n','observability','rollout','restart','deployment/observatory')
  Invoke-Checked $kubectl @('--context=minikube','-n','observability','rollout','status','deployment/observatory','--timeout=180s')
}
if (Test-Path $state) {
  $saved=Get-Content $state -Raw | ConvertFrom-Json
  $owned=Get-CimInstance Win32_Process -Filter "ProcessId = $($saved.pid)"
  if ($owned -and $owned.CommandLine.Contains('observability') -and $owned.CommandLine.Contains('19090:8090')) {
    try { $health=Invoke-WebRequest http://127.0.0.1:19090/healthz -UseBasicParsing -TimeoutSec 3; if ($health.StatusCode -eq 200) { Write-Host 'Observatory is already forwarded at http://127.0.0.1:19090'; return } } catch {}
    Stop-Process -Id $saved.pid -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $state
}
if (Get-NetTCPConnection -LocalPort 19090 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 19090 is already occupied.' }
$process=Start-Process -FilePath $kubectl -ArgumentList @('--context=minikube','-n','observability','port-forward','service/observatory','19090:8090','--address=127.0.0.1') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $projectRoot '.local/forward.out.log') -RedirectStandardError (Join-Path $projectRoot '.local/forward.error.log')
@{pid=$process.Id} | ConvertTo-Json | Set-Content $state
for ($attempt=0;$attempt -lt 20;$attempt++) {
  try { $response=Invoke-WebRequest http://127.0.0.1:19090/healthz -UseBasicParsing; if ($response.StatusCode -eq 200) { Write-Host 'Observatory ready: http://127.0.0.1:19090'; return } } catch {}
  Start-Sleep -Seconds 1
}
throw 'Dashboard forward did not become ready; inspect .local/forward.error.log.'
