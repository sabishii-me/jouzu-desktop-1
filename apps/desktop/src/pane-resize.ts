/** The supported range for a docked panel's width, in CSS pixels. */
export const PANE_MIN_WIDTH = 360;
export const PANE_MAX_WIDTH = 960;

/**
 * Width of a right-docked panel after a drag, given the pointer's starting
 * position and width. The panel's left edge is the handle, so dragging left
 * (a smaller clientX) makes the panel wider. Kept pure so the direction and
 * the bounds can be tested without a browser.
 */
export function resizedPaneWidth(startWidth: number, startX: number, clientX: number): number {
  const width = startWidth + (startX - clientX);
  return Math.min(PANE_MAX_WIDTH, Math.max(PANE_MIN_WIDTH, width));
}
