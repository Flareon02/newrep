# Контракт API сервера 4.3.5 (как есть на исходной точке)

Базовый адрес: `http://<host>:8080`. Формат — JSON (UTF‑8), кроме SSE (`text/event-stream`)
и картинок логотипов. CORS: только `chrome-extension://<32 символа a‑p>`.
Аутентификации на исходной точке **нет** (см. docs/AUDIT.md, S1).
Общий лимит: GET 900/мин, POST 180/мин на IP; SSE — 24 на IP. Ответы ≥2 КБ сжимаются gzip (уровень 1), кроме `/health`.

**Формат ошибок (исходный):** тело `{"error":"<текст>"}`; в части ручек добавлено `ok:false`
или `matched:false`. Расширение читает только поле `error` и HTTP‑статус.
В новой ветке формат расширяется **обратно совместимо** (поля `ok:false`, `code`, `requestId` добавляются, `error` остаётся).

«Потребитель» — компонент расширения, который вызывает ручку. «—» = расширение 8.1.2 не
вызывает (служебные/совместимость/updater); такие ручки **сохраняются**.

## Ленты и UI (тонкий клиент)

| Метод | URL | Параметры | Ответ | Потребитель |
|---|---|---|---|---|
| GET | `/api/ui/live` | `meta=1`, `compact=1`, `thin=1`, `If-None-Match` | снимок LIVE (события, провайдеры, `revision`, `structureRevision`, `leagueRules`, `features`); ETag `W/"feed-<rev>"`, 304 | background.js |
| GET | `/api/ui/prematch` | как выше | снимок «Линии» | background.js |
| GET | `/api/ui/event-detail` | `view=live\|prematch`, `id`, `fresh=1` (игнорируется) | `{ok,view,event,marketDetailErrors,…}`; 400/404 | app.js |
| GET | `/api/ui/results` | `date`/`from`/`to`, `timezone`, `deltaSince` (игнорируется), фильтры, `thin=1` | страница результатов; 200 (complete) или 202 | app.js |
| GET | `/api/ui/history` | `since`, `offset`, `limit≤500`, фильтры, `thin=1` | страница истории; 503 + `retryable`, `Retry-After` при занятости realtime | app.js |
| GET | `/api/ui/leagues` | фильтры/пагинация | каталог лиг | app.js |
| POST | `/api/ui/odds-watch` | `{ids:[≤8]}` | **на 4.3.5 отсутствует → 405** (см. R1) | app.js (каждые 15 с) |
| GET (SSE) | `/api/feed-stream` | `modes=live,prematch,results,history,leagues`, `thin=1` | события `hello`, `patch`, `invalidate`, `status`, `ui-invalidate`; ping каждые 15 с | background.js |

## Связи лиг

| Метод | URL | Ответ | Потребитель |
|---|---|---|---|
| GET | `/api/leagues`, `/api/league-links` | каталог + правила (`revision`, `links`, `visibility`) | league-client.js |
| GET | `/api/league-links/challenge` | `{nonce,expiresAt}` (одноразовый, 60 с, привязан к IP) | league-client.js |
| POST | `/api/league-links/publish` | `{nonce,baseRevision,changes}` → `{ok,…}`; 403/409/429 | league-client.js |
| POST | `/api/league-links` | всегда 410 (прямое редактирование отключено) | — |

## Коэффициенты, история, генераторы

| Метод | URL | Вход | Ответ | Потребитель |
|---|---|---|---|---|
| GET | `/api/odds/history` | `source`, `id`, `before`, `limit≤100` | записи изменений коэффициентов | book-dialog.js |
| GET | `/api/odds/timeline` | `ids` (≤30, `source:id`), `at` | срез рынков по времени | odds-timeline.js |
| GET | `/api/score-history` | `ids` (≤200), `limit≤1000`, `before` | история счёта | score-cache.js |
| GET | `/api/prematch/odds` | `ids` (≤30) | текущие события по id | prematch-book-input.js |
| POST | `/api/prematch/compare` | `{events,options}` | результат сравнения расписаний | app.js |
| POST | `/api/odds/generate` | тело ≤16 МБ (HLTV‑расчёт) | 202 `{id,status,…}`; 429 если очередь занята | odds.js |
| POST | `/api/odds/manual` | тело ≤256 КБ | 202 `{id,…}` | manual-controls.js |
| GET | `/api/odds/job` | `id` | состояние задачи; 404 | odds.js, manual-controls.js |
| POST | `/api/live-generator` | `{event,options}` ≤512 КБ | `{result,historyEntries,serverCalculated}` | live-generator.js |
| GET | `/api/hltv/data` · `/search` · `/team` · `/player` | `q`, `id`, `refresh=1` | данные HLTV + статус | odds.js |
| GET | `/api/astek/markets` | `id` | полные рынки AstekBet | — |
| GET | `/api/pinnacle/live-markets` | `id`, `force` | live‑рынки Pinnacle | — |
| GET (SSE) | `/api/pinnacle/live-stream` | `id` | поток live‑деталей Pinnacle | live-generator.js, book-dialog.js |

## Статистика и медиа

| Метод | URL | Вход | Ответ | Потребитель |
|---|---|---|---|---|
| POST | `/api/statistics/availability` | `{events:[≤500]}` | доступность статистики | statistics-client.js |
| GET | `/api/statistics/match` | `id` | сохранённая статистика; 404 `{matched:false}` | statistics-client.js |
| GET (SSE) | `/api/statistics/stream` | `id` | обновления статистики | statistics-client.js |
| GET | `/api/cs2/match` | `team1`,`team2` (≤150) | статистика CS2 | cs2-panel.js (через statistics) |
| GET | `/api/team-logos/<hex32>` | — | картинка, `Cache-Control: immutable` | app.js (`eventLogo`) |

## Служебные / совместимость (сохраняются)

| Метод | URL | Назначение | Кто использует |
|---|---|---|---|
| GET | `/health`, `/` | состояние, метрики, `version`, `features` | Docker healthcheck, upgrade.sh, app.js (диагностика) |
| GET | `/api/status` | конфигурация/состояние коллекторов | диагностика |
| GET | `/api/live`, `/api/prematch` (+`meta=1`,`compact=1`) | сырые объединённые ленты | тесты, старые клиенты |
| GET | `/api/live/astek`, `/fonbet`, `/ggbet` | ленты одного провайдера | тесты |
| GET | `/api/live/history`, `/api/prematch/history` | объединённая история | старые клиенты |
| GET | `/api/live/past` | результаты за диапазон | старые клиенты |

## Известные расхождения контракта на исходной точке

1. `POST /api/ui/odds-watch` — вызывается расширением, нет на сервере (R1).
2. `deltaSince` у `/api/ui/results` — расширение отправляет, сервер игнорирует (клиент принимает полный ответ).
3. `fresh=1` у `/api/ui/event-detail` — игнорируется (деталь и так запрашивается у апстрима по требованию).
4. Форматы ошибок разнородны (`{error}`, `{ok:false,error}`, `{matched:false,error}`).

## Изменения 4.5.0: источник LIVE‑коэффициентов (`provider`)

| Метод | URL | Что добавлено |
|---|---|---|
| GET | `/api/ui/live`, `/api/live` | `provider=ggbet\|databet` (по умолчанию `ggbet` — ответ как в 4.4.0). Каждый провайдер — отдельный разрешённый вариант LIVE, источники не смешиваются; `revision`/ETag варианта DataBet оканчивается на `~databet`. В UI‑ответе `liveOddsProvider` и `providers.<provider>.oddsProvider` (статус источника). 400 — неизвестный провайдер, 503 — провайдер не запущен на сервере |
| GET | `/api/ui/event-detail` | `provider` для `view=live`: детали рынков берутся у коллектора выбранного провайдера (`marketDetailErrors.databet` при ошибке) |
| GET (SSE) | `/api/feed-stream` | `provider`: `hello.liveOddsProvider`, мета LIVE варианта провайдера, патчи LIVE только своего провайдера |
| GET | `/api/live/databet` | лента одного провайдера DataBet |
| GET | `/api/ui/odds-providers` | `{defaultProvider,providers:{ggbet,databet}}`: `connectionState`, `available`, `events`, `markets`, `lastUpdateAt`, `lastError` |
| GET | `/health`, `/api/status` | `live.databet`, `databetCollector`, `oddsProviders` |

## Изменения 4.6.0: сетевой путь коллекторов и запись в SQLite

| Метод | URL | Что добавлено |
|---|---|---|
| GET | `/health`, `/api/status` | `network{ggbet{networkMode,relayInUse},databet{networkMode},proxy{proxyEnabled,proxyHost,proxyPort,credentials,egress{ip,country,asn,org,checkedAt,error}}}` (без логина/пароля); `persistence{oddsHistoryEnabled,dbWritesSinceStart,dbOddsWritesSinceStart,oddsRecordsSkipped,writesByCategory}`; `ggbetCollector`/`databetCollector`: `networkMode`, `freshnessMs`, (`proxyHost`,`proxyPort`) |
| GET | `/api/ui/odds-providers`, `oddsProviders` в `/health` | у каждого провайдера `networkMode`, `lastMessageAt`, `freshnessMs`, `reconnects` |

Цены DataBet в `odds.markets[].prices[]` дополнительно несут `probability` (как пришла с апстрима, число) и `rawValue`
(исходная строка `value`); `decimal` = `value` для открытого исхода и `null` для закрытого.
