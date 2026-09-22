'use strict';
const assert = require('assert');
const Ego = require('../src/js/ego-maneuver.js');
const Road = require('../src/js/road-context.js');
const ConditionStats = require('../src/js/condition-stats.js');

const p = (lat, lng, speed = 25, time = '12:00:00') => ({ lat, lng, speed, time, date: '2026-01-01', zone: 'Gangnam', vehicle: 'test' });
assert.strictEqual(Ego.classifyWindow([p(37,127),p(37,127.001),p(37,127.002)]).value, 'STRAIGHT');
assert.strictEqual(Ego.classifyWindow([p(37,127),p(37,127.001),p(37.0008,127.001)]).value, 'LEFT_TURN');
assert.strictEqual(Ego.classifyWindow([p(37,127),p(37,127.001),p(36.9992,127.001)]).value, 'RIGHT_TURN');
assert.strictEqual(Ego.classifyWindow([p(37,127),p(37,127.001),p(37,126.9998)]).value, 'U_TURN');
assert.strictEqual(Ego.classifyWindow([p(37,127),p(37.000001,127.000001),p(37,127)]).value, 'UNKNOWN');
assert.strictEqual(Ego.drivingState(p(37,127,0.4)).value, 'STOPPED');
assert.strictEqual(Ego.drivingState(p(37,127,5)).value, 'SLOW');
assert.strictEqual(Ego.drivingState(p(37,127,20)).value, 'MOVING');

const graph = { nodes: new Map([['j', { lat: 37, lng: 127, degree: 4 }], ['n', { lat: 37.01, lng: 127, degree: 2 }]]) };
assert(Road.classifyPoint(p(37,127), graph).some(x => x.value === 'INTERSECTION'));
assert.deepStrictEqual(Road.classifyPoint(p(36,126), null).map(x => x.value), ['UNKNOWN']);
assert(Road.classifyPoint({ ...p(36,126), matchedSegment: { roadClass: 'motorway' } }, graph).some(x => x.value === 'HIGHWAY'));
assert(Road.classifyPoint({ ...p(36,126), matchedSegment: { roadClass: 'ramp' } }, graph).some(x => x.value === 'RAMP'));

const summary = ConditionStats.buildConditionSummary([p(37,127,0,'12:00:00'), p(37,127.001,5,'12:00:10'), p(37,127.002,20,'12:00:20')]);
assert(Array.isArray(summary.maneuverCells) && summary.maneuverCells.length > 0);
assert(Array.isArray(summary.roadContextCells) && summary.roadContextCells[0].roadContext === 'UNKNOWN');
const agg = ConditionStats.aggregateAnalysis([{ date:'2026-01-01', ...summary }], { groupBy:['drivingState'] });
assert.strictEqual(agg.totals.recordCount, 3);
console.log('maneuver-road-context-test: ok');
