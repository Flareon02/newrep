# Esports Monitor

Агрегатор линий, LIVE и результатов киберспорта нескольких букмекеров (AstekBet, Fonbet, Pinnacle и источник LIVE‑коэффициентов GGBET или DataBet) с
сопоставлением матчей, историей коэффициентов, статистикой (Dota 2, CS2) и генератором модельных коэффициентов.

```
Расширение Chrome (MV3, «тонкий клиент»)  ──HTTP/SSE──►  Сервер (Node ≥ 22, один процесс, Docker, SQLite)
  extension/                                                server/
```

| Каталог | Что внутри |
|---|---|
| `server/` | Сервер 4.15.1: `src/`, тесты `test/`, `Dockerfile`, `docker-compose.yml`, скрипты установки/обновления/отката/резервной копии/очистки |
| `extension/` | Расширение 9.3.0 (без сборки) + `test/` |
| `browser-host/` | Необязательный помощник для Windows «открывать ссылки в другом браузере» (отдельный пакет, не входит в ZIP расширения) |
| `docs/` | Аудит, карта функциональности, контракт API, развёртывание, бюджет ресурсов, чек‑лист совместимости |
| `tools/` | Проверки и замеры: сравнение с оригиналом, e2e‑тест в Chromium, бенчмарки, сборка архивов релиза |

## Ветки

- `main` — **исходная точка**: оригинальные server 4.3.5 и extension 8.1.2 без изменений (кроме удалённых пустых секретов).
- `refactor/production-hardening` — рабочая ветка доработки. В `main` ничего не вливается без отдельной команды владельца.

## Быстрые команды

```sh
cd server && npm ci --omit=dev && npm test     # 219 тестов сервера
node --test extension/test/*.test.mjs           # тесты расширения
npm install && npm run lint                     # линтер (только реальные дефекты)
node tools/compare-with-original.mjs            # ORIGINAL vs NEW
npm run e2e                                     # расширение в реальном Chromium против локального сервера
python3 tools/package-release.py                # ZIP‑архивы server и extension из закоммиченных файлов
```

## Документы

- `docs/AUDIT.md` — найденные проблемы и что с ними сделано
- `docs/FUNCTIONAL-INVENTORY.md` — что умеет система (ничего не теряем)
- `docs/API-CONTRACT.md` — все эндпоинты и кто их вызывает
- `docs/DEPLOYMENT.md` — запуск на 1 vCPU / 1 GiB / 10 GB, токен, логи, диск
- `docs/PERFORMANCE-BUDGET.md` — измеренные значения и что ещё измерить
- `docs/COMPATIBILITY-CHECKLIST.md` — сохранено / исправлено / протестировано
- `docs/ORIGINAL-IMPORT.md` — как импортирован оригинал

## Persistent collector forensics (server 4.14.0)

AstekBet, Fonbet, Pinnacle, GGBET Node and Firefox IPC share a bounded private telemetry timeline. Read-only time-window queries and incident reports: [COLLECTOR_FORENSICS.md](COLLECTOR_FORENSICS.md). Existing GGBET forensic remains intact.

## SQLite match history (server 4.15.0, extension 9.2.0)

The match card **История** opens a combined score/odds change timeline from the primary SQLite database. See [MATCH_HISTORY.md](docs/MATCH_HISTORY.md) for provenance, retention, API pagination and safe enablement.
