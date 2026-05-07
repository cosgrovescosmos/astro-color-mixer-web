(function () {
  const BAND_DEFS = [
    { id: "red", center: 0, label: "Red / H-alpha", color: "#db534b" },
    { id: "orange", center: 30, label: "Orange / Dust & Galaxy Cores", color: "#d8872f" },
    { id: "yellow", center: 60, label: "Yellow / Warm Stars", color: "#d8c43f" },
    { id: "green", center: 120, label: "Green / Cast Control", color: "#3ba05a" },
    { id: "cyan", center: 180, label: "Cyan / OIII", color: "#39b7b5" },
    { id: "blue", center: 240, label: "Blue / Reflection Nebula", color: "#4a76d4" },
    { id: "purple", center: 275, label: "Purple / Violet Cleanup", color: "#7a61d7" },
    { id: "magenta", center: 315, label: "Magenta / Halo Cleanup", color: "#cb4ca8" },
  ];

  function createBandDefaults() {
    return BAND_DEFS.map((band) => ({
      ...band,
      hueShift: 0,
      saturation: 0,
      luminance: 0,
      width: 45,
      feather: 0.75,
    }));
  }

  const BUILT_IN_PRESETS = [
    {
      name: "Galaxy / HaRGB Starter",
      imageType: "stars",
      sensitivity: "Normal",
      globalStrength: 1,
      bands: {
        red: { saturation: 28, width: 40, feather: 0.75 },
        orange: { saturation: 16, luminance: -5, width: 45, feather: 0.75 },
        blue: { hueShift: -4, saturation: 14, width: 40, feather: 0.8 },
      },
    },
    {
      name: "Reflection Blue Boost",
      imageType: "stars",
      sensitivity: "Normal",
      globalStrength: 1,
      bands: {
        blue: { hueShift: -4, saturation: 18, width: 40, feather: 0.8 },
        cyan: { hueShift: -2, saturation: 12, width: 35, feather: 0.8 },
      },
    },
    {
      name: "Magenta Halo Cleanup",
      imageType: "stars",
      sensitivity: "Normal",
      globalStrength: 1,
      bands: {
        magenta: { hueShift: -10, saturation: -26, width: 35, feather: 0.8 },
        purple: { hueShift: -6, saturation: -14, width: 35, feather: 0.8 },
      },
    },
    {
      name: "Green Cast Reduction",
      imageType: "stars",
      sensitivity: "Normal",
      globalStrength: 1,
      bands: {
        green: { saturation: -32, width: 35, feather: 0.75 },
        cyan: { saturation: -12, width: 30, feather: 0.75 },
      },
    },
    {
      name: "Faint Nebulosity Color Lift",
      imageType: "stars",
      sensitivity: "Normal",
      globalStrength: 1,
      rangeMask: { enabled: true, low: 0.05, high: 0.45, feather: 0.08, preset: "Faint Signal" },
      bands: {
        red: { saturation: 12, width: 40, feather: 0.8 },
        blue: { saturation: 12, width: 40, feather: 0.8 },
        cyan: { saturation: 10, width: 35, feather: 0.8 },
      },
    },
    {
      name: "Bright Core Warmth Control",
      imageType: "stars",
      sensitivity: "Normal",
      globalStrength: 1,
      rangeMask: { enabled: true, low: 0.75, high: 1.0, feather: 0.05, preset: "Bright Cores / Stars" },
      bands: {
        orange: { luminance: -8, saturation: -6, width: 45, feather: 0.8 },
        yellow: { luminance: -6, saturation: -7, width: 40, feather: 0.8 },
      },
    },
    {
      name: "SHO Balance Starter",
      imageType: "stars",
      sensitivity: "Normal",
      globalStrength: 1,
      bands: {
        green: { saturation: -20, width: 40, feather: 0.8 },
        cyan: { saturation: 12, width: 35, feather: 0.8 },
        blue: { saturation: 14, width: 40, feather: 0.8 },
        orange: { saturation: 10, width: 45, feather: 0.8 },
      },
    },
    {
      name: "Reset All",
      imageType: "stars",
      sensitivity: "Normal",
      globalStrength: 1,
      rangeMask: { enabled: false, low: 0.0, high: 1.0, feather: 0.1, preset: "All" },
      bands: {
      },
    },
  ];

  function exportPresetToJson(state) {
    const bands = {};
    state.bands.forEach((band) => {
      bands[band.id] = {
        hueShift: band.hueShift,
        saturation: band.saturation,
        luminance: band.luminance,
        width: band.width,
        feather: band.feather,
      };
    });

    return JSON.stringify({
      version: "stack-12",
      imageType: state.imageType,
      globalStrength: state.globalStrength,
      sensitivity: state.sensitivity,
      rangeMask: state.rangeMask || {
        enabled: false,
        low: 0,
        high: 1,
        feather: 0.1,
        preset: "All",
      },
      neutralLuminance: state.neutralLuminance || {
        luminance: 0,
        satStart: 0.04,
        satFull: 0.16,
      },
      bands,
    }, null, 2);
  }

  function importPresetFromJson(jsonText) {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object" || !parsed.bands) {
      throw new Error("Preset JSON is missing a bands object.");
    }
    if (!parsed.rangeMask || typeof parsed.rangeMask !== "object") {
      parsed.rangeMask = {
        enabled: false,
        low: 0,
        high: 1,
        feather: 0.1,
        preset: "All",
      };
    }
    if (!parsed.neutralLuminance || typeof parsed.neutralLuminance !== "object") {
      parsed.neutralLuminance = {
        luminance: 0,
        satStart: 0.04,
        satFull: 0.16,
      };
    }
    return parsed;
  }

  function mergePresetIntoBands(baseBands, presetBands) {
    return baseBands.map((band) => ({
      ...band,
      ...(presetBands[band.id] || {}),
    }));
  }

  window.AstroPresets = {
    BAND_DEFS,
    BUILT_IN_PRESETS,
    createBandDefaults,
    exportPresetToJson,
    importPresetFromJson,
    mergePresetIntoBands,
  };
})();
