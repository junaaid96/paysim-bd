// Database-backed fake clock. now() is synchronous (the Clock contract),
// so offsets live in an in-memory cache loaded at boot and updated on
// every write. Single process => cache and clock_state never diverge.

import type { Clock } from '@paysim/core';

import type { Db } from './db/client.js';
import { clockState } from './db/schema.js';

export interface ClockStateView {
  workspaceId: string;
  offsetMs: number;
  now: string;
}

export class DbClock implements Clock {
  private readonly offsets = new Map<string, number>();

  constructor(private readonly db: Db) {}

  /** Fill the cache from clock_state. Call once at boot. */
  async loadAll(): Promise<void> {
    const rows = await this.db.select().from(clockState);
    for (const row of rows) {
      this.offsets.set(row.workspaceId, row.offsetMs);
    }
  }

  now(workspaceId: string): Date {
    return new Date(Date.now() + (this.offsets.get(workspaceId) ?? 0));
  }

  offsetMs(workspaceId: string): number {
    return this.offsets.get(workspaceId) ?? 0;
  }

  view(workspaceId: string): ClockStateView {
    return {
      workspaceId,
      offsetMs: this.offsetMs(workspaceId),
      now: this.now(workspaceId).toISOString(),
    };
  }

  private async writeOffset(workspaceId: string, offsetMs: number): Promise<ClockStateView> {
    await this.db.insert(clockState).values({ workspaceId, offsetMs }).onConflictDoUpdate({
      target: clockState.workspaceId,
      set: { offsetMs },
    });
    this.offsets.set(workspaceId, offsetMs);
    return this.view(workspaceId);
  }

  /** Move the clock forward (or backward) by a relative amount. */
  async advance(workspaceId: string, deltaMs: number): Promise<ClockStateView> {
    return this.writeOffset(workspaceId, this.offsetMs(workspaceId) + deltaMs);
  }

  /** Jump so that now() reads `target`. */
  async setTime(workspaceId: string, target: Date): Promise<ClockStateView> {
    return this.writeOffset(workspaceId, target.getTime() - Date.now());
  }

  /** Reset to wall-clock time. */
  async reset(workspaceId: string): Promise<ClockStateView> {
    return this.writeOffset(workspaceId, 0);
  }
}
