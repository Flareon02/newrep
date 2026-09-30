# Импорт оригинального проекта (исходная точка)

Этот документ описывает, как оригинальный проект был перенесён в репозиторий.
**Бизнес-логика не менялась**: код серверной части и расширения — побайтово
тот же, что в архивах (кроме исключённых файлов, см. ниже).

## Импортированные архивы

| Архив | Внутренняя папка | Версия | Куда помещён |
|---|---|---|---|
| `Esports-Monitor-server-4_3_5-deploy-history-fix.zip` | `astek-monitor-server-v4.3.5-deploy-history-fix/` | server **4.3.5** (`package.json`) | `server/` |
| `Esports-Monitor-v8_1_2-priority-realtime.zip` | `Esports-Monitor-v8.1.2-priority-realtime/` | extension **8.1.2** (`manifest.json`) | `extension/` |

Содержимое каждой внутренней папки помещено в корень `server/` и `extension/`
соответственно, поэтому все относительные пути внутри проектов сохранены.

## Структура репозитория

```
server/                 Серверная часть (Node.js, Docker)
  src/                  Исходный код сервера (ES-модули + .cjs)
  test/                 Автотесты (node:test) и fixtures/
  secrets/              Каталог для секретов (содержимое НЕ в Git, только .gitkeep)
  Dockerfile, docker-compose.yml, .dockerignore   Контейнер
  install.sh, upgrade.sh, rollback.sh             Развёртывание / обновление / откат
  backup.sh, compact-storage.sh                   Резервная копия и сжатие SQLite
  configure-ggbet-relay.sh                        Настройка GGBET-relay
  README.md, START-HERE.md, CHANGELOG-*.md        Документация сервера
  .env.example          Шаблон переменных окружения (без значений)
extension/              Браузерное расширение (Chrome, Manifest V3)
  manifest.json, background.js, app.html/js/css, odds.html/js/css, ...
  assets/dota-heroes/   Иконки героев Dota 2 (webp)
  browser-host/         Нативный хост (C# + PowerShell) для nativeMessaging
  README.md, CHANGELOG-8.1.*.md                   Документация расширения
docs/                   Документация репозитория (этот файл)
```

Отнесение файлов:

- **server:** `server/src`, `package.json`, `Dockerfile`.
- **browser extension:** `extension/` целиком (включая `browser-host/`).
- **deployment:** `server/Dockerfile`, `docker-compose.yml`, `install.sh`,
  `upgrade.sh`, `rollback.sh`, `backup.sh`, `compact-storage.sh`,
  `configure-ggbet-relay.sh`, `.dockerignore`; `extension/browser-host/Install-/Uninstall-BrowserHost.ps1`.
- **tests:** `server/test/` (43 файла `*.test.js` + `fixtures/`). Для расширения тестов в архиве нет.
- **documentation:** `README.md`, `START-HERE.md`, `CHANGELOG-*.md` в `server/` и `extension/`.

## Проверка на секреты

Перед первым коммитом проверены оба архива: файлы `.env`, ключи/токены,
пароли, приватные ключи, cookies, учётные данные БД/SSH, webhook-секреты,
а также поиск по шаблонам ключей в содержимом файлов.

**Реальных секретов в архивах не обнаружено.** Замечания:

- `server/secrets/ggbet-relay-secret` и `server/secrets/ggbet-relay-ca.pem`
  в архиве — **пустые файлы (0 байт)**. Они не добавлены в Git; на сервере их
  создаёт `configure-ggbet-relay.sh` (или `upgrade.sh` копирует из работающего
  контейнера). В Git оставлен только `server/secrets/.gitkeep`, а `.gitignore`
  исключает всё остальное в этом каталоге.
- В `server/src/ggbet.js` есть 64-символьные hex-значения — это публичные
  хеши GraphQL persisted queries, а не секреты. В тестах `token` — заведомо
  фиктивные значения.
- `extension/manifest.json` содержит IP production-сервера в `host_permissions`
  (`http://87.199.202.237/*`). Это не учётные данные, но это адрес боевого
  сервера; оставлен без изменений (изменение — вопрос следующего этапа).

## Намеренно не добавлено в Git

| Что | Почему |
|---|---|
| `server/secrets/ggbet-relay-secret`, `server/secrets/ggbet-relay-ca.pem` | секрет/сертификат relay (в архиве пустые), создаются при настройке |
| `.env`, `.env.*` (в т.ч. `.env.before-*`, `.env.next`) | реальные переменные окружения; вместо них — `server/.env.example` |
| `server/data/`, `*.sqlite*`, `*.db*`, `backups/` | рабочие базы и данные пользователей (в архивах их нет) |
| `node_modules/`, логи, `tmp/`, кэши, `*.zip`, `dist/`, `build/` | генерируемые артефакты |

Из архивов **ничего другого не исключалось**: все остальные файлы (включая
`hltv-seed.json`, `astek-market-*.json`, fixtures, иконки) импортированы.

## Зависимости и окружение

- **Server:** Node.js **>= 22** (используется встроенный `node:sqlite`);
  единственная npm-зависимость — `ws@8.21.3`. Запуск в продакшене — Docker
  (образ `node:22-alpine`, порт 8080, данные в `/data`). Для скриптов
  развёртывания нужны `docker`, `docker compose`, `curl`, `python3`.
- **Extension:** Chrome/Chromium >= 120 (Manifest V3), без сборки и без
  npm-зависимостей. `nativeMessaging` использует `browser-host`
  (.NET/C#, PowerShell, Windows).

## Предполагаемые команды

Из `server/`:

```sh
npm install --omit=dev      # установить зависимость ws
npm start                   # node src/index.js (PORT, DATA_DIR — через окружение)
npm test                    # node --test --test-concurrency=1 test/*.test.js
docker compose up -d --build   # запуск в Docker (см. START-HERE.md / install.sh)
```

Расширение: Chrome → `chrome://extensions` → «Режим разработчика» →
«Загрузить распакованное расширение» → папка `extension/`.

## Результат проверки импорта

- Файлов в архивах: 309 (server 127, extension 182). В Git перенесены все, кроме двух пустых
  файлов секретов (вместо них `server/secrets/.gitkeep`); добавлены только `.gitignore`,
  `server/.env.example` и этот документ.
- `npm install` + `npm test` на импортированной копии `server/`
  (Node 22.22): **184 теста, 184 пройдено, 0 упало**.

## Git

- `main` — исходная точка (коммит `chore: import original server and extension`).
- `refactor/production-hardening` — рабочая ветка для дальнейшей переработки.
