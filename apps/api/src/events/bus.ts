// In-memory workspace event bus feeding Server-Sent Events. Local-first
// scale only: subscribers are dashboard tabs in one process.

export interface BusMessage {
  id: string;
  type: string;
  workspaceKey: string;
  data: Record<string, unknown>;
  at: string;
}

export type BusListener = (message: BusMessage) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<BusListener>>();
  private sequence = 0;

  subscribe(workspaceKey: string, listener: BusListener): () => void {
    let set = this.listeners.get(workspaceKey);
    if (!set) {
      set = new Set();
      this.listeners.set(workspaceKey, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(workspaceKey);
      }
    };
  }

  publish(input: {
    type: string;
    workspaceKey: string;
    data?: Record<string, unknown>;
  }): BusMessage {
    this.sequence += 1;
    const message: BusMessage = {
      id: String(this.sequence),
      type: input.type,
      workspaceKey: input.workspaceKey,
      data: input.data ?? {},
      at: new Date().toISOString(),
    };
    const set = this.listeners.get(input.workspaceKey);
    if (set) {
      for (const listener of set) {
        listener(message);
      }
    }
    return message;
  }

  subscriberCount(workspaceKey: string): number {
    return this.listeners.get(workspaceKey)?.size ?? 0;
  }
}
