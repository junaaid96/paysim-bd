import { describe, expect, it } from 'vitest';

import { EventBus } from '../src/events/bus.js';

describe('EventBus', () => {
  it('delivers to subscribers of the same workspace only', () => {
    const bus = new EventBus();
    const seenA: string[] = [];
    const seenB: string[] = [];
    bus.subscribe('a', (message) => seenA.push(message.type));
    bus.subscribe('b', (message) => seenB.push(message.type));
    const message = bus.publish({ type: 'txn.created', workspaceKey: 'a', data: { x: 1 } });
    expect(message.id).toBe('1');
    expect(seenA).toEqual(['txn.created']);
    expect(seenB).toEqual([]);
  });

  it('unsubscribes cleanly', () => {
    const bus = new EventBus();
    let calls = 0;
    const unsubscribe = bus.subscribe('a', () => {
      calls += 1;
    });
    expect(bus.subscriberCount('a')).toBe(1);
    unsubscribe();
    expect(bus.subscriberCount('a')).toBe(0);
    bus.publish({ type: 'x', workspaceKey: 'a' });
    expect(calls).toBe(0);
  });

  it('publishing without subscribers is a no-op', () => {
    const bus = new EventBus();
    expect(() => bus.publish({ type: 'x', workspaceKey: 'nobody' })).not.toThrow();
  });
});
