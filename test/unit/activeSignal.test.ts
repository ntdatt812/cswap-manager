import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActiveSlotTracker, BACKGROUND_READ_WITHIN_MS, parseActiveSignal, serializeActiveSignal, SIGNAL_SETTLE_MS, signalReadDelay, SignalReadTimer } from '../../src/core/service/activeSignal';
import type { TimerApi } from '../../src/core/service/refreshScheduler';

/** Timers that run only when the test advances the clock. */
class FakeTimers implements TimerApi {
  now = 0;
  private next = 1;
  private readonly due = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.due.set(id, { at: this.now + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.due.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.due].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.now) {
        this.due.delete(id);
        timer.callback();
      }
    }
  }
}

describe('active-account signal between windows', () => {
  it('reads soon in the focused window and within 5 s in background windows', () => {
    assert.equal(signalReadDelay(true, 0.9), SIGNAL_SETTLE_MS);
    assert.equal(signalReadDelay(false, 0), SIGNAL_SETTLE_MS);
    assert.ok(signalReadDelay(false, 0.999_999) < BACKGROUND_READ_WITHIN_MS);
  });

  describe('SignalReadTimer', () => {
    const setup = (random = 0.5) => {
      const timers = new FakeTimers();
      const reads: number[] = [];
      const timer = new SignalReadTimer(() => reads.push(timers.now), timers, () => random);
      return { timers, reads, timer, background: signalReadDelay(false, random) };
    };

    it('reads soon after a signal in the focused window, restarting the settle time on each event', () => {
      const { timers, reads, timer } = setup();
      timer.signalChanged(true);
      timers.advance(SIGNAL_SETTLE_MS - 100);
      timer.signalChanged(true);
      timers.advance(SIGNAL_SETTLE_MS - 1);
      assert.deepEqual(reads, []);
      timers.advance(1);
      assert.deepEqual(reads, [2 * SIGNAL_SETTLE_MS - 100]);
    });

    it('keeps a waiting background read when more signals arrive, so the wait does not grow', () => {
      const { timers, reads, timer, background } = setup();
      timer.signalChanged(false);
      timers.advance(background - 10);
      timer.signalChanged(false);
      timers.advance(10);
      assert.deepEqual(reads, [background]);
    });

    it('brings a waiting background read forward when the window gains focus', () => {
      const { timers, reads, timer } = setup(0.9);
      timer.signalChanged(false);
      timers.advance(1_000);
      timer.focusChanged(false);
      timer.focusChanged(true);
      timers.advance(SIGNAL_SETTLE_MS);
      assert.deepEqual(reads, [1_000 + SIGNAL_SETTLE_MS]);
    });

    it('does nothing on focus without a waiting read, and nothing after dispose', () => {
      const { timers, reads, timer } = setup();
      timer.focusChanged(true);
      timer.signalChanged(false);
      timer.dispose();
      timers.advance(BACKGROUND_READ_WITHIN_MS);
      assert.deepEqual(reads, []);
    });
  });

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
