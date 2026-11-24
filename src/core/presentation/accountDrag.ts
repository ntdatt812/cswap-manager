import { isValidSlot } from '../model/accountPolicy';
import type { NodeModel } from './accountTree';

/** The slot a drag may carry: one account node, nothing else (usage rows and details are not draggable). */
export function draggedSlot(source: readonly NodeModel[]): number | undefined {
  const node = source.length === 1 ? source[0] : undefined;
  return node?.kind === 'account' && node.slot !== undefined ? node.slot : undefined;
}

/** The move a drop asks for: onto another account only; its slot is where the dragged account goes. */
export function dropMove(from: number, target: NodeModel | undefined): { readonly slot: number; readonly targetSlot: number } | undefined {
  const to = target?.kind === 'account' ? target.slot : undefined;
  return to === undefined || to === from || !isValidSlot(from) ? undefined : { slot: from, targetSlot: to };
}
