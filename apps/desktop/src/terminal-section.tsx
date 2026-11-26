import { ComponentSection, describe } from './components/component-row';
import { messages, type Locale } from './i18n';

interface Terminal { path: string; version: string }
export interface TerminalState {
  bundled: Terminal | null;
  system: Terminal | null;
  /** The directory Jouzu installs into is there, even when nothing in it answers a launch. */
  bundled_present: boolean;
  effective: string | null;
  archive: boolean;
  version: string;
}

/** The Windows Terminal component: the host of the console window. */
export function TerminalSection({ locale, state, busy, error, install }: { locale: Locale; state: TerminalState | null; busy: boolean; error: string | null; install: () => void }) {
  const t = messages[locale];
  if (!state) return <ComponentSection title={t.windowsTerminal} status={t.checking} busy={busy} error={error} installLabel={t.terminalInstall} />;
  const installed = Boolean(state.effective);
  const usingSystem = installed && state.effective === state.system?.path;
  const detail = usingSystem ? state.system : state.bundled;
  // A copy that is here without a host executable is repaired, not installed again.
  const broken = !installed && state.bundled_present;
  return <ComponentSection
    title={t.windowsTerminal}
    status={installed ? describe([usingSystem ? t.terminalSystem : t.terminalBundled, detail?.version]) : broken ? t.terminalBroken : t.terminalMissing}
    tone={installed ? 'ok' : 'missing'}
    busy={busy} error={error}
    install={state.bundled ? undefined : install}
    installLabel={broken ? t.terminalRepair : `${t.terminalInstall} (${t.recommended})`}
  />;
}
