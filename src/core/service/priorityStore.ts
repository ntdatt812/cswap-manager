import type { CliOutcome } from '../cli/cswapCli';
import { applyPriorities, type PriorityEntry } from '../model/priorities';
import type { AccountsSnapshot } from '../model/types';
import type { ManageApplied } from './managementService';

/**
 * Account priorities (`cswap priority`), which `list --json` does not carry. Read once after the
 * first refresh, taken from the read that verifies a priority change, and read again only when a
 * change can have moved them (add, remove, move). `apply` attaches them to every snapshot.
 */
export class PriorityStore {
  private entries: readonly PriorityEntry[] | undefined;

  constructor(
    private readonly read: () => Promise<CliOutcome<PriorityEntry[]>>,
    private readonly changed: () => void,
    private readonly warn: (message: string) => void,
  ) {}

  apply(snapshot: AccountsSnapshot): AccountsSnapshot {
    return applyPriorities(snapshot, this.entries);
  }

  async load(): Promise<void> {
    const result = await this.read();
    if (result.ok) {
      this.accept(result.value);
    } else {
      this.warn(`cswap priority could not be read (${result.error.kind}).`);
    }
  }

  /** After a successful account change (`ManagementService.onDidApply`). */
  onApplied(event: ManageApplied): void {
    if (event.priorities !== undefined) {
      this.accept(event.priorities);
    } else if (event.prioritiesChanged) {
      void this.load();
    }
  }

  private accept(entries: readonly PriorityEntry[]): void {
    this.entries = entries;
    this.changed();
  }
}
