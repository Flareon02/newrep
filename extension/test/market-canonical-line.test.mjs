import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (file) => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const ctx = vm.createContext({ console });
vm.runInContext(read('astek-market-names.js') + '\n' + read('market-canonical.js') + '\n;globalThis.MarketCanonical = MarketCanonical;', ctx);
const MC = ctx.MarketCanonical;
const event = { team1: 'Team Fjord', team2: 'Funqo Academy' };

test('odd/even market with an Astek key never shows the event id as its line', () => {
  // Shape of the market seen in 9.0: Astek key starts with the event id, outcomes are odd/even without points.
  const m = { key: '757782506:0:1:1:', type: 'map-total', title: 'Тотал по картам Чет/Нечет', period: 0, status: 'open', prices: [{ designation: 'home', label: 'Тотал по картам - Чет', decimal: 1.87 }, { designation: 'away', label: 'Тотал по картам - Нечет', decimal: 1.85 }] };
  assert.equal(MC.line(m), null);
  assert.equal(MC.describe(m, event, 'astek').line ?? null, null);
  // The same market as an odd/even pair of designations (platform providers) has no line either.
  assert.equal(MC.line({ key: '96m3', type: 'total', title: 'Map 3 - Total kills odd/even', prices: [{ designation: 'odd', label: 'Odd' }, { designation: 'even', label: 'Even' }] }), null);
});

test('a number in an internal key is never a line, even for totals and handicaps without points', () => {
  assert.equal(MC.line({ key: '757782506:1:2:2:', type: 'total', title: 'Тотал раундов', prices: [{ designation: 'over', label: 'Больше' }, { designation: 'under', label: 'Меньше' }] }), null);
  assert.equal(MC.line({ key: '757782506:1:3:3:', type: 'handicap', title: 'Фора', prices: [{ designation: 'home', label: 'Team Fjord' }, { designation: 'away', label: 'Funqo Academy' }] }), null);
  assert.equal(MC.line({ key: 'x', type: 'total', title: 'Total 757782506', prices: [{ designation: 'over', label: 'Over' }] }), null, 'implausible values from text are dropped');
});

test('real lines still come from outcome points, specifiers and visible titles (totals, handicaps, maps, kills)', () => {
  assert.equal(MC.line({ key: '757782506:0:17:17:2.5', type: 'map-total', title: 'Тотал карт', prices: [{ designation: 'over', label: 'Больше 2.5', points: 2.5 }, { designation: 'under', label: 'Меньше 2.5', points: 2.5 }] }), 2.5);
  assert.equal(MC.line({ key: '757782506:1:2:2:-5.5', type: 'map-handicap', title: 'Фора', prices: [{ designation: 'home', label: 'Sahur (-5.5)', points: -5.5 }, { designation: 'away', label: 'Tars (+5.5)', points: 5.5 }] }), -5.5);
  assert.equal(MC.line({ key: 'k', type: 'total', title: 'Map 3 - Total kills', specifiers: { total: '59.5', mapnr: '3' }, prices: [{ designation: 'over', label: 'Over 59.5' }, { designation: 'under', label: 'Under 59.5' }] }), 59.5);
  assert.equal(MC.line({ key: '17h1_5', type: 'handicap', title: 'Handicap', specifiers: { hcp: '1.5' }, prices: [{ designation: 'home', label: 'A (+1.5)' }, { designation: 'away', label: 'B (-1.5)' }] }), 1.5);
  assert.equal(MC.line({ key: 'k2', type: 'total', title: 'Тотал раундов 26.5', prices: [{ designation: 'over', label: 'Больше' }, { designation: 'under', label: 'Меньше' }] }), 26.5, 'line written only in the title still works');
  assert.equal(MC.line({ key: 'k3', type: 'map-total', title: 'Тотал по картам Чет/Нечет', specifiers: { total: '2.5' }, prices: [{ designation: 'odd' }, { designation: 'even' }] }), 2.5, 'an explicit specifier wins');
});
