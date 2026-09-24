import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateFare, haversineKm, splitFare } from '../src/geo.js';

test('haversineKm: 서울역 → 강남역 약 8.5km 직선거리', () => {
  const d = haversineKm(37.5547, 126.9707, 37.4979, 127.0276);
  assert.ok(d > 7.5 && d < 9, `got ${d}`);
});

test('estimateFare: 기본거리 이내면 기본요금', () => {
  assert.equal(estimateFare(37.5, 127, 37.5001, 127).fare, 4800);
});

test('estimateFare: 거리가 늘면 요금이 증가', () => {
  const near = estimateFare(37.5547, 126.9707, 37.5665, 126.978).fare;
  const far = estimateFare(37.5547, 126.9707, 37.4979, 127.0276).fare;
  assert.ok(far > near);
});

test('splitFare: 10원 단위 올림', () => {
  assert.equal(splitFare(10000, 3), 3340);
  assert.equal(splitFare(10000, 4), 2500);
  assert.equal(splitFare(10000, 0), 10000);
});
