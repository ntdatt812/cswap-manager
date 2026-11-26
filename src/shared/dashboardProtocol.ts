/**
 * Messages and view model shared by the extension host and the dashboard webview.
 * This file has no imports so it can be bundled into the webview unchanged. Every string in the
 * model is already localized by the host; the webview renders it with `textContent` only.
 */

export type Level = 'unknown' | 'normal' | 'warning' | 'critical';
export type Tone = 'neutral' | 'active' | 'ok' | 'warning' | 'error';

export interface Fact {
  readonly label: string;
  readonly value: string;
}

export interface Meter {
  readonly id: string;
  readonly label: string;
  /** CLI percentage (may exceed 100); undefined when unknown. */
  readonly pct?: number;
  readonly pctText: string;
  readonly level: Level;
  /** Short line under the bar, e.g. "resets in 4d 0h". */
  readonly caption?: string;
  /**
   * cswap's even-pace mark (`expectedPct`): the share of the window's time already passed, drawn as
   * a tick on the bar. Not a usage forecast.
   */
  readonly pace?: { readonly pct: number; readonly text: string };
  readonly facts: readonly Fact[];
}

/** A usage window's recorded readings over the last 7 days (measured values only, nothing projected). */
export interface Sparkline {
  readonly id: string;
  readonly label: string;
  /** Readings oldest first: `x` is the time across the last 7 days (0–100), `y` the usage % (0–100). */
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>;
  /** e.g. "about 8% per day (measured)", or that there are not enough readings yet. */
  readonly caption: string;
  /** Spoken and hover description of the line. */
  readonly description: string;
}

/** An editable account property: its current value and the actions that change it. */
export interface ManageRow {
  readonly label: string;
  readonly value: string;
  readonly actions: readonly AccountAction[];
}

export interface DetailSection {
  /** Stable key (e.g. "plan"), used to remember whether a collapsible section is open. */
  readonly key: string;
  readonly title: string;
  readonly note?: string;
  readonly noteTone?: Tone;
  readonly meters: readonly Meter[];
  /** Recorded usage over time ("Last 7 days"). */
  readonly sparklines?: readonly Sparkline[];
  readonly facts: readonly Fact[];
  /** Editable properties, shown after the facts. */
  readonly manage?: readonly ManageRow[];
  /** Reference information shown folded by default. */
  readonly collapsible?: boolean;
}

export interface Badge {
  readonly text: string;
  readonly tone: Tone;
}

/** Account-management actions verified against the CLI (Phase 5). */
export type AccountActionId =
  | 'setDisplayName'
  | 'disable'
  | 'enable'
  | 'setThreshold'
  | 'clearThreshold'
  | 'setPriority'
  | 'clearPriority'
  | 'move'
  | 'remove';
/**
 * Actions the dashboard webview may request. `remove` is deliberately absent: a destructive action
 * is only offered in native VS Code UI (sidebar menu, Manage Account…), never from the webview.
 */
export const ACCOUNT_ACTION_IDS: readonly AccountActionId[] = [
  'setDisplayName',
  'disable',
  'enable',
  'setThreshold',
  'clearThreshold',
  'setPriority',
  'clearPriority',
  'move',
];

export interface AccountAction {
  readonly id: AccountActionId;
  readonly label: string;
}

export interface AccountDetail {
  readonly slot: number;
  readonly title: string;
  readonly subtitle?: string;
  readonly badges: readonly Badge[];
  readonly sections: readonly DetailSection[];
  readonly canSwitch: boolean;
  /** Management actions; disabled while another cswap operation runs. */
  readonly actions: readonly AccountAction[];
}

export interface UsageCell {
  readonly label: string;
  readonly pct?: number;
  readonly pctText: string;
  readonly level: Level;
  /**
   * The account has no such window (another plan): the line keeps its place so the same windows
   * line up across rows; the text explains it.
   */
  readonly absent?: string;
}

export interface DashboardRow {
  readonly slot: number;
  readonly name: string;
  readonly secondary?: string;
  readonly active: boolean;
  readonly plan?: string;
  readonly usage: readonly UsageCell[];
  /** Highest usage across windows and scopes, for sorting. */
  readonly maxPct?: number;
  readonly resetText?: string;
  /** Soonest future reset (epoch ms), for sorting. */
  readonly resetEpoch?: number;
  readonly statusText: string;
  readonly statusTone: Tone;
  /** Status worth flagging next to the name (disabled, re-login, …); undefined when all is well. */
  readonly flag?: { readonly text: string; readonly tone: Tone };
  /** Lower-cased text the search box matches against. */
  readonly searchText: string;
  readonly detail: AccountDetail;
}

/** A suggestion computed from cswap's data (never a forecast), optionally with a one-click switch. */
export interface Insight {
  readonly id: 'switch-now' | 'use-before-reset' | 'all-limited' | 'relogin' | 'all-good';
  readonly tone: Tone;
  readonly title: string;
  readonly text: string;
  readonly switchSlot?: number;
  readonly actionLabel?: string;
}

export interface ActiveOverview {
  readonly slot: number;
  readonly name: string;
  readonly secondary?: string;
  readonly plan?: string;
  readonly meters: readonly Meter[];
  readonly flag?: { readonly text: string; readonly tone: Tone };
  readonly level: Level;
}

export interface CapacityOverview {
  /** e.g. "3.1 / 5": quota left counted in full accounts, out of the accounts counted. */
  readonly value: string;
  readonly caption: string;
  readonly detail?: string;
  /** Share of all counted quota still left, 0–100. */
  readonly pct: number;
  readonly level: Level;
}

export interface AutoSwitchOverview {
  readonly value: string;
  readonly detail?: string;
  readonly tone: Tone;
}

export interface TimelineItem {
  readonly slot: number;
  readonly name: string;
  readonly active: boolean;
  readonly whenText: string;
  /** Position of the reset on the timeline, 0–100. */
  readonly position: number;
  readonly remainingText: string;
  readonly level: Level;
}

export interface DashboardStrings {
  readonly title: string;
  readonly summary: string;
  readonly refresh: string;
  readonly switchBest: string;
  readonly switchNext: string;
  readonly settings: string;
  readonly diagnostics: string;
  readonly suggestions: string;
  readonly activeHeading: string;
  readonly capacityHeading: string;
  readonly autoSwitchHeading: string;
  readonly configureAutoSwitch: string;
  readonly timelineHeading: string;
  readonly timelineStart: string;
  readonly timelineEnd: string;
  readonly timelineEmpty: string;
  readonly manageHeading: string;
  readonly activeBadge: string;
  readonly noActive: string;
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  readonly accountsHeading: string;
  readonly detailHeading: string;
  readonly columnSlot: string;
  readonly columnName: string;
  readonly columnPlan: string;
  readonly columnUsage: string;
  readonly columnReset: string;
  readonly columnStatus: string;
  readonly sortBy: string;
  readonly noSelection: string;
  readonly noMatches: string;
  readonly switchToAccount: string;
  readonly busy: string;
  readonly matchCount: string;
}

export type DashboardState = 'loading' | 'error' | 'empty' | 'ready';

export interface DashboardModel {
  readonly state: DashboardState;
  readonly message?: string;
  readonly messageTone?: Tone;
  /** "updated 2m ago", "stale", "loading…" — shown next to the title. */
  readonly freshnessText: string;
  readonly freshnessTone: Tone;
  readonly insights: readonly Insight[];
  readonly activeOverview?: ActiveOverview;
  readonly capacity?: CapacityOverview;
  readonly autoSwitch?: AutoSwitchOverview;
  /** Next resets within the timeline horizon, soonest first. */
  readonly timeline: readonly TimelineItem[];
  readonly rows: readonly DashboardRow[];
  /** When the next automatic refresh is due (epoch ms), only while the header should count down to it. */
  readonly nextRefreshAt?: number;
  /** Every account has this plan: shown once by the heading, and the plan column is left out. */
  readonly commonPlan?: string;
  /** A refresh or switch is running; action buttons are disabled. */
  readonly busy: boolean;
  /** Strategy switching is possible (data loaded, nothing running). */
  readonly canSwitch: boolean;
  readonly strings: DashboardStrings;
}

export type SwitchStrategyName = 'best' | 'next-available';

export type HostToWebview =
  | { readonly type: 'state'; readonly model: DashboardModel }
  | { readonly type: 'select'; readonly slot: number };

export type WebviewToHost =
  | { readonly type: 'ready' }
  | { readonly type: 'refresh' }
  | { readonly type: 'switchToAccount'; readonly slot: number }
  | { readonly type: 'switchStrategy'; readonly strategy: SwitchStrategyName }
  | { readonly type: 'manageAccount'; readonly action: AccountActionId; readonly slot: number }
  | { readonly type: 'openSettings' }
  | { readonly type: 'openAutoSwitch' }
  | { readonly type: 'showDiagnostics' };
