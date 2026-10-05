$ErrorActionPreference = 'SilentlyContinue'
foreach ($key in @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.esportsmonitor.browser',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.esportsmonitor.browser',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.esportsmonitor.browser'
)) { Remove-Item $key -Recurse -Force }
Remove-Item (Join-Path $env:LOCALAPPDATA 'EsportsMonitor\BrowserHost') -Recurse -Force
Write-Host 'Помощник Esports Monitor удалён.'
