import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hasUpdateNotice, UpdatePreview, type UpdateViewState } from "./update-preview";

const noop = () => {};
const live = (downgrade: boolean): UpdateViewState => ({
  phases: ['current', 'available'],
  downgrade: [false, downgrade],
  versions: ['1.1.4', '1.1.4-rc.1'],
  targets: [null, '1.0.23'],
  configured: [true, true],
  errors: [null, null],
  notes: ['', '### Stable\n- A fix already in this build.'],
  sources: ['', ''],
  channel: { value: 'stable', set: noop },
  check: noop,
  install: noop,
});
const html = (downgrade: boolean) => renderToStaticMarkup(<UpdatePreview locale="en" live={live(downgrade)} />);

describe('an older Stable build is not an update (#176)', () => {
  it('shows no update tag, primary button, or release notes for a downgrade offer', () => {
    const markup = html(true);
    expect(markup).toContain('Back to Stable (older than this build)');
    expect(markup).toContain('1.0.23');
    expect(markup).toContain('Install Stable');
    expect(markup).not.toContain('Update available');
    expect(markup).not.toContain('Update and restart');
    expect(markup).not.toContain("What's new");
    // The plain outline button is not the primary update action.
    expect(markup).toMatch(/<button[^>]*class="[^"]*\bborder border-border\b[^"]*"[^>]*>[^<]*(?:<[^>]+>)*[^<]*Install Stable/su);
    // Notes from the older build are not presented as something new.
    expect(markup).not.toContain('A fix already in this build.');
  });

  it('keeps the full update presentation when the offer is newer', () => {
    const markup = html(false);
    expect(markup).toContain('Update available');
    expect(markup).toContain('Update and restart');
    expect(markup).toContain('What&#x27;s new');
    expect(markup).toContain('A fix already in this build.');
    expect(markup).toContain('Available 1.0.23');
    expect(markup).not.toContain('Install Stable');
    expect(markup).not.toContain('Back to Stable (older than this build)');
  });

  it('does not mark the header or sidebar for a downgrade offer alone', () => {
    expect(hasUpdateNotice(null, '1.0.23', true)).toBe(false);
    expect(hasUpdateNotice(null, '1.0.23', false)).toBe(true);
    // A waiting Jouzu update still marks it, whatever the desktop feed offers.
    expect(hasUpdateNotice('0.2.6', '1.0.23', true)).toBe(true);
    expect(hasUpdateNotice(null, null, false)).toBe(false);
  });

  it('drops the downgrade marker when a later check finds no offer', () => {
    const next = { ...live(true), phases: ['current', 'current'] as UpdateViewState['phases'], targets: [null, null] };
    const markup = renderToStaticMarkup(<UpdatePreview locale="en" live={next} />);
    expect(markup).not.toContain('Install Stable');
    expect(markup).not.toContain('Update available');
    expect(markup).toContain('Up to date');
  });
});
