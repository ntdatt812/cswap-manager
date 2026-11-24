import * as vscode from 'vscode';
import type { CliError } from '../core/cli/cliErrors';
import type { BarStyle } from '../core/presentation/format';
import { statusBarButtonLabel } from '../core/presentation/quickSettings';
import {
  buildStatusBarModel,
  STATUS_BAR_BUTTONS,
  statusBarParts,
  type StatusBarButton,
  type StatusBarColors,
  type StatusBarModel,
  type StatusBarPart,
} from '../core/presentation/statusBar';
import { assessFreshness, type RefreshService } from '../core/service/refreshService';
import type { SwitchService } from '../core/service/switchService';
import { countdownText } from '../shared/countdown';
import { renderTooltip } from './accountsTreeProvider';
import type { AutoRefreshController } from './autoRefresh';
import { CONFIG_SECTION, type ExtensionConfiguration } from './configuration';
import { CLOCK_TICK_MS, presentationOptions, t } from './presentation';

export interface StatusBarDependencies {
  readonly refreshService: RefreshService;
  readonly switchService: SwitchService;
  readonly configuration: ExtensionConfiguration;
  readonly autoRefresh: AutoRefreshController;
  readonly describeError: (error: CliError) => string;
}

/** Unsaved status bar settings shown while a settings picker is open. */
export interface StatusBarPreview {
  readonly parts?: readonly StatusBarPart[];
  readonly barStyle?: BarStyle;
  readonly colors?: StatusBarColors;
  readonly buttons?: readonly StatusBarButton[];
}

interface Look {
  readonly parts: readonly StatusBarPart[];
  readonly barStyle: BarStyle;
  readonly colors: StatusBarColors;
  readonly buttons: readonly StatusBarButton[];
}

const LEVEL_BACKGROUND: Partial<Record<string, string>> = {
  warning: 'statusBarItem.warningBackground',
  critical: 'statusBarItem.errorBackground',
};

/** Text-only colouring uses the theme's own warning/error icon colours, which every theme defines. */
const LEVEL_FOREGROUND: Partial<Record<string, string>> = {
  warning: 'problemsWarningIcon.foreground',
  critical: 'problemsErrorIcon.foreground',
};

const BUTTON_COMMANDS: Record<StatusBarButton, { readonly command: string; readonly icon: string }> = {
  refresh: { command: 'cswapManager.refresh', icon: 'refresh' },
  dashboard: { command: 'cswapManager.openDashboard', icon: 'dashboard' },
  settings: { command: 'cswapManager.quickSettings', icon: 'gear' },
};

export function statusBarButtonIcon(button: StatusBarButton): string {
  return BUTTON_COMMANDS[button].icon;
}

/**
 * Every Cswap status bar item is created without an id, so all of them share the extension's id:
 * the status bar's context menu then lists them as one "Cswap Manager" entry that hides or shows
 * them together. Single buttons are turned on and off in Quick Settings instead.
 */
export const STATUS_BAR_ENTRY_NAME = 'Cswap Manager';

/**
 * The active-account status bar item (click: quick switch) and the optional buttons right next to it.
 */
export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly buttons = new Map<StatusBarButton, vscode.StatusBarItem>();
  private readonly disposables: vscode.Disposable[] = [];
  private clock: ReturnType<typeof setInterval> | undefined;
  /** The last full render's countdown, which ticks on its own in between. */
  private countdown: StatusBarModel['countdown'];
  private previewing: StatusBarPreview | undefined;

  constructor(private readonly deps: StatusBarDependencies) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = STATUS_BAR_ENTRY_NAME;
    this.item.command = 'cswapManager.quickSwitch';
    // Right-aligned items with a higher priority sit further left. Account (100) and auto-switch (99)
    // stay together; the buttons follow them.
    STATUS_BAR_BUTTONS.forEach((button, index) => {
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98.9 - index * 0.1);
      item.name = STATUS_BAR_ENTRY_NAME;
      item.text = `$(${BUTTON_COMMANDS[button].icon})`;
      item.command = BUTTON_COMMANDS[button].command;
      this.buttons.set(button, item);
      this.disposables.push(item);
    });
    this.disposables.push(
      this.item,
      deps.refreshService.onDidChange(() => this.render()),
      deps.autoRefresh.onDidChangeSchedule(() => this.render()),
      deps.autoRefresh.onCountdownTick(() => this.tickCountdown()),
      deps.switchService.onDidChangeSwitching(() => this.render()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          this.render();
        }
      }),
    );
    this.render();
  }

  dispose(): void {
    this.setClock(false);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Shows unsaved settings on the real status bar; `undefined` goes back to the saved ones. */
  preview(preview: StatusBarPreview | undefined): void {
    this.previewing = preview;
    this.render();
  }

  /** The item text these parts would produce with the current data (for picker samples). */
  sampleText(parts: readonly StatusBarPart[], barStyle?: BarStyle): string | undefined {
    return this.model({ ...this.look(), parts, ...(barStyle === undefined ? {} : { barStyle }) })?.text;
  }

  /** For extension-host tests: what is on the status bar right now. */
  currentState(): { readonly text: string | undefined; readonly buttons: StatusBarButton[] } {
    const look = this.look();
    const text = this.model(look)?.text;
    return { text, buttons: text === undefined ? [] : [...look.buttons] };
  }

  private look(): Look {
    const { configuration } = this.deps;
    const preview = this.previewing ?? {};
    return {
      parts: preview.parts ?? configuration.statusBarParts(),
      barStyle: preview.barStyle ?? configuration.barStyle(),
      colors: preview.colors ?? configuration.statusBarColors(),
      buttons: preview.buttons ?? configuration.statusBarButtons(),
    };
  }

  private model(look: Look): StatusBarModel | undefined {
    const { refreshService, switchService, configuration, describeError } = this.deps;
    const state = refreshService.getState();
    const options = presentationOptions(configuration);
    const nextRefreshAt = configuration.statusBarCountdown() ? this.deps.autoRefresh.nextRefreshAt() : undefined;
    return buildStatusBarModel(state, {
      ...options,
      mode: 'custom',
      parts: look.parts,
      barStyle: look.barStyle,
      freshness: assessFreshness(state, options.now, configuration.staleAfterMs()),
      switching: switchService.isSwitching(),
      describeError,
      ...(nextRefreshAt === undefined ? {} : { nextRefreshAt }),
    });
  }

  /** Re-renders every 30 s for relative times; the countdown ticks separately. */
  private setClock(running: boolean): void {
    if (running) {
      this.clock ??= setInterval(() => this.render(), CLOCK_TICK_MS);
    } else if (this.clock !== undefined) {
      clearInterval(this.clock);
      this.clock = undefined;
    }
  }

  /** Only the countdown at the end of the text changes between full renders. */
  private tickCountdown(): void {
    if (this.countdown === undefined) {
      return;
    }
    const text = `${this.countdown.prefix}${countdownText(this.countdown.at - Date.now())}`;
    if (this.item.text !== text) {
      this.item.text = text;
    }
  }

  private render(): void {
    const look = this.look();
    const shown = statusBarParts('custom', look.parts).length > 0;
    // Before building the model: this can move the schedule, which renders again, and must not leave an older model behind.
    this.deps.autoRefresh.setConsumer('statusBar', shown);
    this.setClock(shown);
    const model = shown ? this.model(look) : undefined;
    this.countdown = model?.countdown;
    // Buttons belong to the account item: hiding the item hides every Cswap button too.
    for (const [button, item] of this.buttons) {
      if (model !== undefined && look.buttons.includes(button)) {
        // Re-labelled on every render so a language change applies at once.
        const label = `Cswap: ${statusBarButtonLabel(button, t)}`;
        item.tooltip = label;
        item.accessibilityInformation = { label };
        item.show();
      } else {
        item.hide();
      }
    }

    if (model === undefined) {
      this.item.hide();
      return;
    }
    this.item.text = model.text;
    this.item.tooltip = renderTooltip(model.tooltip);
    this.item.accessibilityInformation = { label: model.accessibilityLabel };
    const background = look.colors === 'background' ? LEVEL_BACKGROUND[model.level] : undefined;
    const foreground = look.colors === 'text' ? LEVEL_FOREGROUND[model.level] : undefined;
    this.item.backgroundColor = background ? new vscode.ThemeColor(background) : undefined;
    this.item.color = foreground ? new vscode.ThemeColor(foreground) : undefined;
    this.item.show();
  }
}
