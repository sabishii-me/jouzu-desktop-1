// Image providers that the runtime's own model registry lists (`type: "image"`).
//
// The runtime resolves their credentials and generates through its public
// `generateImages`; this file never reads or stores a credential. A provider
// counts as added only when the runtime has a credential configured for it
// (`getProviderAuthStatus(id).configured`): the registry lists image models for
// providers nobody added, so the list alone says nothing about the user.
// These models take no size setting.
import { coded } from "./errors.mjs";

/** One provider object per runtime image provider, except the ids in `skip`. */
export function runtimeProviders(registry, skip = []) {
  const ids = [...new Set(registry.getModelsOfType("image").map(model => model.provider))].filter(id => !skip.includes(id));
  return ids.map(id => runtimeProvider(registry, id));
}

function runtimeProvider(registry, id) {
  const label = registry.getProviderDisplayName?.(id) ?? id;
  return {
    id,
    label,
    async credential(current) {
      return current.getProviderAuthStatus?.(id)?.configured ? { registry: current } : undefined;
    },
    sizes() {
      return [];
    },
    async listModels(credential) {
      const models = credential.registry.getModelsOfType("image", id);
      if (!models.length) throw coded("not-allowed", `${label} lists no image models.`);
      return models.map(model => ({ id: model.id, sizes: [] }));
    },
    async generate(credential, { model, prompt, signal }) {
      const chosen = credential.registry.getModelsOfType("image", id).find(entry => entry.id === model);
      if (!chosen) throw coded("other", `${label} has no image model ${model}.`);
      let result;
      try {
        result = await credential.registry.generateImages(chosen, { input: [{ type: "text", text: prompt }] }, signal ? { signal } : undefined);
      } catch (error) {
        throw coded("other", `Image generation with ${label} failed.`, String(error?.message ?? error));
      }
      if (result?.stopReason !== "stop") throw coded("other", `Image generation with ${label} failed.`, result?.errorMessage);
      const image = (result.output ?? []).find(block => block.type === "image" && typeof block.data === "string");
      if (!image) throw coded("other", "The answer contained no image.");
      return { data: image.data, mime: image.mimeType ?? "image/png" };
    },
  };
}
