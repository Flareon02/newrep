Esports Monitor browser-host — НЕОБЯЗАТЕЛЬНЫЙ помощник для Windows
=====================================================================

Нужен только для настройки «Браузер для ссылок на конторы» = Chrome / Edge / Firefox / системный браузер.
С настройкой «Текущий браузер» (по умолчанию) помощник не нужен, и без него расширение работает полностью:
ссылки открываются в текущем браузере. Помощник распространяется отдельно от ZIP расширения.

Установка (один раз):
  1. Распакуйте этот архив в любую папку.
  2. Откройте PowerShell в этой папке и выполните:
       Unblock-File .\Install-BrowserHost.ps1, .\EsportsMonitorBrowserHost.cs
       powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\Install-BrowserHost.ps1 -ExtensionId ВАШ_ID_РАСШИРЕНИЯ
     (RemoteSigned действует только для этого запуска; системная политика не меняется.)
  3. В Esports Monitor: Настройки → Отображение → «Браузер для ссылок» — выберите браузер и подтвердите
     запрос разрешения «связь с программами на компьютере». ID расширения показан там же.

Что именно делает установщик:
  - компилирует ПРИЛОЖЕННЫЙ исходный код EsportsMonitorBrowserHost.cs (виден в этой папке) в
    %LOCALAPPDATA%\EsportsMonitor\BrowserHost\EsportsMonitorBrowserHost.exe (Add-Type, без загрузки из сети);
  - пишет манифест com.esportsmonitor.browser.json рядом с ним (разрешён только ваш ID расширения);
  - создаёт ТРИ ключа реестра текущего пользователя (без прав администратора), значение = путь к манифесту:
      HKCU\Software\Google\Chrome\NativeMessagingHosts\com.esportsmonitor.browser
      HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.esportsmonitor.browser
      HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.esportsmonitor.browser
Что делает помощник: получает от расширения одну http/https-ссылку и имя браузера и открывает её
(Process.Start). Он не обращается к сети, не хранит данных и не содержит ключей или токенов.

Удаление:
  powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\Uninstall-BrowserHost.ps1
  (удаляет три ключа реестра и папку %LOCALAPPDATA%\EsportsMonitor\BrowserHost)

План: если функция останется, заменить компиляцию при установке подписанным готовым установщиком.
