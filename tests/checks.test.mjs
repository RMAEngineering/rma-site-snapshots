// rma-site-snapshots — tests/checks.test.mjs
// Unit tests for the pure helpers in scripts/checks.mjs (no browser). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstFontFamily, fontMismatch, fontFlags } from '../scripts/checks.mjs';

const NEXT_INTER = '"__Inter_d8ebd1", "__Inter_Fallback_d8ebd1", system-ui, -apple-system, sans-serif';

// ---------------------------------------------------------------- font check
test('firstFontFamily strips quotes, the next/font "__" prefix and the "_<6 hex>" hash', () => {
  assert.equal(firstFontFamily(NEXT_INTER), 'Inter');
  assert.equal(firstFontFamily("'__Inter_d8ebd1', sans-serif"), 'Inter');
  assert.equal(firstFontFamily('__Inter_Fallback_d8ebd1, sans-serif'), 'Inter_Fallback');   // fallback face first = font missing
  assert.equal(firstFontFamily('"Times New Roman"'), 'Times New Roman');                    // the Oct 19 incident value
  assert.equal(firstFontFamily('Inter, sans-serif'), 'Inter');
  assert.equal(firstFontFamily('  "Inter_abc12"  , serif'), 'Inter_abc12');                 // 5 hex chars: not a next/font hash, kept
  assert.equal(firstFontFamily(''), '');
  assert.equal(firstFontFamily(null), '');
});

test('fontMismatch is case-insensitive and prefix-based', () => {
  assert.equal(fontMismatch(NEXT_INTER, 'Inter'), null);
  assert.equal(fontMismatch(NEXT_INTER, 'inter'), null);
  assert.equal(fontMismatch('"Inter Variable", sans-serif', 'Inter'), null);
  assert.equal(fontMismatch('"Times New Roman"', 'Inter'), 'Times New Roman');
  assert.equal(fontMismatch(NEXT_INTER, 'Georgia'), 'Inter');
  assert.equal(fontMismatch('"Times New Roman"', ''), null);                                // no expectedFont: check disabled
});

test('fontFlags merges viewports per offending family and skips views without a response', () => {
  const ok = { desktop: { status: 200, fontFamily: NEXT_INTER }, mobile: { status: 200, fontFamily: NEXT_INTER } };
  assert.deepEqual(fontFlags(ok, 'Inter'), []);
  const tnr = { desktop: { status: 200, fontFamily: '"Times New Roman"' }, mobile: { status: 200, fontFamily: '"Times New Roman"' } };
  assert.deepEqual(fontFlags(tnr, 'Inter'), ["font: body font-family starts with 'Times New Roman', expected 'Inter' (desktop, mobile)"]);
  assert.deepEqual(fontFlags(ok, 'Georgia'), ["font: body font-family starts with 'Inter', expected 'Georgia' (desktop, mobile)"]);
  const mixed = { desktop: { status: 200, fontFamily: NEXT_INTER }, mobile: { status: 200, fontFamily: 'Georgia, serif' } };
  assert.deepEqual(fontFlags(mixed, 'Inter'), ["font: body font-family starts with 'Georgia', expected 'Inter' (mobile)"]);
  const dead = { desktop: { status: 0, fontFamily: '"Times New Roman"' }, mobile: { status: 200, fontFamily: null } };
  assert.deepEqual(fontFlags(dead, 'Inter'), []);
  assert.deepEqual(fontFlags(tnr, ''), []);
});
