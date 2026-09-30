# Esports Monitor

Агрегатор линий, LIVE и результатов киберспорта нескольких букмекеров (AstekBet, Fonbet, GGBET, Pinnacle) с
сопоставлением матчей, историей коэффициентов, статистикой (Dota 2, CS2) и генератором модельных коэффициентов.

```
Расширение Chrome (MV3, «тонкий клиент»)  ──HTTP/SSE──►  Сервер (Node ≥ 22, один процесс, Docker, SQLite)
  extension/                                                server/
```

| Каталог | Что внутри |
|---|---|
| `server/` | Сервер 4.4.0: `src/`, тесты `test/`, `Dockerfile`, `docker-compose.yml`, скрипты установки/обновления/отката/резервной копии/очистки |
| `extension/` | Расширение 8.2.0 (без сборки) + `test/` + `browser-host/` (помощник для Windows) |
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
