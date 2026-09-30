# Карта функциональности (Functional Inventory)

Состояния: **Работает** — логика прочитана и покрыта тестами/согласована с контрактом;
**Частично** — работает с деградацией; **Сломано** — не работает; **Потенц.** — есть риск.
Примечание: проверка на живых апстримах невозможна из окружения аудита (букмекеры отвечают 403/недоступны),
поэтому «Работает» = по коду, тестам и запуску сервера на пустых данных.

Сокращения: SRV — `server/src`, EXT — `extension/`.

## Сервер

| № | Возможность | Где | Входы → выходы | Зависимости | Состояние | Что менять |
|---|---|---|---|---|---|---|
| F1 | Сбор LIVE AstekBet (5 с, gate с приоритетами, backoff, отпечаток) | SRV live.js, parsers.js, utils.js | HTTP апстрима → `SnapshotState` | ASTEK_ORIGINS | Работает | логи → debug |
| F2 | Сбор «Линии» AstekBet (каталог, bulk, по лигам) | prematch.js | HTTP → состояние prematch | PREMATCH_* | Работает | логи |
| F3 | Сбор Fonbet (listBase + delta, resync) | fonbet.js, fonbet-parser.js | HTTP → LIVE/prematch | FONBET_* | Работает | логи |
| F4 | GGBET LIVE (GraphQL‑WS, bootstrap через relay) | ggbet.js | WS → LIVE; детали | ws, relay секреты | Работает | логи |
| F5 | Pinnacle линия/LIVE + live‑детали и SSE | pinnacle.js | HTTP → состояния, `/api/pinnacle/*` | ключ Pinnacle (runtime) | Работает | логи |
| F6 | Сопоставление матчей между конторами, связи лиг | entity-resolver.js, matcher-*.js, league-*.js | события → логические события | worker_threads | Работает | — |
| F7 | Результаты (Astek/Fonbet), архив по дням, прогрев 7 дней | results.js | даты → страницы результатов | SQLite archive | Работает | логи |
| F8 | История (ledger), постраничная, в воркере, только при простое | state.js, ui-service.js, api.js | `since/offset/limit` → страница | SQLite | Работает | retention |
| F9 | История коэффициентов и счёта (журналы) | odds-log.js, score-log.js | изменения → SQLite; чтение через API | SQLite | Работает | retention (опц.) |
| F10 | Тонкий клиент: `/api/ui/*`, ETag, compact/thin, патчи по SSE | api.js, feed push | см. API‑CONTRACT | — | Работает | ошибки |
| F11 | Публикация связей лиг (challenge → publish, аудит) | league-store.js | изменения → правила + SSE invalidate | — | **Потенц.** (нет аутентификации) | токен |
| F12 | Генератор коэффициентов HLTV (ручной и HLTV‑режим), очередь ≤3, воркер 256 МиБ | odds-service.js, hltv-service.js, odds-model.js, manual-engine.cjs | тело → задача → результат | hltv.org (403 при блокировке) | Работает | токен |
| F13 | Live‑генератор (модель по счёту и линии) | live-model.js, api.js | событие+опции → расчёт | astek detail | Работает | — |
| F14 | Статистика Dota 2 (Hawk) и CS2 (Cross.bet WS), архив, SSE | hawk.js, crossbet.js, statistics-*.js | события → статистика | WS апстримов | Работает | retention (опц.) |
| F15 | Логотипы команд (скачивание с allowlist, кэш на диск) | team-logos.js | URL → файл `/data/teams/images` | allowlist хостов | Работает | — |
| F16 | Сравнение расписаний (импорт → сравнение с линией) | comparison.js, api.js | `/api/prematch/compare` | — | Работает | — |
| F17 | Защита: rate limit, лимиты тела/ответов, таймауты, SSE лимит | api.js, utils.js | — | — | Работает | общий лимит SSE |
| F18 | Здоровье/метрики/event‑loop lag, метрики апстримов | api.js `/health` | — | — | Работает | предупреждения диска |
| F19 | Хранилище SQLite WAL + JSON с `.bak`, миграция legacy, чекпоинт при остановке | sqlite-storage.js, utils.js, storage-cli.js | — | node:sqlite | Работает | — |
| F20 | Завершение работы с сохранением, fatal без сохранения | index.js | SIGTERM/ошибка → exit | Docker restart | Работает | — |
| F21 | Развёртывание/откат/бэкап (Docker, rollback, health‑gate) | upgrade.sh, install.sh, rollback.sh, backup.sh, configure-ggbet-relay.sh | — | docker, python3 | Работает (не запускалось) | ротация бэкапов |
| F22 | Совместимость: `/api/live`, `/api/prematch`, `/api/live/*`, `/api/status`… | api.js | — | — | Работает | сохранить |

## Расширение

| № | Возможность | Где | Состояние | Что менять |
|---|---|---|---|---|
| X1 | Вкладки LIVE / Результаты / Линия / История / Сравнение / Лиги / Диагностика, фильтры, поиск, избранное, темы | EXT app.js, app.html, *.css | Работает | адрес сервера/токен в настройках |
| X2 | Service worker: SSE‑поток, опрос‑страховка, backoff, кэш лент, рассылка портам | EXT background.js, feed-push.js | Работает | адрес/токен |
| X3 | Уведомления о новых матчах (LIVE/линия, избранное, дедупликация, звук), будильник | EXT background.js | Работает | — |
| X4 | Детали матча и рынки (Astek/GGBET/Pinnacle), канонизация рынков | EXT app.js, market-canonical.js, astek-market-names.js | Работает | — |
| X5 | История коэффициентов книги, временная шкала, история счёта | EXT book-dialog.js, odds-timeline.js, score-history.* | Работает | — |
| X6 | Генератор коэффициентов (odds.html): HLTV, свой состав, ручной режим, импорт HAR, экспорт JSON | EXT odds.js, manual-controls.js, hltv-*.js, har-stream.js | Работает | токен |
| X7 | Live‑генератор в диалоге матча | EXT live-generator.js | Работает | токен |
| X8 | Статистика Dota 2 / CS2 на карточках | EXT dota-stats-panel.js, cs2-panel.js, statistics-client.js | Работает | — |
| X9 | Связи лиг: черновик, публикация, видимость лиг | EXT league-client.js, league-model.js | Работает | токен |
| X10 | Импорт расписания (HTML/текст) и сравнение, копирование расписания | EXT import-htm.js, app.js | Работает | — |
| X11 | Ввод котировок книги вручную для линии | EXT prematch-book-input.js | Работает | — |
| X12 | Открытие ссылок в выбранном браузере (native messaging, Windows) | EXT background.js, browser-host/ | Работает | — |
| X13 | Регистрация наблюдаемых LIVE‑матчей (`odds-watch`) | EXT app.js:139‑142 | **Сломано (контракт)**: 405 | серверный приём (R1) |
| X14 | Дельта‑обновление Results (`deltaSince`) | EXT app.js:190‑212 | **Частично**: полный ответ вместо дельты | backlog |
| X15 | Подсказка по настройкам: скрытые флаги (`generatorSettingsUnlocked`, `oddsSettingsUnlocked`, `historySettingsUnlocked`) — скрытые настройки, не описаны в README | EXT app.js | Работает | сохранить |

## Скрытые/недокументированные возможности (найдены при аудите)

- Скрытые переключатели в настройках (разблокируются флагами `*SettingsUnlocked` в `prefs`): генератор коэффициентов, скрытие коэффициентов, история.
- Служебные endpoint'ы `/api/astek/markets`, `/api/pinnacle/live-markets`, `/api/live/*`, `/api/status` (не вызываются расширением 8.1.2, но используются тестами/диагностикой/updater).
- Переменная окружения `PINNACLE_API_KEY` (переопределение ключа, получаемого автоматически).
- `ASTEK_LAZY_LEGACY_MAX_BYTES` (ленивое чтение legacy‑данных), `PREMATCH_SEED_CHAMP`.
- `storage-cli.js` (`npm run storage:*`): статус/миграция/экспорт.
- Скрипты `probe-ggbet-ended.js`, `deploy-health-probe.js` (используется `upgrade.sh`).
