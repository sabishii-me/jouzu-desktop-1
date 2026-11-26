// Types for choice.mjs, for the desktop UI that imports it.
export interface ChoiceModel { id: string; sizes: string[] }
export interface ChoiceProvider { id: string; usable: boolean; models: ChoiceModel[] }
export function chosen<P extends ChoiceProvider>(
  image: { provider: string; model: string; size: string },
  report: { defaults?: { provider?: string }; providers: P[] } | null | undefined,
): { provider: P | undefined; model: P["models"][number] | undefined; size: string | null };
