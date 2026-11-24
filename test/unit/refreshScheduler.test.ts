import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RefreshScheduler, normalizeIntervalMs, type TimerApi } from '../../src/core/service/refreshScheduler';
import { deferred } from '../helpers/fixtures';

class FakeTimers implements TimerApi {
  private next = 1;
  readonly pending = new Map<number, { callback: () => void; ms: number }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { callback, ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.ms);
  }

  runAll(): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, entry] of entries) {
      entry.callback();
    }
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(lastRefreshAt: number | undefined, now = 100_000) {
  const timers = new FakeTimers();
  let ticks = 0;
  let last = lastRefreshAt;
  const scheduler = new RefreshScheduler({
    tick: () => {
      ticks++;
      last = now;
      return Promise.resolve();
    },
    lastRefreshAt: () => last,
    now: () => now,
    timers,
  });
  return { scheduler, timers, ticks: () => ticks };
}

describe('normalizeIntervalMs', () => {
  it('treats 0/invalid as off and enforces a 30 s minimum', () => {
    assert.equal(normalizeIntervalMs(0), 0);
    assert.equal(normalizeIntervalMs(-5), 0);
    assert.equal(normalizeIntervalMs(Number.NaN), 0);
    assert.equal(normalizeIntervalMs(5), 30_000);
    assert.equal(normalizeIntervalMs(120), 120_000);
  });
});

describe('RefreshScheduler', () => {
  it('does nothing while inactive or disabled', () => {
    const { scheduler, timers } = setup(undefined);
    scheduler.configure(60_000);
    assert.equal(timers.pending.size, 0, 'inactive');
    scheduler.configure(0);
    scheduler.setActive(true);
    assert.equal(timers.pending.size, 0, 'disabled');
  });

  it('runs immediately when never refreshed, then every interval after the last attempt', async () => {
    const { scheduler, timers, ticks } = setup(undefined);
    scheduler.configure(60_000);
    scheduler.setActive(true);
    assert.deepEqual(timers.delays(), [0]);
    timers.runAll();
    await flush();
    assert.equal(ticks(), 1);
    assert.deepEqual(timers.delays(), [60_000]);
  });

  it('waits only the remaining time after a recent refresh', () => {
    const { scheduler, timers } = setup(100_000 - 20_000);
    scheduler.configure(60_000);
    scheduler.setActive(true);
    assert.deepEqual(timers.delays(), [40_000]);
  });

  it('stops when deactivated and is due immediately on return after a long absence', () => {
    const { scheduler, timers } = setup(100_000 - 500_000);
    scheduler.configure(60_000);
    scheduler.setActive(true);
    assert.deepEqual(timers.delays(), [0]);
    scheduler.setActive(false);
    assert.equal(timers.pending.size, 0);
  });

  it('never overlaps ticks', async () => {
    const timers = new FakeTimers();
    const gate = deferred<void>();
    let ticks = 0;
    const scheduler = new RefreshScheduler({
      tick: () => {
        ticks++;
        return gate.promise;
      },
      lastRefreshAt: () => undefined,
      timers,
    });
    scheduler.configure(30_000);
    scheduler.setActive(true);
    timers.runAll();
    scheduler.reschedule();
    assert.equal(timers.pending.size, 0, 'no timer while a tick runs');
    gate.resolve();
    await flush();
    assert.equal(ticks, 1);
    assert.equal(timers.pending.size, 1);
  });

  it('keeps scheduling after a failing tick and stops on dispose', async () => {
    const timers = new FakeTimers();
    const scheduler = new RefreshScheduler({ tick: () => Promise.reject(new Error('x')), lastRefreshAt: () => undefined, timers });
    scheduler.configure(30_000);
    scheduler.setActive(true);
    timers.runAll();
    await flush();
    assert.equal(timers.pending.size, 1);
    scheduler.dispose();
    assert.equal(timers.pending.size, 0);
    scheduler.setActive(false);
    scheduler.setActive(true);
    assert.equal(timers.pending.size, 0);
  });
});
