# Market coverage (semantics v2)

Generated 2026-10-06T08:56:52.899Z by `tools/market-coverage.mjs` from a read-only copy of the production journal (175104 journal rows, 49709 of them written before 4.15).
Every market change was described with the server's own registry. **Unknown = not classified on purpose**: the structured ids do not prove what the bet is.

| Bookmaker | market changes | coverage by volume — all rows | — rows written by 4.15+ | — legacy rows (≤4.14) | signatures known / total |
|---|---:|---:|---:|---:|---:|
| AstekBet | 148689 | 68.4 % | 91.46 % of 111203 | 0 % of 37486 | 43 / 200 |
| Pinnacle | 35993 | 37.08 % | 87.48 % of 13748 | 5.93 % of 22245 | 8 / 11 |
| Fonbet | 312063 | 60.78 % | 94.39 % of 200921 | 0 % of 111142 | 81 / 111 |
| GGBET | 2657290 | 99.99 % | 100 % of 849968 | 99.98 % of 1807322 | 140 / 143 |

## AstekBet

Known families (market changes): `match_winner` 25317, `map_handicap` 18249, `handicap` 13680, `round_total` 10979, `round_handicap` 9728, `map_total` 9124, `total` 6919, `team_total` 4081, `team_round_total` 1310, `round_winner` 428, `map_winner` 422, `half_1x2` 317, `kills_total` 163, `kills_handicap` 144, `overtime` 127, `half_double_chance` 121, `round_parity` 111, `race_to_rounds` 110, `race_to_kills` 96, `team_wins_a_map` 96, `map_parity` 79, `kills_parity` 66, `pistol_round_winner` 40

Unknown types:

- `0` — 37486 changes · sport n/a · e.g. «» · outcomes: 0=; 1=
- `136` — 3443 changes · Counter Strike 2, Dota 2, League of Legends, Standoff 2, Mobile Legends, Valorant, Rainbow Six Siege · e.g. «Раунд команды 1 в интервале», «Точный счёт» · outcomes: 3044=Точный счет 1.002-1.002 - Да 1.002
- `10210` — 639 changes · Counter Strike 2, Valorant · e.g. «Половина, точный счет» · outcomes: 13129=1001.002 половина точный счет 1001.002-1001.002 1001.002
- `2665` — 637 changes · Counter Strike 2, Dota 2 · e.g. «Победитель и тотал» · outcomes: 192=^2^ победит и тотал > 17.5 - Да 17.5; 212=^2^ победит и тотал > 17.5 - Нет 17.5
- `2663` — 591 changes · Counter Strike 2, Dota 2 · e.g. «Победитель и тотал» · outcomes: 197=^1^ победит и тотал > 17.5 - Да 17.5; 207=^1^ победит и тотал > 17.5 - Нет 17.5
- `10207` — 358 changes · Counter Strike 2, Valorant · e.g. «Половина, Фора» · outcomes: 13123=-1.0005 половина фора 1 -1.0005 -1.0005
- `1052` — 302 changes · Counter Strike 2 · e.g. «Тотал фрагов в раунде» · outcomes: 2142=в раунде Б 11.075; 2143=в раунде М 11.075
- `10558` — 230 changes · Counter Strike 2, Valorant · e.g. «Фора (без учета ОТ)» · outcomes: 14131=1 -1.5 (без учета ОТ) -1.5; 14132=2 -1.5 (без учета ОТ) -1.5
- `7603` — 219 changes · Counter Strike 2 · e.g. «Победа с преимуществом» · outcomes: 6476=П1 в 11 и более 11; 6478=П2 в 11 и более 11
- `1060` — 184 changes · Counter Strike 2 · e.g. «Тотал хедшотов в раунде» · outcomes: 2150=в раунде 11.025 Б 11.025; 2151=в раунде 11.025 М 11.025
- `11636` — 182 changes · Counter Strike 2 · e.g. «Рынок 5611» · outcomes: 16848=Исход 16848 11.012; 16849=Исход 16849 11.012
- `11637` — 182 changes · Counter Strike 2 · e.g. «Рынок 5612» · outcomes: 16850=Исход 16850 11; 16851=Исход 16851 11
- `11502` — 174 changes · Dota 2 · e.g. «Последняя цифра общего числа фрагов» · outcomes: 16477=Исход 16477 104.008
- `9562` — 164 changes · League of Legends, Counter Strike 2 · e.g. «Игрок, тотал фрагов» · outcomes: 10816=[] - 0.5 Б 0.5; 10817=[] - 0.5 М 0.5
- `864` — 116 changes · Counter Strike 2 · e.g. «Победа с преимуществом» · outcomes: 2832=П1 в 2 2; 2833=П2 в 2 2
- `9541` — 116 changes · Dota 2 · e.g. «Победа 1-го и продолжительность карты», «Победа 2-го и продолжительность карты» · outcomes: 10763=42 Б - Да 42; 10764=42 Б - Нет 42; 10765=42 М - Да 42; 10766=42 М - Нет 42
- `8669` — 107 changes · Counter Strike 2 · e.g. «Команда 2, разница выигранных раундов» · outcomes: 8290=^2^ победит с преимуществом в 10.013-10.013 раундов 10.013
- `1062` — 106 changes · Counter Strike 2 · e.g. «Индивидуальный тотал фрагов в раунде» · outcomes: 2154=Команда 2 в раунде Б 13.035; 2155=Команда 2 в раунде М 13.035
- `8667` — 97 changes · Counter Strike 2 · e.g. «Команда 1, разница выигранных раундов» · outcomes: 8288=^1^ победит с преимуществом в 2.005-2.005 раундов 2.005
- `10908` — 89 changes · Dota 2 · e.g. «Рынок 4857» · outcomes: 15082=Исход 15082 10; 15083=Исход 15083 10
- `11620` — 89 changes · Dota 2 · e.g. «Рынок 4928» · outcomes: 15252=Исход 15252 10; 15253=Исход 15253 10
- `2979` — 80 changes · League of Legends, Dota 2, Mobile Legends · e.g. «Продолжительность карты» · outcomes: 3963=29 Б 29; 3964=29 М 29
- `1056` — 76 changes · Counter Strike 2 · e.g. «Первый фраг в раунде у команды» · outcomes: 2146=раунд - Команда 1 13; 2147=раунд - Команда 2 13
- `10110` — 69 changes · Counter Strike 2 · e.g. «Исход + тотал раундов» · outcomes: 12829=П1 + ТБ 21.5 - Да 21.5; 12831=П1 + ТМ 21.5 - Да 21.5; 12833=П2 + ТБ 21.5 - Да 21.5; 12835=П2 + ТМ 21.5 - Да 21.5
- `10926` — 65 changes · Counter Strike 2 · e.g. «Рынок 4878» · outcomes: 15129=Исход 15129 0.002
- `8683` — 64 changes · Counter Strike 2, Valorant · e.g. «Кто выиграет половину» · outcomes: 13274=Ничья в 1-й половине - Да 1; 8355=^1^ победит в 1-й половине - Да 1; 8357=^2^ победит в 1-й половине - Да 1
- `10565` — 60 changes · Counter Strike 2, Valorant · e.g. «Победа с преимуществом (без учета ОТ)» · outcomes: 14145=П1 в 2.005-2.005 (без учета ОТ) 2.005; 14146=П2 в 2.005-2.005 (без учета ОТ) 2.005
- `1066` — 58 changes · Counter Strike 2 · e.g. «Тип победы в раунде» · outcomes: 2160=Бомба взорвана в 13 раунде 13; 2161=Бомба обезврежена в 13 раунде 13; 2162=Победа по времени в 13 раунде 13; 11842=Соперники уничтожены в 13 раунде 13
- `8641` — 51 changes · League of Legends, Dota 2 · e.g. «Команда 1, тотал фрагов» · outcomes: 8253=^1^, фраги, ТБ 11.5 11.5; 8254=^1^, фраги, ТМ 11.5 11.5
- `1068` — 50 changes · Counter Strike 2 · e.g. «Будет ли заложена бомба в раунде» · outcomes: 2164=раунд - Да 13; 2165=раунд - Нет 13
- `8643` — 47 changes · League of Legends, Dota 2 · e.g. «Команда 2, тотал фрагов» · outcomes: 8255=^2^, фраги, ТБ 23.5 23.5; 8256=^2^, фраги, ТМ 23.5 23.5
- `10208` — 47 changes · Counter Strike 2, Valorant · e.g. «Половина, Индивидуальный тотал 1-го» · outcomes: 13125=1.0045 половина индивидуальный тотал 1 Больше 1.0045 1.0045; 13126=1.0045 половина индивидуальный тотал 1 Меньше 1.0045 1.0045
- `10209` — 47 changes · Counter Strike 2, Valorant · e.g. «Половина, Индивидуальный тотал 2-го» · outcomes: 13127=1.0065 половина индивидуальный тотал 2 Больше 1.0065 1.0065; 13128=1.0065 половина индивидуальный тотал 2 Меньше 1.0065 1.0065
- `11094` — 46 changes · Counter Strike 2 · e.g. «Рынок 5055» · outcomes: 15487=Исход 15487; 15488=Исход 15488
- `2500` — 43 changes · League of Legends, Dota 2, Mobile Legends · e.g. «First blood» · outcomes: 2991=П1; 2992=П2
- `14` — 34 changes · Rainbow Six Siege, Dota 2, Counter Strike 2, Standoff 2 · e.g. «Чет / Нечет» · outcomes: 182=Тотал чет - Да; 183=Тотал чет - Нет
- `10391` — 27 changes · Counter Strike 2 · e.g. «Первая половина/карта» · outcomes: 13633=П1/П1; 13635=П2/П1; 15531=Исход 15531; 13634=П1/П2; 13636=П2/П2; 15532=Исход 15532
- `28` — 25 changes · Counter Strike 2 · e.g. «Тотал промежуток» · outcomes: 1770=- Да 21; 1771=- Нет 21
- `11093` — 20 changes · Counter Strike 2 · e.g. «Рынок 5054» · outcomes: 15485=Исход 15485; 15486=Исход 15486
- `2687` — 20 changes · Dota 2, Mobile Legends · e.g. «Фраги, тотал чет/нечет» · outcomes: 3459=Тотал фрагов чет - Да; 3460=Тотал фрагов чет - Нет
- `7023` — 19 changes · League of Legends, Dota 2 · e.g. «Тотал разрушенных башен» · outcomes: 5650=Тотал разрушенных башен 11.5 Б 11.5; 5651=Тотал разрушенных башен 11.5 М 11.5
- `10754` — 19 changes · League of Legends, Counter Strike 2 · e.g. «Игроки, сравнение, фраги» · outcomes: 14612=фора 1 -0.5; 14613=фора 2 -0.5
- `10972` — 19 changes · Dota 2 · e.g. «Героев в живых при разрушении трона» · outcomes: 15250=Исход 15250 5.5; 15251=Исход 15251 5.5
- `7047` — 18 changes · Counter Strike 2 · e.g. «Molotov/Incendiary Grenade Kill» · outcomes: 5683=Molotov/Incendiary Grenade Kill - Да; 5684=Molotov/Incendiary Grenade Kill - Нет
- `7576` — 18 changes · League of Legends, Dota 2 · e.g. «Кто сделает следующий фраг» · outcomes: 6419=15 фраг - Команда 1 15; 6420=15 фраг - Команда 2 15
- `7049` — 17 changes · Counter Strike 2 · e.g. «HE Grenade Kill» · outcomes: 5685=HE Grenade Kill - Да; 5687=HE Grenade Kill - Нет
- `7045` — 17 changes · Counter Strike 2 · e.g. «Knife Kill» · outcomes: 5681=Knife Kill - Да; 5682=Knife Kill - Нет
- `2288` — 17 changes · Dota 2 · e.g. «Кто разрушит следующую башню» · outcomes: 2596=1 башня команда 1 1; 2597=1 башня команда 2 1
- `11091` — 16 changes · Counter Strike 2 · e.g. «Рынок 5052» · outcomes: 15481=Исход 15481; 15482=Исход 15482
- `11092` — 16 changes · Counter Strike 2 · e.g. «Рынок 5053» · outcomes: 15483=Исход 15483; 15484=Исход 15484
- `2850` — 16 changes · Counter Strike 2, Dota 2, Rainbow Six Siege · e.g. «Карта/Матч» · outcomes: 3820=Первая карта/матч ^1^/^1^; 3821=Первая карта/матч ^1^/^2^; 3822=Первая карта/матч ^2^/^1^; 3823=Первая карта/матч ^2^/^2^
- `2494` — 15 changes · Dota 2 · e.g. «Карта завершится днем» · outcomes: 2986=Да; 2987=Нет
- `7600` — 13 changes · League of Legends · e.g. «Тотал разрушенных Ингибиторов.» · outcomes: 6448=ТБ 1.5 1.5; 6449=ТМ 1.5 1.5
- `10564` — 13 changes · Counter Strike 2 · e.g. «Результат и тотал (без учета ОТ)» · outcomes: 14143=П1 и тотал > 20.5 - Да (без учета ОТ) 20.5; 15130=Исход 15130 20.5; 14144=П2 и тотал > 20.5 - Да (без учета ОТ) 20.5; 15131=Исход 15131 20.5
- `6989` — 13 changes · Dota 2 · e.g. «Godlike streak» · outcomes: 5602=Godlike streak - Да; 5603=Godlike streak - Нет
- `2294` — 12 changes · League of Legends · e.g. «Кто возьмет следующего нашора» · outcomes: 2602=1 нашор команда 1 1; 2603=1 нашор команда 2 1
- `3199` — 12 changes · League of Legends · e.g. «Кто первым разрушит Inhibitor» · outcomes: 4361=Команда 1; 4362=Команда 2
- `11497` — 12 changes · Counter Strike 2 · e.g. «Рынок 5471» · outcomes: 16465=Исход 16465; 16466=Исход 16466
- `11543` — 12 changes · Dota 2 · e.g. «Рынок 5517» · outcomes: 16581=Исход 16581; 16582=Исход 16582
- `11544` — 12 changes · Dota 2 · e.g. «Рынок 5518» · outcomes: 16583=Исход 16583; 16584=Исход 16584
- `10907` — 12 changes · Dota 2 · e.g. «Победитель + чётность фрагов» · outcomes: 15078=Исход 15078; 15080=Исход 15080; 15079=Исход 15079; 15081=Исход 15081
- `8255` — 11 changes · Counter Strike 2 · e.g. «Угловые в первые 5 минут матча» · outcomes: 2064=П1 в 1.012-1.012 раунде 1.012; 2065=П2 в 1.012-1.012 раунде 1.012
- `9806` — 10 changes · Dota 2 · e.g. «Мегакрипы появятся» · outcomes: 11792=Да; 11793=Нет
- `11509` — 9 changes · League of Legends · e.g. «Рынок 5483» · outcomes: 16494=Исход 16494 5.0075; 16495=Исход 16495 5.0075
- `10176` — 9 changes · Dota 2 · e.g. «Счет после первых 2-х карт» · outcomes: 13022=0.002-0.002 0.002
- `11506` — 8 changes · League of Legends, Dota 2 · e.g. «Рынок 5480» · outcomes: 16489=Исход 16489 -10.0045
- `7021` — 8 changes · League of Legends · e.g. «Тотал взятия Нашора» · outcomes: 5646=Тотал взятия Нашора 1.5 Б 1.5; 5647=Тотал взятия Нашора 1.5 М 1.5
- `7148` — 8 changes · Dota 2 · e.g. «Тотал уничтоженных Рошанов» · outcomes: 5865=0.5 Б 0.5; 5866=0.5 М 0.5
- `170` — 8 changes · Standoff 2 · e.g. «Команда 1 победит в овертайме», «Команда 2 победит в овертайме» · outcomes: 981=Да; 982=Нет
- `7022` — 6 changes · League of Legends · e.g. «Тотал взятия дракона» · outcomes: 5648=Тотал взятия дракона 4.5 Б 4.5; 5649=Тотал взятия дракона 4.5 М 4.5
- `9796` — 6 changes · League of Legends · e.g. «Penta Kill» · outcomes: 11769=Да
- `9795` — 6 changes · League of Legends · e.g. «Quadra Kill» · outcomes: 11767=Да
- `7578` — 6 changes · Dota 2 · e.g. «Кто разрушит следующий барак» · outcomes: 6421=1 барак - Команда 1 1; 6422=1 барак - Команда 2 1
- `11170` — 6 changes · Dota 2 · e.g. «Кто первый разрушит барак» · outcomes: 15681=^1^ первой разрушит барак; 15682=^2^ первой разрушит барак
- `11171` — 6 changes · Dota 2 · e.g. «Кто первый убьет Рошана» · outcomes: 15683=^1^ первой убьет Рошана; 15684=^2^ первой убьет Рошана
- `9877` — 6 changes · Counter Strike 2 · e.g. «Тотал фрагов пары игроков» · outcomes: 11969=[] 29.5 Б 29.5; 11970=[] 29.5 М 29.5
- `9681` — 5 changes · League of Legends · e.g. «Тотал ассистов игрока» · outcomes: 11419=[] ТБ 10.5 10.5; 11420=[] ТМ 10.5 10.5
- `10991` — 5 changes · Dota 2 · e.g. «Рынок 4947» · outcomes: 15290=Исход 15290 2.059; 15291=Исход 15291 2.059
- `10647` — 4 changes · League of Legends · e.g. «Наибольший Multi-Kill» · outcomes: 14353=Single-Kill; 14354=Double-Kill; 14355=Triple-Kill; 14356=Quadra-Kill; 14357=Penta-Kill
- `7590` — 4 changes · League of Legends · e.g. «Обе команды возьмут дракона» · outcomes: 6437=Да; 6438=Нет
- `7592` — 4 changes · League of Legends · e.g. «Обе команды возьмут Нашора» · outcomes: 6439=Да; 6440=Нет
- `7596` — 4 changes · League of Legends · e.g. «Обе команды разрушат Ингибитор» · outcomes: 6444=Да; 6445=Нет
- `9479` — 4 changes · League of Legends · e.g. «Тип дракона» · outcomes: 10536=1 Стихийный Дракон - морской 1; 10537=1 Стихийный Дракон - облачный 1; 10538=1 Стихийный Дракон - огненный 1; 10539=1 Стихийный Дракон - горный 1; 14337=1 Стихийный Дракон - хекстековый 1; 14338=1 Стихийный Дракон - химтеховый 1
- `10982` — 4 changes · Dota 2 · e.g. «Рынок 4938» · outcomes: 15273=Исход 15273 2.5; 15274=Исход 15274 2.5
- `10985` — 4 changes · Dota 2 · e.g. «Рынок 4941» · outcomes: 15279=Исход 15279 2.5; 15280=Исход 15280 2.5
- `11507` — 4 changes · Dota 2 · e.g. «Рынок 5481» · outcomes: 16490=Исход 16490 -14.0015
- `2292` — 4 changes · Dota 2 · e.g. «Кто возьмет следующего рошана» · outcomes: 2600=1 рошан команда 1 1; 2601=1 рошан команда 2 1
- `11640` — 4 changes · Counter Strike 2 · e.g. «Рынок 5615» · outcomes: 15125=Исход 15125; 15127=Исход 15127; 15126=Исход 15126; 15128=Исход 15128
- `11599` — 4 changes · Counter Strike 2 · e.g. «Рынок 5575» · outcomes: 16761=Исход 16761
- `11600` — 4 changes · Counter Strike 2 · e.g. «Рынок 5576» · outcomes: 16762=Исход 16762
- `11601` — 4 changes · Counter Strike 2 · e.g. «Рынок 5577» · outcomes: 16763=Исход 16763
- `11602` — 4 changes · Counter Strike 2 · e.g. «Рынок 5578» · outcomes: 16764=Исход 16764
- `11604` — 4 changes · Counter Strike 2 · e.g. «Рынок 5580» · outcomes: 16766=Исход 16766; 16767=Исход 16767
- `11605` — 4 changes · Counter Strike 2 · e.g. «Рынок 5581» · outcomes: 16768=Исход 16768; 16769=Исход 16769
- `10648` — 3 changes · League of Legends · e.g. «Время фрага» · outcomes: 14358=5906.009 фраг до 5906.009 мин 5906.009 сек - Да 5906.009; 14359=5906.009 фраг до 5906.009 мин 5906.009 сек - Нет 5906.009
- `10980` — 3 changes · Dota 2 · e.g. «Рынок 4935» · outcomes: 15269=Исход 15269; 15270=Исход 15270
- `11598` — 3 changes · Counter Strike 2 · e.g. «Рынок 5574» · outcomes: 16760=Исход 16760
- `11603` — 3 changes · Counter Strike 2 · e.g. «Рынок 5579» · outcomes: 16765=Исход 16765
- `9876` — 3 changes · Counter Strike 2 · e.g. «Тотал фрагов пары игроков, Чет/Нечет» · outcomes: 11967=[] - Чет; 11968=[] - Нечет
- `10755` — 2 changes · League of Legends · e.g. «Игроки, сравнение, ассисты» · outcomes: 14614=фора 1 -0.5; 14615=фора 2 -0.5
- `7957` — 2 changes · League of Legends · e.g. «Тотал смертей игрока» · outcomes: 6945=[] ТБ 2.5 2.5; 6946=[] ТМ 2.5 2.5
- `11088` — 2 changes · League of Legends · e.g. «Рынок 5048» · outcomes: 15475=Исход 15475 -0.5
- `10462` — 2 changes · League of Legends · e.g. «Фора по разрушенным башням» · outcomes: 13821=2 -1.5 -1.5
- `9549` — 2 changes · Dota 2 · e.g. «Будет куплен» · outcomes: 10785=[] - Да 1; 10786=[] - Нет 1
- `9809` — 2 changes · Dota 2 · e.g. «Какая из команд сделает First Blood и выиграет карту» · outcomes: 11798=Команда 1; 11799=Команда 2
- `10619` — 2 changes · Dota 2 · e.g. «Победитель и тотал фрагов» · outcomes: 14271=П1 и 73.5 Б 73.5; 14273=П2 и 73.5 Б 73.5; 14272=П1 и 73.5 М 73.5; 14274=П2 и 73.5 М 73.5
- `11285` — 2 changes · Dota 2 · e.g. «Рынок 5257» · outcomes: 15961=Исход 15961 33.5; 15963=Исход 15963 33.5; 15962=Исход 15962 33.5; 15964=Исход 15964 33.5
- `9807` — 2 changes · Dota 2 · e.g. «Aegis of the Immortal будет украден» · outcomes: 11794=Да; 11795=Нет
- `90` — 2 changes · Counter Strike 2 · e.g. «Будет овертайм» · outcomes: 759=Будет овертайм - Да; 761=Будет овертайм - Нет
- `7887` — 1 changes · Counter Strike 2 · e.g. «Кто выше по кол-ву фрагов» · outcomes: 6864=[] - П1; 6865=[] - X; 6866=[] - П2
- `2685` — 1 changes · League of Legends · e.g. «Фраги, тотал» · outcomes: 3457=Тотал фрагов 102.5 Б 102.5; 3458=Тотал фрагов 102.5 М 102.5

## Pinnacle

Known families (market changes): `round_handicap` 4297, `round_total` 2735, `team_round_total` 2675, `map_winner` 2030, `match_winner` 1220, `round_winner` 153, `half_round_handicap` 93, `half_team_round_total` 80, `half_1x2` 44, `team_kills_total` 10, `kills_handicap` 5, `kills_total` 5

Unknown types:

- `0` — 20925 changes · sport n/a · e.g. «» · outcomes: 0= 1.5; 1= -1.5
- `spread` — 1138 changes · Valorant, Counter Strike 2, Mobile Legends, Dota 2, League of Legends · e.g. «spread» · outcomes: home=home -1.5; away=away 1.5
- `total` — 583 changes · Valorant, Counter Strike 2, Mobile Legends, Dota 2, League of Legends · e.g. «total» · outcomes: over=over 2.5; under=under 2.5

## Fonbet

Known families (market changes): `round_handicap` 91381, `round_total` 44319, `match_winner` 14852, `map_winner` 14611, `map_handicap` 7702, `map_total` 6011, `kills_total` 5854, `kills_handicap` 3540, `total` 627, `handicap` 618, `map_1x2` 144

Unknown types:

- `0` — 111142 changes · sport n/a · e.g. «» · outcomes: 0=
- `handicap` — 6744 changes · Counter Strike 2, Dota 2, League of Legends, Rainbow Six Siege, Mobile Legends, Valorant · e.g. «Фора» · outcomes: 3265=2 +1.5
- `total` — 4455 changes · Valorant, Counter Strike 2, League of Legends · e.g. «Тотал» · outcomes: 1739=Исход 1739 55.5
- `unknown` — 63 changes · Counter Strike 2 · e.g. «Рынок 3266», «Рынок 1791», «Рынок 3265», «Рынок 1739» · outcomes: 3266=Исход 3266 -1.5

## GGBET

Known families (market changes): `player_kills_total` 649432, `player_deaths_total` 439445, `asian_round_handicap` 323197, `round_handicap` 262746, `team_round_total` 103706, `round_winner` 87109, `round_total` 85906, `half_round_handicap` 78782, `player_duel_handicap` 78705, `winning_margin` 55142, `race_to_rounds` 51327, `player_duel_1x2` 45981, `player_duel_winner` 43148, `match_winner` 43069, `winner_and_total_over` 33135, `round_handicap_3way` 29027, `winner_and_total_under` 27940, `asian_round_total` 26884, `half_1x2` 18819, `map_handicap` 18594, `bomb_planted` 18544, `round_total_3way` 15297, `pistol_round_winner` 14406, `half_team_round_total` 11740, `map_winner` 10686, `nth_kill` 8723, `winner_and_kills_total` 8397, `map_total` 7137, `ace_in_round` 6762, `correct_map_score` 5318, `map_1x2` 4644, `first_kill_in_round` 4230, `map_parity` 4030, `correct_score` 3656, `race_to_kills` 3456, `most_deaths_player` 2815, `half_correct_score` 2554, `kills_total_at_minute` 2495, `most_kills_player` 2466, `kills_handicap` 2372, `way_to_win` 2104, `kills_total` 2053, `overtime` 1553, `winner_and_duration` 1508, `team_kills_total` 1246, `map_duration` 1122, `round_parity` 1095, `kills_parity` 945, `first_half_and_map_winner` 915, `winner_and_kills_parity` 794, `pistol_correct_score` 483, `overtime_round_handicap` 436, `provider_special` 293, `baron_type` 225, `first_blood` 98, `dragons_total` 55, `first_baron` 45, `both_teams_dragon` 43, `towers_total` 36, `barons_total` 22, `first_dragon_type` 13, `first_roshan` 7, `winner_by_roshan_kills` 7, `roshan_kills_1x2` 6, `overtime_1x2` 3, `both_teams_roshan` 3, `first_courier_kill` 3, `ultra_kill` 2, `aegis_snatch` 2, `rampage` 2

Unknown types:

- `1646` (gamenr, top) — 271 changes · sport n/a · e.g. «Game 6 - Will player get top» · outcomes: 0=; 1=
- `449` (mapnr, total) — 53 changes · sport n/a · e.g. «1st Mapa - Defenders suma rundow» · outcomes: 0= 6.5; 1= 6.5
- `448` (mapnr, total) — 25 changes · sport n/a · e.g. «1st Mapa - Atakujący suma rundow» · outcomes: 0= 5.5; 1= 5.5
