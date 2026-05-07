const recipeApi = window.AstroColorMixerRecipe || null;

window.AstroColorMixerCore = {
  version: "Astro Color Mixer Web v0.9.3-beta",
  computeRangeMask: (...args) => window.computeRangeMask?.(...args),
  serializeCurrentAdjustmentSet: () => recipeApi?.serializeCurrentRecipe?.(),
  loadAdjustmentSet: (recipeLike) => recipeApi?.loadRecipe?.(recipeLike),
};
