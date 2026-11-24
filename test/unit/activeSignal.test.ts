import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActiveSlotTracker, parseActiveSignal, serializeActiveSignal } from '../../src/core/service/activeSignal';

describe('active-account signal between windows', () => {
  it('round-trips a signal and rejects anything malformed', () => {
    const signal = { slot: 3, at: 1_700_000_000_000, origin: 'window-a' };
    assert.deepEqual(parseActiveSignal(serializeActiveSignal(signal)), signal);
    assert.deepEqual(parseActiveSignal('{"slot":null,"at":1,"origin":"w"}'), { slot: null, at: 1, origin: 'w' });
    for (const bad of ['', 'not json', '[]', 'null', '{"slot":"3","at":1,"origin":"w"}', '{"slot":1.5,"at":1,"origin":"w"}', '{"slot":-1,"at":1,"origin":"w"}', '{"slot":1,"at":"x","origin":"w"}', '{"slot":1,"at":1,"origin":""}']) {
      assert.equal(parseActiveSignal(bad), undefined, bad);
    }
  });

  it('writes only when the active slot really changes after the first load', () => {
    const tracker = new ActiveSlotTracker('window-a');
    assert.equal(tracker.observe(1, 10), undefined, 'first load is not a change');
    assert.equal(tracker.observe(1, 20), undefined, 'same slot again');
    assert.deepEqual(tracker.observe(3, 30), { slot: 3, at: 30, origin: 'window-a' });
    assert.deepEqual(tracker.observe(undefined, 40), { slot: null, at: 40, origin: 'window-a' });
  });

  it("follows only another window's signal that disagrees with what this window shows", () => {
    const tracker = new ActiveSlotTracker('window-a');
    assert.equal(tracker.shouldRefresh({ slot: 2, at: 1, origin: 'window-b' }), true, 'nothing loaded yet');
    tracker.observe(2, 1);
    assert.equal(tracker.shouldRefresh({ slot: 2, at: 2, origin: 'window-b' }), false, 'already showing it');
    assert.equal(tracker.shouldRefresh({ slot: 5, at: 3, origin: 'window-b' }), true);
    assert.equal(tracker.shouldRefresh({ slot: 5, at: 4, origin: 'window-a' }), false, 'own echo');
  });
});
