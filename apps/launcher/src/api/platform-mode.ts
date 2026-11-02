/** True when the same UI is served by the host origin rather than the Tauri app origin. */
export function isHostOrigin(): boolean {
  return typeof window !== "undefined" && /^https?:$/u.test(window.location.protocol);
}
