export type Priority = 'P0' | 'P1' | 'P2';
export type OutboundItem = { id: string; chatId: string; priority: Priority; result: 'QUEUED' | 'UNKNOWN_OUTCOME' | 'CONFIRMED' | 'FAILED_CONFIRMED'; availableAt?: number };

/** B1 fake-clock scheduler, no sending. B4 will persist campaign jobs in a transactional queue. */
export class OutboundPriorityPolicy {
  private queue: OutboundItem[] = [];
  private readonly cooldown = new Map<string, number>();
  private readonly lanes: Priority[] = ['P0', 'P0', 'P0', 'P0', 'P0', 'P1', 'P1', 'P1', 'P2'];
  private cursor = 0;
  constructor(private readonly clock: () => number = Date.now, private readonly capacity = 1000) {}
  enqueue(item: OutboundItem): boolean {
    if (item.result !== 'QUEUED') return false; // Unknown results MUST NOT be blindly requeued.
    if (this.queue.length >= this.capacity || this.queue.some(x => x.id === item.id)) return false;
    this.queue.push({ ...item }); return true;
  }
  retryAfter(chatId: string, durationMs: number): void {
    this.cooldown.set(chatId, Math.max(this.cooldown.get(chatId) ?? 0, this.clock() + Math.max(0, durationMs)));
  }
  next(revalidate: (item: OutboundItem) => boolean = () => true): OutboundItem | undefined {
    const now = this.clock();
    for (let scanned = 0; scanned < this.lanes.length; scanned++) {
      const lane = this.lanes[(this.cursor + scanned) % this.lanes.length];
      const index = this.queue.findIndex(x => x.priority === lane && (x.availableAt ?? 0) <= now && (this.cooldown.get(x.chatId) ?? 0) <= now);
      if (index >= 0) {
        if (!revalidate(this.queue[index]!)) { this.queue.splice(index, 1); scanned--; continue; }
        this.cursor = (this.cursor + scanned + 1) % this.lanes.length;
        return this.queue.splice(index, 1)[0];
      }
    }
    return undefined;
  }
  get length(): number { return this.queue.length; }
}
