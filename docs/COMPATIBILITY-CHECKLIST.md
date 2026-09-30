# Compatibility checklist: ORIGINAL (`main`) vs NEW (`refactor/production-hardening`)

Для каждой функции из `docs/FUNCTIONAL-INVENTORY.md`: **сохранена** (код не менялся или менялся без смены
поведения) · **исправлена** (был дефект, исправлен) · **протестирована** (чем именно).

Инструменты сравнения, которыми получены результаты ниже (воспроизводятся командами из конца файла):

- **A** — `tools/compare-with-original.mjs`: запускает `main` и рабочее дерево на одном и том же моке AstekBet,
  опрашивает 28 эндпоинтов и сравнивает статус и JSON (без времён и ревизий).
- **B** — серверный набор `npm test` в `server/`: 184 исходных теста (все проходят без изменений, кроме одной
  регулярки в `fixes-372`, допускающей `safeWrite(` вместо `res.write(`) + 35 новых.
- **C** — `tools/e2e-extension-smoke.mjs`: реальный Chromium + распакованное расширение + реальный процесс сервера.
- **D** — `node --test extension/test/*.test.mjs`: манифест, скрипты, логика адреса/токена (12 тестов).

## Результат сравнения A (ORIGINAL vs NEW)

Одинаковы (статус и тело): `/api/ui/live` (оба режима), `/api/ui/prematch`, `/api/ui/leagues`, `/api/ui/history`,
`/api/ui/event-detail` (успешный), `/api/live`, `/api/prematch`, `/api/live/astek`, `/api/leagues`, `/api/league-links`,
`/api/hltv/data`, `/api/odds/history`, `/api/score-history`, `/api/odds/timeline`, `/api/prematch/odds`,
`POST /api/prematch/compare`, `POST /api/odds/manual`.

Отличаются — **ожидаемо и обратно совместимо**:

| Эндпоинт | Было | Стало |
|---|---|---|
| любой ответ ≥ 400 | `{error}` | `{ok:false,error,code,requestId,…прежние поля}` |
| `POST /api/ui/odds-watch` | 405 | 200 `{ok,accepted,ttlMs,warming:false}` |
| `/health` | — | добавлены `runtime.history`, `runtime.storage.diskLevel`, `oddsWatch`, `sse`, `security.writeAuth` |

Других отличий нет. Любое новое расхождение при повторном запуске A — регрессия.

## Сервер

| № | Функция | Сохранена | Исправлена | Протестирована |
|---|---|---|---|---|
| F1 | LIVE AstekBet (опрос, gate, backoff) | ☑ | — (лог: обычные строки → debug) | B (`astek-live-priority-421`, `fixes-*`), A, C |
| F2 | Линия AstekBet | ☑ | — | B, A (`/api/ui/prematch`) |
| F3 | Fonbet (listBase + delta) | ☑ | — | B (`fonbet-score-sanity`, `realtime-stability-433`) |
| F4 | GGBET LIVE (WS, relay) | ☑ | — | B (`ggbet-live`, `ggbet-market-semantics`) |
| F5 | Pinnacle линия/LIVE/детали/SSE | ☑ | SSE‑предупреждение не раскрывает внутренний текст ошибки | B (`pinnacle*`, `fixes-372`) |
| F6 | Сопоставление матчей, связи лиг | ☑ | — | B (`unified-300`, `fixes-3*`), A |
| F7 | Результаты, архив, прогрев | ☑ | — | B (`fixes-32*`, `fixes-33*`) |
| F8 | История (страницы, воркер, простой) | ☑ | загрузка при старте: пик RSS −25 % (меньше пик памяти) | B (`fixes-37*`, `sqlite-streaming`), A, бенч `bench-history-load` |
| F9 | Журналы коэффициентов и счёта | ☑ | опциональное ограничение срока (по умолчанию выключено) | B (`sqlite-v2`, `odds-history-crossbet`, `score-log`, новые `retention`) |
| F10 | Тонкий клиент `/api/ui/*`, ETag, патчи по SSE | ☑ | — | B (`thin-client-ui`, `push-ui`), A, C |
| F11 | Публикация связей лиг | ☑ | **добавлена защита токеном** (опционально) | B (`api-auth`), A |
| F12 | Генератор коэффициентов (HLTV/ручной) | ☑ | защита токеном (опционально) | B (`odds-api`, `odds`, `hltv-details`), замер пика памяти |
| F13 | Live‑генератор | ☑ | — | B (`odds-api`, `live-detail`) |
| F14 | Статистика Dota 2 / CS2 | ☑ | опциональное ограничение срока | B (`hltv-details`, `fixes-36*`, `retention`) |
| F15 | Логотипы команд | ☑ | — | B |
| F16 | Сравнение расписаний | ☑ | — | B (`fixes-302`), A |
| F17 | Rate limit, лимиты тел/ответов, таймауты | ☑ | **+ общий лимит SSE, maxConnections, отключение «медленных» SSE‑клиентов** | B (`sse-limits`) |
| F18 | `/health`, метрики | ☑ | **+ ёмкость History, уровень диска, SSE, odds‑watch** | B (`capacity`, `api-errors`) |
| F19 | Хранилище SQLite/JSON, восстановление из `.bak` | ☑ | — | B (`sqlite-v2`, `fixes-320`) |
| F20 | Корректное завершение | ☑ | — | B |
| F21 | Развёртывание/откат/бэкап | ☑ | версия 4.4.0; `npm ci`; **новый** `prune-old-releases.sh` | B (`deploy-*`, `prune-script`), `docker compose config` |
| F22 | Совместимые/служебные эндпоинты | ☑ | — | A |
| — | Обработка ошибок и логи | — | **единый формат, без утечки внутренностей, уровни, маскирование секретов** | B (`api-errors`, `logger`) |

## Расширение

| № | Функция | Сохранена | Исправлена | Протестирована |
|---|---|---|---|---|
| X1 | Вкладки, фильтры, поиск, избранное, темы | ☑ | — | C (рендер 12 карточек LIVE, отсутствие ошибок скриптов) |
| X2 | Service worker: SSE, опрос, backoff, кэш | ☑ | ждёт сохранённые настройки сервера перед SSE; сбрасывает кэш при смене сервера | C, D |
| X3 | Уведомления, будильник | ☑ | — | (код не менялся; ручная проверка в браузере — см. ниже) |
| X4 | Детали матча и рынки | ☑ | — | A (`/api/ui/event-detail`) |
| X5 | История коэффициентов, шкала, история счёта | ☑ | — | A, C (`score-history.html` загружается без ошибок) |
| X6 | Генератор (HLTV, свой состав, ручной, HAR) | ☑ | токен в запросах | C (POST с токеном → принят, без токена → сообщение 401), C (`odds.html` без ошибок) |
| X7 | Live‑генератор | ☑ | токен в запросах | D |
| X8 | Статистика Dota 2 / CS2 | ☑ | токен в POST availability | C (POST availability → 200) |
| X9 | Связи лиг, публикация | ☑ | токен в запросах | B (`api-auth`), D |
| X10 | Импорт расписания, сравнение | ☑ | — | A |
| X11 | Ввод котировок книги | ☑ | — | — |
| X12 | Открытие ссылок в выбранном браузере | ☑ | — | (native host не менялся; Windows‑интеграция не проверялась) |
| X13 | `odds-watch` | ☑ | **исправлено**: сервер принимает запрос (было 405) | B (`odds-watch`), C (`oddsWatch.ids = 8`), A |
| X14 | Дельты Results | ☑ (поведение прежнее: полный ответ) | не менялось | — |
| X15 | Скрытые настройки (`*SettingsUnlocked`) | ☑ | — | — |
| — | Чекбокс «Показывать логотипы команд» | — | **исправлено** (всегда отображался выключенным) | C |
| — | Настройка адреса сервера и токена | — | **новая функция**; значения по умолчанию прежние | C, D |

## Что не проверено (честно)

- Работа против **живых** AstekBet/Fonbet/GGBET/Pinnacle/HLTV: из песочницы они недоступны (403); проверяйте после
  выкладки по `/health → live.*.lastError`, `live.*.count` и по тому, что в расширении идут карточки.
- Сборка и запуск Docker‑образа: в песочнице нет демона Docker; проверены `docker compose config`, `npm ci` и запуск
  `node src/index.js` с теми же переменными, что в compose.
- Установка native‑хоста на Windows, системные уведомления Chrome, открытие ссылок во внешнем браузере.
- Нагрузка на полном боевом объёме данных (см. `docs/PERFORMANCE-BUDGET.md`, раздел «Что ещё нужно измерить»).

## Как воспроизвести

```sh
cd server && npm ci --omit=dev && npm test            # B
cd .. && node --test extension/test/*.test.mjs         # D
node tools/compare-with-original.mjs --original main   # A (нужен server/node_modules)
npm run e2e                                            # C (нужны Playwright и Chromium)
npx eslint .                                           # 0 ошибок
```
