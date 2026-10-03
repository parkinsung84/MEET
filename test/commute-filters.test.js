import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCrews } from '../public/commute-filters.js';

test('time filters include boundary times exactly once', () => {
  const crews = ['00:00', '11:59', '12:00', '16:59', '17:00', '23:59']
    .map((departTime) => ({ departTime, seatsLeft: 1 }));
  for (const [period, expected] of [['morning', ['00:00', '11:59']], ['afternoon', ['12:00', '16:59']], ['evening', ['17:00', '23:59']]]) {
    assert.deepEqual(selectCrews(crews, period).map((c) => c.departTime), expected);
  }
  assert.equal(selectCrews(crews).length, 6);
  assert.deepEqual(selectCrews([], 'morning'), []);
});

test('available crews precede full crews, ordered by time without mutating API data', () => {
  const crews = [{ departTime: '07:00', seatsLeft: 0 }, { departTime: '09:00', seatsLeft: 1 }, { departTime: '08:00', seatsLeft: 2 }];
  const original = structuredClone(crews);
  assert.deepEqual(selectCrews(crews).map((c) => c.departTime), ['08:00', '09:00', '07:00']);
  assert.deepEqual(crews, original);
});
