import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { C, SHADOW, applyScheme, scheme } from '../src/theme.ts';
import { parseAppearance, resolveScheme } from '../src/logic/appearance.ts';
import { stateOf, tint, type Dev } from '../src/logic/devices.ts';
import { insightColor } from '../src/logic/glance.ts';

test('applyScheme switches every colour and the shadows, and back', () => {
  assert.equal(scheme(), 'dark');
  assert.equal(C.page, '#0e0f10');
  applyScheme('light');
  assert.equal(scheme(), 'light');
  assert.equal(C.page, '#f5f3ee');
  assert.equal(C.bone, '#1c1b19');
  assert.equal(C.amber, '#b9770b');
  assert.equal(C.hairline, 'rgba(30,26,20,0.06)');
  assert.match(SHADOW.sheet, /30,26,20/);
  applyScheme('dark');
  assert.equal(scheme(), 'dark');
  assert.equal(C.page, '#0e0f10');
  assert.equal(C.bone, '#f1efea');
  assert.match(SHADOW.sheet, /rgba\(0,0,0,0\.6\)/);
});

test('logic that hands out colours reads them when asked, so a scheme change shows', () => {
  const lamp = { id: 'l', type: 'dimmer', on: true, bri: 40 } as Dev;
  assert.deepEqual(stateOf(lamp), ['On · 40%', '#f2b14c']);
  applyScheme('light');
  try {
    assert.deepEqual(stateOf(lamp), ['On · 40%', '#b9770b']);
    assert.equal(tint({ ...lamp, on: false } as Dev).bg, '#ffffff');
    assert.equal(insightColor('alert'), '#cf3a2d');
  } finally { applyScheme('dark'); }
  assert.equal(insightColor('alert'), '#ff6b5e');
});

test('no screen or logic file keeps a theme colour in a constant made at import', () => {
  // A top-level `C.x` (outside any function) would be read once and go stale when the scheme changes.
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f) && f !== 'theme.ts') files.push(p); } };
  walk(join(import.meta.dirname, '../src'));
  files.push(join(import.meta.dirname, '../App.tsx'));
  const bad: string[] = [];
  for (const f of files) {
    const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n: ts.Node, inside: boolean) => {
      const fn = ts.isFunctionLike(n) || ts.isClassLike(n);
      if (!inside && !fn && ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'C') bad.push(`${f}: ${n.getText()}`);
      ts.forEachChild(n, c => visit(c, inside || fn));
    };
    visit(sf, false);
  }
  assert.deepEqual(bad, []);
});

test('the appearance choice: stored values, and which scheme it comes to', () => {
  assert.equal(parseAppearance(null), 'system');
  assert.equal(parseAppearance('light'), 'light');
  assert.equal(parseAppearance('dark'), 'dark');
  assert.equal(parseAppearance('sepia'), 'system');
  assert.equal(resolveScheme('system', 'light'), 'light');
  assert.equal(resolveScheme('system', 'dark'), 'dark');
  assert.equal(resolveScheme('system', null), 'dark');
  assert.equal(resolveScheme('light', 'dark'), 'light');
  assert.equal(resolveScheme('dark', 'light'), 'dark');
});
