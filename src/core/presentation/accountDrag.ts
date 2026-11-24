import { hasIdentity, isValidSlot, type AccountIdentity } from '../model/accountPolicy';
import type { AccountsSnapshot } from '../model/types';
import type { NodeModel } from './accountTree';

/** Where a dragged account goes: another account's slot (they trade places), or after the last one. */
export type DropTarget = number | 'end';

/** The slot a drag may carry: one account node, nothing else (usage rows and details are not draggable). */
export function draggedSlot(source: readonly NodeModel[]): number | undefined {
  const node = source.length === 1 ? source[0] : undefined;
  return node?.kind === 'account' && node.slot !== undefined ? node.slot : undefined;
}

/**
 * The move a drop asks for. Onto an account or any of its rows (they carry its slot): take that
 * slot. Onto empty space below the list: go to the end.
 */
export function dropMove(from: number, target: NodeModel | undefined): { readonly slot: number; readonly target: DropTarget } | undefined {
  if (!isValidSlot(from)) {
    return undefined;
  }
  if (target === undefined) {
    return { slot: from, target: 'end' };
  }
  return target.slot === undefined || target.slot === from ? undefined : { slot: from, target: target.slot };
}

/** The slot a drop target means: "end" is the slot after the highest; nothing when the account already is last. */
export function resolveDropTarget(from: number, target: DropTarget, slots: readonly number[]): number | undefined {
  if (target !== 'end') {
    return target;
  }
  const highest = Math.max(...slots);
  return from === highest ? undefined : highest + 1;
}

export interface PendingMove {
  readonly slot: number;
  readonly targetSlot: number;
  /** The dragged account, so the preview stops once the move has really happened (or the slot changed). */
  readonly dragged: AccountIdentity;
}

/**
 * What the list will look like after a move, shown while cswap runs it: the dragged account in its
 * new slot and the account there (if any) in the old one. Applied only while the old slot still holds
 * the dragged account, so a refresh that already reflects the move is never swapped back.
 */
export function previewMove(snapshot: AccountsSnapshot, move: PendingMove): AccountsSnapshot {
  const dragged = snapshot.accounts.find((account) => account.slot === move.slot);
  if (dragged === undefined || !hasIdentity(dragged, move.dragged)) {
    return snapshot;
  }
  const moved = (slot: number): number => (slot === move.slot ? move.targetSlot : slot === move.targetSlot ? move.slot : slot);
  const active = snapshot.active.slot === undefined ? snapshot.active : { ...snapshot.active, slot: moved(snapshot.active.slot) };
  return { ...snapshot, accounts: snapshot.accounts.map((account) => ({ ...account, slot: moved(account.slot) })), active };
}
