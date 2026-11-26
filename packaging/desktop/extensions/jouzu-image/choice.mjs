// The image choice in effect: what a call uses when it names nothing, and what
// Settings → Tools shows as chosen. One rule, used by both the extension and the
// card, so the two cannot disagree. Pure: no I/O, no Node imports.
//
// The saved choice (agent/tools.json) is kept as the user left it; this only
// decides what applies now, from the saved choice and the report:
// - provider: the saved one while it is added (listed in the report, usable or
//   not, so its reason has a place); otherwise the report's default. A saved
//   provider that was removed applies again when it is added back.
// - model: the saved one when it belongs to that provider and is offered;
//   otherwise the provider's first model.
// - size: the saved one when the model offers it; otherwise the model's first
//   size; none for a model without a size choice.

/**
 * @param {{ provider: string, model: string, size: string }} image saved choices
 * @param {{ defaults?: { provider?: string }, providers: Array<{ id: string, usable: boolean, models: Array<{ id: string, sizes: string[] }> }> } | null | undefined} report
 * @returns {{ provider: any, model: any, size: string | null }}
 */
export function chosen(image, report) {
  const providers = report?.providers ?? [];
  const saved = providers.find(entry => entry.id === image.provider);
  const provider = saved ?? providers.find(entry => entry.id === report?.defaults?.provider);
  const models = provider?.models ?? [];
  const model = (provider && provider.id === image.provider ? models.find(entry => entry.id === image.model) : undefined) ?? models[0];
  const sizes = model?.sizes ?? [];
  const size = sizes.length ? (sizes.includes(image.size) ? image.size : sizes[0]) : null;
  return { provider, model, size };
}
