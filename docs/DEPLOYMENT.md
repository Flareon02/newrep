# Развёртывание (1 vCPU · 1 GiB RAM · 10 GB диск)

Этот документ описывает, как запускать сервер 4.4.0 и расширение 8.2.0. Продакшен‑сервер в рамках
подготовки этой ветки **не менялся**: всё ниже проверено в песочнице, а не на боевой машине.

## 1. Как запускать backend

Один контейнер Docker, один процесс Node.js (`node src/index.js`). **Не запускайте несколько воркеров/реплик** —
процесс однопоточный по дизайну, а сопоставление матчей уже вынесено в короткоживущие `worker_threads`.

| Параметр | Значение | Где |
|---|---|---|
| Процессов / воркеров API | 1 | `CMD ["node","src/index.js"]` |
| Куча Node | 320 МиБ (`--max-old-space-size=320`) | `docker-compose.yml → NODE_OPTIONS` |
| Пул libuv | 2 потока (`UV_THREADPOOL_SIZE=2`) | compose |
| Параллелизм prematch | 1 (`PREMATCH_CONCURRENCY=1`) | compose |
| Лимит контейнера | 768 МиБ RAM, 128 процессов, `read_only`, `cap_drop: ALL`, `no-new-privileges` | compose |
| Политика перезапуска | `restart: unless-stopped`, `init: true`, `stop_grace_period: 45s` (успевает сохранить состояние) | compose |
| Проверка здоровья | `GET /health` каждые 15 с (таймаут 5 с, 3 попытки) | compose `healthcheck` |
| Пул БД | не применяется: SQLite (`node:sqlite`), одно соединение, WAL | `src/sqlite-storage.js` |
| Dev‑сервер | не используется; `NODE_ENV=production` | Dockerfile |

База данных остаётся **SQLite** (схема v3, миграций нет). Замена на PostgreSQL не требуется для такой нагрузки и
на 1 ГБ RAM только отняла бы память.

### Первая установка

```sh
unzip Esports-Monitor-server-4.4.0.zip && cd astek-monitor-server-v4.4.0
chmod +x *.sh
./install.sh            # создаёт data/, .env, собирает образ и запускает контейнер
curl -fsS http://127.0.0.1:8080/health
```

### Обновление существующего сервера (как раньше)

См. `server/START-HERE.md`: `./configure-ggbet-relay.sh /root/ggbet-relay-client.bundle` и `./upgrade.sh`.
Обновление собирает новый образ, **пока старый сервер работает**, проверяет `/health`, ленты, SSE и 6 стабильных
замеров подряд, а при неудаче само откатывается. Данные (`/data`, SQLite) используются те же, миграции нет.
Откат вручную: `./rollback.sh`. Резервная копия: `./backup.sh` (останавливает контейнер на время копирования).

### Как собрать архивы релиза

```sh
python3 tools/package-release.py     # dist/Esports-Monitor-server-4.4.0.zip и dist/Esports-Monitor-extension-8.2.0.zip
```

Архивы строятся только из закоммиченных файлов (секреты и локальные данные попасть не могут). В серверный архив
добавляются два пустых файла‑заглушки `secrets/…` — реальные значения создаёт `configure-ggbet-relay.sh`.

## 2. Переменные окружения (`server/.env`)

Файл `.env` не хранится в Git; шаблон — `server/.env.example`. Все переменные необязательны.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `API_TOKEN` | пусто (открыто, как в 4.3.5) | Общий секрет ≥ 16 символов для POST‑ручек, публикации связей лиг и поиска HLTV. Сгенерировать: `openssl rand -hex 24`. Если задан, но короче 16 символов, сервер **не падает**, а отказывает всем защищённым запросам (503 с пояснением; `/health → security.writeAuth = misconfigured`) |
| `LOG_LEVEL` | `info` | `error` · `warn` · `info` · `debug` (debug пишет каждый опрос — только для диагностики) |
| `ODDS_RETENTION_DAYS` / `SCORE_RETENTION_DAYS` / `STATISTICS_RETENTION_DAYS` | `0` (хранить всё) | Удалять целиком события, последняя запись которых старше N дней |
| `HISTORY_MAX` / `HISTORY_TTL_MS` | 100000 / 1 год | Размер History в памяти (≈1,1 КБ на строку, 7 снимков) |
| `API_SSE_LIMIT_TOTAL` / `API_SSE_LIMIT_PER_IP` / `API_MAX_CONNECTIONS` | 64 / 24 / 256 | Защита от исчерпания соединений |
| `GGBET_BOOTSTRAP_RELAY_URL` | пусто | Адрес relay (создаётся `configure-ggbet-relay.sh`) |
| `DATABET_LIVE_ENABLED` | `1` | LIVE‑коэффициенты DataBet (публичный demo.data.bet, гостевой токен со страницы, только в памяти). `0` — выключить |
| `DATABET_ORIGIN` / `DATABET_LOCALE` | `https://demo.data.bet` / `en` | Страница, с которой берётся гостевая сессия DataBet (только хосты `*.data.bet`) |
| `DATABET_FULL_MARKETS_TTL_MS` / `DATABET_MAX_FULL_EVENTS` | 180000 / 4 | Полное дерево рынков DataBet держится только для матчей с открытым диалогом коэффициентов |
| `GGBET_NETWORK_MODE` | не задан (= `relay`, если задан `GGBET_BOOTSTRAP_RELAY_URL`, иначе `direct`) | `proxy` — и загрузка страницы/гостевого токена, и GraphQL WebSocket идут через HTTP CONNECT прокси `CZECH_PROXY_*` (relay не используется); `relay` — токен через relay, WebSocket напрямую; `direct` — всё напрямую |
| `DATABET_NETWORK_MODE` | `direct` | `proxy` — страница demo.data.bet (токен) и WebSocket через тот же прокси; `direct` — напрямую |
| `CZECH_PROXY_ENABLED` / `CZECH_PROXY_HOST` / `CZECH_PROXY_PORT` | `0` / — / — | HTTP CONNECT прокси для режима `proxy`. Если режим `proxy`, а прокси выключен или не задан, коллектор **не** подключается напрямую, а показывает ошибку |
| `CZECH_PROXY_USERNAME` / `CZECH_PROXY_PASSWORD` | — | Секрет. Используются как заданы (sticky‑сессия в имени пользователя не меняется), только в памяти процесса; в логах, ошибках и `/health` не появляются |
| `ODDS_HISTORY_ENABLED` | `1` | `0` — не писать в SQLite журнал коэффициентов (`odds_entries_v3`, `odds_state`) и текущие снимки с деревьями рынков (`snapshot_current`); LIVE после рестарта стартует пустым и наполняется с апстрима. Уже сохранённая история не удаляется и остаётся читаемой |
| `HOST_DATA_DIR`, `COMPOSE_PROJECT_NAME` | пишет `upgrade.sh` | Каталог данных на хосте и имя проекта Compose |
| `PINNACLE_API_KEY` | получается автоматически | Необязательное переопределение ключа Pinnacle |

Остальные настройки интервалов/лимитов задаются в `docker-compose.yml` (значения подобраны под 1 vCPU; менять без
замеров не рекомендуется).

## 3. Логи и ротация

- Docker‑драйвер `local`, `max-size: 10m`, `max-file: 3` → **не более 30 МиБ**. Ротация включена в `docker-compose.yml`.
- Уровень по умолчанию `info`: запуск, предупреждения и ошибки. Штатные опросы (`[live] unchanged`, `… events`) —
  только при `LOG_LEVEL=debug`. Одинаковые повторяющиеся строки (например, отказ апстрима) схлопываются.
- Секреты маскируются (`token`, `apiKey`, `password`, `Authorization`, `cookie`, `Bearer …`).
- Посмотреть: `docker logs --tail 100 astek-monitor`.

## 4. Диск (10 GB)

- Следите за `/health → runtime.storage` (`freeMiB`, `sizeMiB`, `oddsRows`, `diskLevel`). Ниже 1024 МиБ свободного места
  `diskLevel` = `low` и раз в час пишется предупреждение; ниже 512 МиБ — `critical`.
- Когда журнал коэффициентов начнёт занимать заметное место, включите ограничение, например в `.env`:
  `ODDS_RETENTION_DAYS=365` и перезапустите (`docker compose up -d`). Удаляются только целые события, **последнее
  обновление которых старше срока и которых уже нет ни в одной ленте** (LIVE/линия); матч, который ещё в ленте, свою
  историю не теряет, даже если его коэффициенты давно не менялись. Файл SQLite после
  удаления не сжимается, но перестаёт расти (освободившиеся страницы переиспользуются).
- Раз в несколько недель: `./prune-old-releases.sh` (показывает), затем `./prune-old-releases.sh --apply`. Скрипт
  не трогает данные, работающий контейнер, цель отката и образы, которые использует хоть один контейнер.
- `./backup.sh` каждый раз создаёт `…tar.gz` в `/root` — их удаляет `prune-old-releases.sh` (оставляет 3 последних).

## 5. Безопасность

1. **Токен записи.** Сгенерируйте `API_TOKEN`, добавьте в `server/.env`, перезапустите контейнер, затем введите то же
   значение в расширении: *Настройки → Сервер → Токен доступа*. Без токена (пустое значение) поведение прежнее.
   Что защищено: все POST, `GET /api/league-links/challenge`, `GET /api/hltv/{search,team,player}`. Чтение лент
   остаётся открытым: браузерный `EventSource` не умеет отправлять заголовки, а данные — публичные линии.
2. **Шифрование.** Сервер слушает обычный HTTP. Токен и правила лиг идут открытым текстом, пока перед сервером нет
   TLS. Минимальный вариант — обратный прокси (например Caddy) с сертификатом на домен; в расширении укажите
   `https://домен`, а порт сервера привяжите к локальному интерфейсу (`ports: "127.0.0.1:8080:8080"`). Это
   необязательно и в этой ветке не включено.
3. **Root в контейнере.** Контейнер работает от root, но с `read_only`, `cap_drop: ALL`, `no-new-privileges`. Перевод на
   обычного пользователя требует сменить владельца `data/` на хосте и не сделан автоматически, чтобы не сломать запись
   в существующую базу.
4. **Секреты** не хранятся в репозитории: `secrets/` и `.env` в `.gitignore`; сборка архива берёт только закоммиченное.

## 6. Расширение

Сборки нет — это исходники Manifest V3. Установка: `chrome://extensions` → «Режим разработчика» → «Загрузить
распакованное» → папка `extension/` (или распаковать `Esports-Monitor-extension-8.2.0.zip`). Обновление: заменить файлы
и нажать «Обновить» на карточке расширения. Проверка до публикации (без установки):

```sh
node --test extension/test/*.test.mjs       # манифест, скрипты, server-config
npm run e2e                                  # реальный Chromium + расширение + локальный сервер (нужен Playwright)
```

Адрес по умолчанию прежний (`http://87.199.202.237:8080`), менять его можно в настройках расширения. Помощник для
открытия ссылок в другом браузере (`browser-host/`) ставится, как и раньше, скриптом `Install-BrowserHost.ps1`.

## 7. Проверка после обновления

```sh
curl -fsS http://127.0.0.1:8080/health | head -c 600        # version 4.4.0, storage.integrity ok
docker logs --tail 50 astek-monitor                         # без «fatal», «unhandled»
docker stats astek-monitor --no-stream                      # RAM далеко от 768 МиБ
docker inspect -f '{{.State.OOMKilled}} {{.RestartCount}}' astek-monitor   # false 0
```

В `/health` проверьте: `runtime.history.level` = `ok`, `runtime.storage.diskLevel` = `ok`,
`security.writeAuth` = `token` (если токен задан), `runtime.eventLoopMaxMs` < 1000.
