import * as vscode from 'vscode';
import type { NodeModel, TooltipModel } from '../core/presentation/accountTree';

const COLLAPSIBLE: Record<NodeModel['collapsible'], vscode.TreeItemCollapsibleState> = {
  none: vscode.TreeItemCollapsibleState.None,
  collapsed: vscode.TreeItemCollapsibleState.Collapsed,
  expanded: vscode.TreeItemCollapsibleState.Expanded,
};

/**
 * Builds an untrusted Markdown tooltip. Every CLI-derived string goes through `appendText`, which
 * escapes Markdown, so account data cannot inject links, command URIs or HTML.
 */
export function renderTooltip(model: TooltipModel): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, false);
  markdown.isTrusted = false;
  markdown.supportHtml = false;
  markdown.appendMarkdown('**');
  markdown.appendText(model.title);
  markdown.appendMarkdown('**\n\n');
  for (const row of model.rows) {
    markdown.appendMarkdown('- ');
    markdown.appendText(`${row.label}: ${row.value}`);
    markdown.appendMarkdown('\n');
  }
  for (const note of model.notes ?? []) {
    markdown.appendMarkdown('\n_');
    markdown.appendText(note);
    markdown.appendMarkdown('_\n');
  }
  return markdown;
}

export function toTreeItem(node: NodeModel): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, COLLAPSIBLE[node.collapsible]);
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
