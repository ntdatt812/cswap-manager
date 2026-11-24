import * as vscode from 'vscode';
import { draggedSlot, dropMove, type DropTarget } from '../core/presentation/accountDrag';
import type { NodeModel } from '../core/presentation/accountTree';

/** Our own drag data: the dragged account's slot as text. */
export const ACCOUNT_DRAG_MIME = 'application/vnd.cswapmanager.account-slot';

/** Internal command (not contributed): runs the verified move for a drop, with Undo. */
export const MOVE_ACCOUNT_TO_COMMAND = 'cswapManager.moveAccountTo';

/**
 * Drag an account onto another one (or any of its rows) in the Accounts view to give it that slot
 * (the two trade places), or onto the empty space below to move it to the end. The view shows the
 * move at once and hands it to the move flow, which re-checks, verifies and offers Undo; keyboard
 * users keep "Move to slot…".
 */
export class AccountsDragAndDrop implements vscode.TreeDragAndDropController<NodeModel> {
  readonly dragMimeTypes = [ACCOUNT_DRAG_MIME];
  readonly dropMimeTypes = [ACCOUNT_DRAG_MIME];

  constructor(private readonly onDrop: (move: { readonly slot: number; readonly target: DropTarget }) => Promise<void>) {}

  handleDrag(source: readonly NodeModel[], dataTransfer: vscode.DataTransfer): void {
    const slot = draggedSlot(source);
    if (slot !== undefined) {
      dataTransfer.set(ACCOUNT_DRAG_MIME, new vscode.DataTransferItem(String(slot)));
    }
  }

  async handleDrop(target: NodeModel | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const text = await dataTransfer.get(ACCOUNT_DRAG_MIME)?.asString();
    if (text === undefined || !/^\d{1,4}$/.test(text)) {
      return;
    }
    const move = dropMove(Number(text), target);
    if (move !== undefined) {
      await this.onDrop(move);
    }
  }
}
