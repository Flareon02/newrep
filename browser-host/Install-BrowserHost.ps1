param([string]$ExtensionId)
$ErrorActionPreference = 'Stop'
if (-not $ExtensionId) { $ExtensionId = Read-Host 'ID расширения Esports Monitor (виден в Настройки -> Браузер для ссылок)' }
if ($ExtensionId -notmatch '^[a-p]{32}$') { throw 'Некорректный ID расширения Chrome/Edge.' }

$source = Join-Path $PSScriptRoot 'EsportsMonitorBrowserHost.cs'
$target = Join-Path $env:LOCALAPPDATA 'EsportsMonitor\BrowserHost'
$exe = Join-Path $target 'EsportsMonitorBrowserHost.exe'
$manifest = Join-Path $target 'com.esportsmonitor.browser.json'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Remove-Item $exe -Force -ErrorAction SilentlyContinue

Add-Type -Path $source -OutputAssembly $exe -OutputType ConsoleApplication -ReferencedAssemblies 'System.dll','System.Web.Extensions.dll'
$data = [ordered]@{
  name = 'com.esportsmonitor.browser'
  description = 'Esports Monitor browser launcher'
  path = $exe
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($manifest, $data, (New-Object Text.UTF8Encoding($false)))

foreach ($key in @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.esportsmonitor.browser',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.esportsmonitor.browser',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.esportsmonitor.browser'
)) {
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifest
}

Write-Host ''
Write-Host 'Готово. Перезагрузите расширение Esports Monitor.' -ForegroundColor Green
Write-Host "Host: $exe"
