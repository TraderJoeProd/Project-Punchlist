const test = require('node:test');
const assert = require('node:assert');
const P = require('../js/parse.js');

const companies = [
  { id: 'c1', name: 'L&L Builders' },
  { id: 'c2', name: 'Turi Construction' },
  { id: 'c3', name: 'Coastal Roofing LLC' },
];
const addresses = [
  { id: 'a1', address: '123 Ocean Blvd, Boca Raton, FL 33432', nicknames: ['Ocean', 'Smith house'] },
  { id: 'a2', address: '4500 N Federal Hwy, Boca Raton, FL', nicknames: ['Federal'] },
  { id: 'a3', address: '77 Palmetto Park Rd', nicknames: [] },
  { id: 'a4', address: '125 Ocean Blvd, Boca Raton, FL', nicknames: ['Jones'] },
];

test('parseHeader basic forms', () => {
  assert.deepStrictEqual(P.parseHeader('Turi @ Ocean'), { company: 'Turi', address: 'Ocean' });
  assert.deepStrictEqual(P.parseHeader('L&L Builders @ 123 Ocean Blvd'), { company: 'L&L Builders', address: '123 Ocean Blvd' });
  assert.deepStrictEqual(P.parseHeader('  L&L Builders@123 Ocean Blvd  '), { company: 'L&L Builders', address: '123 Ocean Blvd' });
  assert.deepStrictEqual(P.parseHeader('Coastal Roofing (a) Smith house'), { company: 'Coastal Roofing', address: 'Smith house' });
  assert.deepStrictEqual(P.parseHeader('Turi at Federal'), { company: 'Turi', address: 'Federal' });
  assert.strictEqual(P.parseHeader('Fix the baseboard in hall'), null);
  assert.strictEqual(P.parseHeader(''), null);
});

test('company fuzzy match', () => {
  assert.strictEqual(P.matchCompany('Turi', companies).match.id, 'c2');
  assert.strictEqual(P.matchCompany('L&L Builders', companies).match.id, 'c1');
  assert.strictEqual(P.matchCompany('L & L builders', companies).match.id, 'c1');
  assert.strictEqual(P.matchCompany('L and L Bldrs', companies).match.id, 'c1');
  assert.strictEqual(P.matchCompany('LL Builders', companies).match.id, 'c1');
  assert.strictEqual(P.matchCompany('Tury', companies).match.id, 'c2'); // handwriting misread
  assert.strictEqual(P.matchCompany('Coastal Roofing', companies).match.id, 'c3');
  assert.strictEqual(P.matchCompany('Acme Plumbing', companies).match, null);
});

test('address / nickname fuzzy match', () => {
  assert.strictEqual(P.matchAddress('Ocean', addresses).match.id, 'a1');
  assert.ok(P.matchAddress('Ocean', addresses).via.startsWith('nickname'));
  assert.strictEqual(P.matchAddress('123 Ocean Blvd', addresses).match.id, 'a1');
  assert.strictEqual(P.matchAddress('123 Ocean Boulevard', addresses).match.id, 'a1');
  assert.strictEqual(P.matchAddress('125 Ocean', addresses).match.id, 'a4'); // number disambiguates
  assert.strictEqual(P.matchAddress('smith house', addresses).match.id, 'a1');
  assert.strictEqual(P.matchAddress('Smith hse', addresses).match.id, 'a1');
  assert.strictEqual(P.matchAddress('Federal', addresses).match.id, 'a2');
  assert.strictEqual(P.matchAddress('4500 Federal Hwy', addresses).match.id, 'a2');
  assert.strictEqual(P.matchAddress('77 Palmetto Park', addresses).match.id, 'a3');
  assert.strictEqual(P.matchAddress('999 Glades Rd', addresses).match, null);
  assert.strictEqual(P.matchAddress('Brown residence', addresses).match, null);
});

test('splitTranscript cleans header and bullets', () => {
  const r = P.splitTranscript('Turi @ Ocean\n1. Touch up paint master bath\n- Replace cracked tile by door\n[ ] Caulk kitchen backsplash\n\n4) Adjust closet doors');
  assert.strictEqual(r.company, 'Turi');
  assert.strictEqual(r.address, 'Ocean');
  assert.deepStrictEqual(r.items, ['Touch up paint master bath', 'Replace cracked tile by door', 'Caulk kitchen backsplash', 'Adjust closet doors']);
  const r2 = P.splitTranscript('just an item\nanother');
  assert.strictEqual(r2.company, '');
  assert.deepStrictEqual(r2.items, ['just an item', 'another']);
});
