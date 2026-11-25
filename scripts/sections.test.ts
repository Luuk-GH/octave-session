// Unit checks for section detection. Run: npm run test:unit
import * as assert from 'assert';
import { sectionAt } from '../src/sections';

const doc = [
  'a = 1;',          // 0  leading implicit section
  '',                // 1
  '%% Second',       // 2
  'b = 2;',          // 3
  '%%% not a marker',// 4
  '## Third',        // 5
  'c = 3;',          // 6
];

assert.deepStrictEqual(sectionAt(doc, 0), { start: 0, end: 1, title: '', index: 1 });
assert.deepStrictEqual(sectionAt(doc, 2), { start: 2, end: 4, title: 'Second', index: 2 });
assert.deepStrictEqual(sectionAt(doc, 4), { start: 2, end: 4, title: 'Second', index: 2 });
assert.deepStrictEqual(sectionAt(doc, 6), { start: 5, end: 6, title: 'Third', index: 3 });

const startsWithMarker = ['%% First', 'x = 1;', '  %% Second', 'y = 2;'];
assert.deepStrictEqual(sectionAt(startsWithMarker, 1), { start: 0, end: 1, title: 'First', index: 1 });
assert.deepStrictEqual(sectionAt(startsWithMarker, 3), { start: 2, end: 3, title: 'Second', index: 2 });

assert.deepStrictEqual(sectionAt(['x = 1;'], 0), { start: 0, end: 0, title: '', index: 1 });
assert.deepStrictEqual(sectionAt([''], 5), { start: 0, end: 0, title: '', index: 1 });

console.log('sections: all assertions passed');
