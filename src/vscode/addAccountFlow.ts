import * as vscode from 'vscode';
import { isValidTokenEmail, tokenKind, type TokenKind } from '../core/cli/cswapCli';
import type { AccountsSnapshot } from '../core/model/types';
import { renewedLoginSlot } from '../core/presentation/accountTree';
import type { AddOutcome, ManagementService } from '../core/service/managementService';
import type { OperationGate } from '../core/service/operationGate';
import type { RefreshService } from '../core/service/refreshService';
import { describeCliError, showBusy, showCliFailure } from './messages';
import { t } from './presentation';

export interface AddAccountDependencies {
  readonly refreshService: RefreshService;
  readonly managementService: ManagementService;
  readonly gate: OperationGate;
  readonly homeDir: string;
}

/** Free slots: gaps first, then the next number after the highest slot. */
export function freeSlots(usedSlots: readonly number[], count = 5): number[] {
  const used = new Set(usedSlots);
  const free: number[] = [];
  for (let slot = 1; free.length < count; slot++) {
    if (!used.has(slot)) {
      free.push(slot);
    }
  }
  return free;
}

type AddWay = 'current' | 'login' | 'token' | 'refreshLogin';

/**
 * Adding accounts to cswap: the Accounts view's + button, the switcher's last row, and an offer that
 * appears by itself when Claude Code is logged in to an account cswap does not manage yet (right
 * after `/login` with a new account).
 *
 * cswap can store only the login Claude Code uses right now (`cswap add`), or a setup-token / API key
 * pasted by the user (`cswap add-token`, token sent on stdin only and never kept).
 */
export class AccountAdder implements vscode.Disposable {
  /** Flows of this class running: the automatic offer waits rather than stacking a second dialog. */
  private flows = 0;
  /** The automatic offer was made for the current unmanaged login; reset once the login is managed again. */
  private offered = false;
  /** The snapshot seen at the last refresh, to tell when a login was renewed. */
  private previous: AccountsSnapshot | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly deps: AddAccountDependencies) {
    this.previous = deps.refreshService.getState().snapshot;
    this.subscription = deps.refreshService.onDidChange(() => this.onRefresh());
  }

  dispose(): void {
    this.subscription.dispose();
  }

  /** **Cswap: Add Account…** — asks how, with the likely way first. */
  run(): Promise<void> {
    return this.inFlow(() => this.chooseWay());
  }

  private async chooseWay(): Promise<void> {
    const snapshot = this.deps.refreshService.getState().snapshot;
    const activeSlot = snapshot?.active.slot;
    const items: Array<vscode.QuickPickItem & { way: AddWay }> = [
      ...(snapshot?.active.activeUnmanaged === true
        ? [{ way: 'current' as const, label: `$(add) ${t('Add the account Claude Code is logged in to')}`, detail: t('cswap does not manage this login yet.') }]
        : []),
      { way: 'login', label: `$(sign-in) ${t('Log in to a new account…')}`, detail: t('Use /login in Claude Code; the extension then offers to add it. The usual way.') },
      { way: 'token', label: `$(key) ${t('Paste a setup-token or API key…')}`, detail: t('Claude Code keeps its current login. Create a setup-token with "claude setup-token".') },
      ...(activeSlot === undefined
        ? []
        : [
            {
              way: 'refreshLogin' as const,
              label: `$(sync) ${t('Refresh the stored login of slot {0}', activeSlot)}`,
              detail: t('After logging in to this account again with /login, for example when its login is about to expire.'),
            },
          ]),
    ];
    const picked = await vscode.window.showQuickPick(items, { title: t('Add an account to cswap') });
    switch (picked?.way) {
      case 'current':
        return this.addCurrentLogin();
      case 'login':
        return this.guideLogin();
      case 'token':
        return this.addToken();
      case 'refreshLogin':
        return this.refreshStoredLogin();
      case undefined:
        return;
    }
  }

  /**
   * After a refresh: a login cswap does not manage yet is offered for adding, and a `/login` again
   * to an account cswap already has (expired or about to) replaces its stored login by itself.
   */
  private onRefresh(): void {
    const snapshot = this.deps.refreshService.getState().snapshot;
    if (snapshot === undefined || snapshot === this.previous) {
      return;
    }
    const previous = this.previous;
    this.previous = snapshot;
    // Every open window refreshes; only the one in front acts, so nothing runs or asks twice.
    if (!vscode.window.state.focused) {
      return;
    }
    const renewed = renewedLoginSlot(previous, snapshot, Date.now());
    if (renewed !== undefined) {
      void this.storeRenewedLogin(renewed);
    }
    this.noticeNewLogin(snapshot);
  }

  /**
   * `cswap add` for the account Claude Code was just logged in to again. cswap often resyncs this by
   * itself, but only as a best effort; running `add` makes sure the stored login is the new one and
   * lifts a "re-login needed" state. Same account, same slot: nothing else changes.
   */
  private async storeRenewedLogin(slot: number): Promise<void> {
    if (this.flows > 0 || this.deps.gate.isBusy() || this.deps.refreshService.getState().snapshot?.active.slot !== slot) {
      return;
    }
    // `--slot` binds the run to that account: cswap rebuilds the slot in place (keeping its settings)
    // only when Claude Code is on that same account; with any other login it would have to ask to
    // overwrite, gets no answer, and cancels without changes.
    const outcome = await this.deps.managementService.addCurrent({ slot });
    if (outcome.kind === 'busy') {
      return;
    }
    if (outcome.kind === 'added' && outcome.result.slot === slot && outcome.verification === 'confirmed') {
      void vscode.window.showInformationMessage(t('You logged in to slot {0} again: cswap now stores the new login.', slot));
      return;
    }
    const reason =
      outcome.kind === 'failed'
        ? describeCliError(outcome.error)
        : outcome.kind === 'cancelled'
          ? t('Claude Code is no longer on that account.')
          : t('The result could not be verified yet; refresh to check.');
    const retry = t('Try again');
    const choice = await vscode.window.showWarningMessage(t('You logged in to slot {0} again, but cswap could not store the new login: {1}', slot, reason), retry);
    if (choice === retry) {
      await this.inFlow(() => this.refreshStoredLogin());
    }
  }

  /** Offers to add the login once, when a refresh first sees Claude Code on an unmanaged account. */
  private noticeNewLogin(snapshot: AccountsSnapshot): void {
    const unmanaged = snapshot.active.activeUnmanaged === true;
    if (!unmanaged) {
      this.offered = false;
      return;
    }
    if (this.offered || this.flows > 0) {
      return;
    }
    this.offered = true;
    const add = t('Add to cswap…');
    void vscode.window.showInformationMessage(t('Claude Code is logged in to an account cswap does not manage yet.'), add).then((choice) => {
      if (choice === add) {
        void this.inFlow(() => this.addCurrentLogin());
      }
    });
  }

  /** Not awaited: the user leaves this notification open while logging in elsewhere. */
  private guideLogin(): void {
    const done = t('I have logged in');
    void vscode.window
      .showInformationMessage(t('In Claude Code, type /login and log in to the new account, then click "{0}". Accounts already in cswap stay there.', done), done)
      .then((choice) => {
        if (choice === done) {
          void this.inFlow(() => this.addCurrentLogin());
        }
      });
  }

  /** `cswap add` for the login Claude Code uses now, into a free slot. */
  private async addCurrentLogin(): Promise<void> {
    const snapshot = await this.freshSnapshot();
    if (snapshot === undefined) {
      return;
    }
    if (snapshot.active.activeUnmanaged !== true) {
      void vscode.window.showInformationMessage(
        snapshot.active.slot === undefined
          ? t('No Claude Code login found. Log in with /login in Claude Code first, then try again.')
          : t('Claude Code is using an account cswap already has (slot {0}). Log in to the new account with /login first, then try again.', snapshot.active.slot),
      );
      return;
    }
    const slot = await pickFreeSlot(snapshot, t('Add the current Claude Code login to cswap'));
    if (slot === undefined) {
      return;
    }
    const proceed = t('Add');
    const confirm = await vscode.window.showWarningMessage(
      t('Store the current Claude Code login in cswap slot {0}?', slot),
      { modal: true, detail: t('cswap copies the login Claude Code uses right now, checks it with Anthropic, and makes it the active account in that slot.') },
      proceed,
    );
    if (confirm !== proceed) {
      return;
    }
    const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Cswap: adding the current login…') }, () =>
      this.deps.managementService.addCurrent({ slot }),
    );
    this.report(outcome, 'login');
  }

  /** `cswap add` without a slot: refreshes the stored copy of the login Claude Code uses now. */
  private async refreshStoredLogin(): Promise<void> {
    const snapshot = await this.freshSnapshot();
    const slot = snapshot?.active.slot;
    if (slot === undefined) {
      return;
    }
    const proceed = t('Refresh stored login');
    const confirm = await vscode.window.showWarningMessage(
      t('Refresh the login cswap stored for slot {0}?', slot),
      { modal: true, detail: t('cswap replaces it with the login Claude Code uses right now. Do this after logging in to that same account again with /login.') },
      proceed,
    );
    if (confirm !== proceed) {
      return;
    }
    // Bound to the slot: if Claude Code is on another account by now, cswap cancels instead.
    const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Cswap: adding the current login…') }, () =>
      this.deps.managementService.addCurrent({ slot }),
    );
    this.report(outcome, 'login');
  }

  /** `cswap add-token -`: the token is typed into a password box and handed to cswap on stdin. */
  private async addToken(): Promise<void> {
    const snapshot = await this.freshSnapshot();
    if (snapshot === undefined) {
      return;
    }
    // Slot and email first, the token last: it is held only from the password box to the command.
    const slot = await pickFreeSlot(snapshot, t('Add a setup-token or API key (1/3)'));
    if (slot === undefined) {
      return;
    }
    const emailInput = await vscode.window.showInputBox({
      title: t('Add a setup-token or API key (2/3)'),
      prompt: t('An email to recognise the account by (optional). Left empty, cswap uses {0}.', `setup-token-${slot}@token.local`),
      ignoreFocusOut: true,
      validateInput: (input) => validateTokenEmail(input, snapshot),
    });
    if (emailInput === undefined) {
      return;
    }
    const email = emailInput.trim();
    const token = await vscode.window.showInputBox({
      title: t('Add a setup-token or API key (3/3)'),
      prompt: t('Run "claude setup-token" in a terminal (it opens the browser to log in to the account), then paste the token it prints and clear that terminal. It goes to cswap only; the extension does not keep it.'),
      placeHolder: 'sk-ant-oat01-…',
      password: true,
      ignoreFocusOut: true,
      validateInput: validateToken,
    });
    const kind = token === undefined ? undefined : tokenKind(token);
    if (token === undefined || kind === undefined) {
      return;
    }
    const proceed = t('Add');
    const confirm = await vscode.window.showWarningMessage(
      kind === 'api-key' ? t('Add this API key to cswap slot {0}?', slot) : t('Add this setup-token to cswap slot {0}?', slot),
      {
        modal: true,
        detail: [
          t('Claude Code stays logged in to its current account.'),
          kind === 'api-key'
            ? t('An API key is billed per token, and by default cswap auto-switch does not move onto API-key accounts.')
            : t('cswap cannot read a setup-token account\'s usage unless "Usage of token accounts" is on in Quick Settings (each reading spends 1 Haiku token).'),
        ].join('\n\n'),
      },
      proceed,
    );
    if (confirm !== proceed) {
      return;
    }
    const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Cswap: adding the account…') }, () =>
      this.deps.managementService.addToken(token, { slot, ...(email === '' ? {} : { email }) }),
    );
    this.report(outcome, kind);
  }

  /** Re-reads cswap (with the active login checked) so the choice of free slots is current. */
  private async freshSnapshot(): Promise<AccountsSnapshot | undefined> {
    if (this.deps.gate.isBusy()) {
      showBusy();
      return undefined;
    }
    const fresh = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: t('Cswap: refreshing accounts…') }, () =>
      this.deps.refreshService.refresh({ trigger: 'manual', requireFresh: true, verifyActive: true }),
    );
    if (!fresh.ok) {
      void vscode.window.showErrorMessage(describeCliError(fresh.error));
      return undefined;
    }
    return fresh.snapshot;
  }

  private async inFlow(run: () => Promise<void>): Promise<void> {
    this.flows++;
    try {
      await run();
    } finally {
      this.flows--;
    }
  }

  private report(outcome: AddOutcome, source: 'login' | TokenKind): void {
    switch (outcome.kind) {
      case 'busy':
        showBusy();
        return;
      case 'cancelled':
        void vscode.window.showWarningMessage(t('cswap did not add the account (it cancelled without changes).'));
        return;
      case 'failed':
        showCliFailure(outcome.error, this.deps.homeDir, (description) => t('cswap could not add the account: {0}', description));
        return;
      case 'added': {
        const text = addedText(outcome.result, source);
        if (outcome.verification === 'confirmed') {
          void vscode.window.showInformationMessage(text);
        } else {
          void vscode.window.showWarningMessage(`${text} ${t('The result could not be verified yet; refresh to check.')}`);
        }
        return;
      }
    }
  }
}

function addedText(result: Extract<AddOutcome, { kind: 'added' }>['result'], source: 'login' | TokenKind): string {
  const slot = result.slot;
  if (result.kind === 'moved') {
    return t('The account moved to slot {0}.', slot);
  }
  if (result.kind === 'updated') {
    return source === 'login' ? t('Refreshed the stored login of slot {0}.', slot) : t('Updated the token of slot {0}.', slot);
  }
  switch (source) {
    case 'login':
      return t('Added the current login as slot {0}.', slot);
    case 'api-key':
      return t('Added slot {0} from an API key.', slot);
    case 'setup-token':
      return t('Added slot {0} from a setup-token.', slot);
  }
}

async function pickFreeSlot(snapshot: AccountsSnapshot, title: string): Promise<number | undefined> {
  const slots = freeSlots(snapshot.accounts.map((account) => account.slot));
  const picked = await vscode.window.showQuickPick(
    slots.map((slot, index) => ({ label: t('Slot {0}', slot), ...(index === 0 ? { description: t('first free slot') } : {}), slot })),
    { title, placeHolder: t('Choose a free slot'), ignoreFocusOut: true },
  );
  return picked?.slot;
}

/**
 * An email already used by an account would make cswap move that account into the new slot (or
 * replace its token), which the "add" confirmation would not say: refused here.
 */
function validateTokenEmail(input: string, snapshot: AccountsSnapshot): string | undefined {
  const email = input.trim();
  if (email === '') {
    return undefined;
  }
  if (!isValidTokenEmail(email)) {
    return t('Enter an email such as name@example.com, or leave it empty.');
  }
  const taken = snapshot.accounts.find((account) => account.email?.toLowerCase() === email.toLowerCase());
  return taken === undefined ? undefined : t('Slot {0} already uses this email. Use another one, or leave it empty.', taken.slot);
}

function validateToken(input: string): string | vscode.InputBoxValidationMessage | undefined {
  if (input.trim() === '') {
    return t('Paste the token here.');
  }
  switch (tokenKind(input)) {
    case undefined:
      return t('A token starts with "sk-ant-" and has no spaces or line breaks.');
    case 'api-key':
      return { message: t('This is an API key (billed per token), not a setup-token.'), severity: vscode.InputBoxValidationSeverity.Info };
    case 'setup-token':
      return undefined;
  }
}
