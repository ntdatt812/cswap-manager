import * as vscode from 'vscode';
import type { NodeModel, TooltipModel } from '../core/presentation/accountTree';
import { SLANT_BAR_PATTERN } from '../core/presentation/format';

const COLLAPSIBLE: Record<NodeModel['collapsible'], vscode.TreeItemCollapsibleState> = {
  none: vscode.TreeItemCollapsibleState.None,
  collapsed: vscode.TreeItemCollapsibleState.Collapsed,
  expanded: vscode.TreeItemCollapsibleState.Expanded,
};

/** Text from cswap inside a table cell: a `|` would end the cell and a line break the row. */
function tableCell(text: string): string {
  return text.replace(/\|/g, '∣').replace(/[\r\n]+/g, ' ');
}

/**
 * Builds an untrusted Markdown tooltip. Every CLI-derived string goes through `appendText`, which
 * escapes Markdown and, with theme icons on, `$(…)` too, so account data cannot inject links,
 * command URIs, HTML or icons. Only a usage bar made of slant icons is appended as Markdown.
 */
export function renderTooltip(model: TooltipModel): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = false;
  markdown.supportHtml = false;
  markdown.appendMarkdown('**');
  markdown.appendText(model.title);
  markdown.appendMarkdown('**\n\n');
  // A two-column table, so labels and values line up (Markdown tables need a header row: it is empty).
  if (model.rows.length > 0) {
    markdown.appendMarkdown('| | |\n|:--|:--|\n');
  }
  for (const row of model.rows) {
    markdown.appendMarkdown('| ');
    markdown.appendText(tableCell(row.label));
    markdown.appendMarkdown(' | ');
    if (row.bar !== undefined) {
      if (SLANT_BAR_PATTERN.test(row.bar)) {
        markdown.appendMarkdown(`${row.bar} `);
      } else {
        markdown.appendText(`${tableCell(row.bar)} `);
      }
    }
    markdown.appendText(tableCell(row.value));
    markdown.appendMarkdown(' |\n');
  }
  for (const note of model.notes ?? []) {
    markdown.appendMarkdown('\n_');
    markdown.appendText(note);
    markdown.appendMarkdown('_\n');
  }
  return markdown;
}

export function toTreeItem(node: NodeModel): vscode.TreeItem {
  const label = node.highlights === undefined ? node.label : { label: node.label, highlights: node.highlights.map(([start, end]): [number, number] => [start, end]) };
  const item = new vscode.TreeItem(label, COLLAPSIBLE[node.collapsible]);
  item.id = node.id;
  item.contextValue = node.contextValue;
  if (node.description !== undefined) {
    item.description = node.description;
  }
  if (node.icon !== undefined) {
    item.iconPath = new vscode.ThemeIcon(node.icon.id, node.icon.color ? new vscode.ThemeColor(node.icon.color) : undefined);
  }
  if (node.tooltip !== undefined) {
    item.tooltip = renderTooltip(node.tooltip);
  }
  if (node.accessibilityLabel !== undefined) {
    item.accessibilityInformation = { label: node.accessibilityLabel };
  }
  return item;
}

export class AccountsTreeProvider implements vscode.TreeDataProvider<NodeModel>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private nodes: readonly NodeModel[] = [];

  setNodes(nodes: readonly NodeModel[]): void {
    this.nodes = nodes;
    this.changed.fire();
  }

  getChildren(element?: NodeModel): NodeModel[] {
    return [...(element === undefined ? this.nodes : element.children)];
  }

  getTreeItem(element: NodeModel): vscode.TreeItem {
    return toTreeItem(element);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
