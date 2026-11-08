import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('student and Dean letter details both render the authorized letter QR code', () => {
  const studentStart = app.indexOf('{studentDetailOpen ? (');
  const deanStart = app.indexOf(') : deanDetailOpen ? (', studentStart);
  const deanEnd = app.indexOf(') : activeLetter && (', deanStart);

  assert.notEqual(studentStart, -1, 'student detail view should exist');
  assert.notEqual(deanStart, -1, 'Dean detail view should exist');
  assert.notEqual(deanEnd, -1, 'Dean detail view should have a closing boundary');

  const studentDetail = app.slice(studentStart, deanStart);
  const deanDetail = app.slice(deanStart, deanEnd);

  assert.match(studentDetail, /<QRCode letterId=\{activeLetter\.id\} \/>/);
  assert.match(deanDetail, /<QRCode letterId=\{deanDetail\.id\} \/>/);
});

test('QR deep links include only the letter ID, not student data', () => {
  const deepLinkStart = app.indexOf('function getLetterDeepLink(letterId)');
  const deepLinkEnd = app.indexOf('\n}', deepLinkStart);
  assert.notEqual(deepLinkStart, -1, 'letter deep-link helper should exist');
  assert.notEqual(deepLinkEnd, -1, 'letter deep-link helper should have a closing boundary');

  const deepLinkHelper = app.slice(deepLinkStart, deepLinkEnd);
  assert.match(deepLinkHelper, /url\.pathname = '\/'/);
  assert.match(deepLinkHelper, /url\.search = ''/);
  assert.match(deepLinkHelper, /url\.searchParams\.set\('letter', letterId\)/);
  assert.equal((deepLinkHelper.match(/searchParams\.(?:set|append)\(/g) || []).length, 1);
  assert.doesNotMatch(deepLinkHelper, /searchParams\.(?:set|append)\(\s*['"](?:student|email|reason|name)/i);
});
