(function () {
  const PROTECTION_PRESETS = {
    stars: {
      satFloor: 0.05,
      satFull: 0.25,
      darkFloor: 0.04,
      darkFull: 0.18,
      highlightStart: 0.7,
      highlightFull: 0.95,
    },
    starless: {
      satFloor: 0.03,
      satFull: 0.18,
      darkFloor: 0.02,
      darkFull: 0.12,
      highlightStart: 0.85,
      highlightFull: 0.98,
    },
  };

  const SQRT3 = Math.sqrt(3);
  const AXIS = [1 / SQRT3, 1 / SQRT3, 1 / SQRT3];
  const EPSILON = 1e-6;
  const POSITIVE_LUMINANCE_GAIN = 0.55;

  function clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  function smoothstep(edge0, edge1, x) {
    if (Math.abs(edge1 - edge0) < EPSILON) {
      return x >= edge1 ? 1 : 0;
    }
    const t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
  }

  function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) * 0.5;

    if (Math.abs(max - min) < EPSILON) {
      return [0, 0, l];
    }

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;

    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        break;
      case g:
        h = ((b - r) / d + 2) * 60;
        break;
      default:
        h = ((r - g) / d + 4) * 60;
        break;
    }

    return [h % 360, s, l];
  }

  function circularHueDistance(h1, h2) {
    const delta = Math.abs((h1 % 360) - (h2 % 360));
    return Math.min(delta, 360 - delta);
  }

  function makeHueMask(distance, width, feather) {
    const outerWidth = width;
    const innerWidth = width * (1 - feather);

    if (feather <= EPSILON || Math.abs(outerWidth - innerWidth) < EPSILON) {
      return distance <= outerWidth ? 1 : 0;
    }

    const t = clamp01((distance - innerWidth) / (outerWidth - innerWidth));
    return 1 - smoothstep(0, 1, t);
  }

  function buildMasks(hue, saturation, lightness, band, protection, globalStrength, rangeMaskValue = 1) {
    const distance = circularHueDistance(hue, band.center);
    const hueMask = makeHueMask(distance, band.width, band.feather);
    const satMask = smoothstep(protection.satFloor, protection.satFull, saturation);
    const darkMask = smoothstep(protection.darkFloor, protection.darkFull, lightness);
    const highlightMask = 1 - smoothstep(protection.highlightStart, protection.highlightFull, lightness);
    const finalMask = hueMask * satMask * darkMask * highlightMask * rangeMaskValue * globalStrength;

    return {
      distance,
      hueMask,
      satMask,
      darkMask,
      highlightMask,
      finalMask,
    };
  }

  function buildNeutralMasks(saturation, lightness, neutralState, protection, globalStrength, rangeMaskValue = 1, options = {}) {
    const neutralMask = 1 - smoothstep(neutralState.satStart, neutralState.satFull, saturation);
    const neutralDarkFloor = options.neutralDarkFloor ?? protection.darkFloor;
    const neutralDarkFull = options.neutralDarkFull ?? protection.darkFull;
    const darkMask = smoothstep(neutralDarkFloor, neutralDarkFull, lightness);
    const highlightMask = 1 - smoothstep(protection.highlightStart, protection.highlightFull, lightness);
    const finalMask = neutralMask * darkMask * highlightMask * rangeMaskValue * globalStrength;

    return {
      neutralMask,
      darkMask,
      highlightMask,
      finalMask,
    };
  }

  function luma709(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function rodriguesRotate(vector, axis, angleRadians) {
    const [vx, vy, vz] = vector;
    const [ax, ay, az] = axis;
    const cos = Math.cos(angleRadians);
    const sin = Math.sin(angleRadians);
    const dot = vx * ax + vy * ay + vz * az;
    const crossX = ay * vz - az * vy;
    const crossY = az * vx - ax * vz;
    const crossZ = ax * vy - ay * vx;

    return [
      vx * cos + crossX * sin + ax * dot * (1 - cos),
      vy * cos + crossY * sin + ay * dot * (1 - cos),
      vz * cos + crossZ * sin + az * dot * (1 - cos),
    ];
  }

  function applySingleBand(currentRgb, sourceHsl, width, height, band, options) {
    const output = new Float32Array(currentRgb);
    const globalStrength = options.globalStrength ?? 1;
    const protection = options.protection;
    const diagnosticsBandId = options.diagnosticsBandId ?? null;
    const recordMasks = diagnosticsBandId === band.id;
    const totalPixels = width * height;
    const combinedMask = options.combinedMask ?? null;
    const rangeMaskState = options.rangeMaskState ?? null;
    const selectedMasks = recordMasks
      ? {
          hueMask: new Float32Array(totalPixels),
          satMask: new Float32Array(totalPixels),
          darkMask: new Float32Array(totalPixels),
          highlightMask: new Float32Array(totalPixels),
          finalMask: new Float32Array(totalPixels),
        }
      : null;

    for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += 1) {
      const baseIndex = pixelIndex * 3;
      const hue = sourceHsl.h[pixelIndex];
      const saturation = sourceHsl.s[pixelIndex];
      const lightness = sourceHsl.l[pixelIndex];
      const luminance = sourceHsl.y[pixelIndex];
      const rangeMaskValue = rangeMaskState && rangeMaskState.enabled
        ? clamp01(
            smoothstep(rangeMaskState.low - rangeMaskState.feather, rangeMaskState.low, luminance) *
            (1 - smoothstep(rangeMaskState.high, rangeMaskState.high + rangeMaskState.feather, luminance))
          )
        : 1;
      const masks = buildMasks(hue, saturation, lightness, band, protection, globalStrength, rangeMaskValue);
      const mask = masks.finalMask;

      if (combinedMask) {
        combinedMask[pixelIndex] = Math.max(combinedMask[pixelIndex], mask);
      }

      if (selectedMasks) {
        selectedMasks.hueMask[pixelIndex] = masks.hueMask;
        selectedMasks.satMask[pixelIndex] = masks.satMask;
        selectedMasks.darkMask[pixelIndex] = masks.darkMask;
        selectedMasks.highlightMask[pixelIndex] = masks.highlightMask;
        selectedMasks.finalMask[pixelIndex] = mask;
      }

      if (mask <= 0) {
        continue;
      }

      const r = output[baseIndex];
      const g = output[baseIndex + 1];
      const b = output[baseIndex + 2];
      const y = luma709(r, g, b);
      const chroma = [r - y, g - y, b - y];

      const satAdjust = band.saturation / 100;
      const satScale = Math.max(0, 1 + satAdjust * mask);
      const chroma2 = [chroma[0] * satScale, chroma[1] * satScale, chroma[2] * satScale];

      const angleRadians = (band.hueShift * Math.PI / 180) * mask;
      const chroma3 = rodriguesRotate(chroma2, AXIS, angleRadians);

      const lumAdjust = band.luminance / 100;
      const y2 = lumAdjust >= 0
        ? y + (lumAdjust * POSITIVE_LUMINANCE_GAIN) * mask * (1 - y)
        : y + lumAdjust * mask * y;

      output[baseIndex] = clamp01(y2 + chroma3[0]);
      output[baseIndex + 1] = clamp01(y2 + chroma3[1]);
      output[baseIndex + 2] = clamp01(y2 + chroma3[2]);
    }

    return {
      rgb: output,
      selectedMasks,
      combinedMask,
    };
  }

  function applyNeutralLuminance(currentRgb, sourceHsl, width, height, neutralState, options) {
    const output = new Float32Array(currentRgb);
    const globalStrength = options.globalStrength ?? 1;
    const protection = options.protection;
    const diagnosticsBandId = options.diagnosticsBandId ?? null;
    const recordMasks = diagnosticsBandId === "neutral";
    const totalPixels = width * height;
    const combinedMask = options.combinedMask ?? null;
    const rangeMaskState = options.rangeMaskState ?? null;
    const selectedMasks = recordMasks
      ? {
          hueMask: null,
          satMask: null,
          darkMask: new Float32Array(totalPixels),
          highlightMask: new Float32Array(totalPixels),
          finalMask: new Float32Array(totalPixels),
        }
      : null;

    for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += 1) {
      const baseIndex = pixelIndex * 3;
      const saturation = sourceHsl.s[pixelIndex];
      const lightness = sourceHsl.l[pixelIndex];
      const luminance = sourceHsl.y[pixelIndex];
      const rangeMaskValue = rangeMaskState && rangeMaskState.enabled
        ? clamp01(
            smoothstep(rangeMaskState.low - rangeMaskState.feather, rangeMaskState.low, luminance) *
            (1 - smoothstep(rangeMaskState.high, rangeMaskState.high + rangeMaskState.feather, luminance))
          )
        : 1;
      const relaxedDarkFloor = rangeMaskState && rangeMaskState.enabled
        ? protection.darkFloor * 0.25
        : protection.darkFloor;
      const relaxedDarkFull = rangeMaskState && rangeMaskState.enabled
        ? protection.darkFull * 0.6
        : protection.darkFull;
      const masks = buildNeutralMasks(saturation, lightness, neutralState, protection, globalStrength, rangeMaskValue, {
        neutralDarkFloor: relaxedDarkFloor,
        neutralDarkFull: relaxedDarkFull,
      });
      const mask = masks.finalMask;

      if (combinedMask) {
        combinedMask[pixelIndex] = Math.max(combinedMask[pixelIndex], mask);
      }

      if (selectedMasks) {
        selectedMasks.darkMask[pixelIndex] = masks.darkMask;
        selectedMasks.highlightMask[pixelIndex] = masks.highlightMask;
        selectedMasks.finalMask[pixelIndex] = mask;
      }

      if (mask <= 0) {
        continue;
      }

      const r = output[baseIndex];
      const g = output[baseIndex + 1];
      const b = output[baseIndex + 2];
      const y = luma709(r, g, b);
      const chroma = [r - y, g - y, b - y];
      const lumAdjust = neutralState.luminance / 100;
      const y2 = lumAdjust >= 0
        ? y + (lumAdjust * POSITIVE_LUMINANCE_GAIN) * mask * (1 - y)
        : y + lumAdjust * mask * y;

      output[baseIndex] = clamp01(y2 + chroma[0]);
      output[baseIndex + 1] = clamp01(y2 + chroma[1]);
      output[baseIndex + 2] = clamp01(y2 + chroma[2]);
    }

    return {
      rgb: output,
      selectedMasks,
      combinedMask,
    };
  }

  function applyAllBands(sourceRgb, width, height, bands, options = {}) {
    const protection = PROTECTION_PRESETS[options.imageType] || PROTECTION_PRESETS.stars;
    const h = new Float32Array(width * height);
    const s = new Float32Array(width * height);
    const l = new Float32Array(width * height);
    const y = new Float32Array(width * height);

    for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += 1) {
      const baseIndex = pixelIndex * 3;
      const [hue, sat, light] = rgbToHsl(
        sourceRgb[baseIndex],
        sourceRgb[baseIndex + 1],
        sourceRgb[baseIndex + 2]
      );
      h[pixelIndex] = hue;
      s[pixelIndex] = sat;
      l[pixelIndex] = light;
      y[pixelIndex] = luma709(
        sourceRgb[baseIndex],
        sourceRgb[baseIndex + 1],
        sourceRgb[baseIndex + 2]
      );
    }

    const sourceHsl = { h, s, l, y };
    const orderedBands = bands.slice();
    let currentRgb = new Float32Array(sourceRgb);
    const combinedMask = new Float32Array(width * height);
    let selectedMasks = null;

    orderedBands.forEach((band) => {
      const result = applySingleBand(currentRgb, sourceHsl, width, height, band, {
        globalStrength: options.globalStrength ?? 1,
        protection,
        diagnosticsBandId: options.selectedBandId ?? null,
        combinedMask,
        rangeMaskState: options.rangeMaskState ?? null,
      });
      currentRgb = result.rgb;
      if (result.selectedMasks) {
        selectedMasks = result.selectedMasks;
      }
    });

    // Apply neutral / low-saturation luminance as a final shaping pass for low-saturation regions.
    if (options.neutralLuminanceState && Math.abs(options.neutralLuminanceState.luminance) > EPSILON) {
      const neutralResult = applyNeutralLuminance(currentRgb, sourceHsl, width, height, options.neutralLuminanceState, {
        globalStrength: options.globalStrength ?? 1,
        protection,
        diagnosticsBandId: options.selectedBandId ?? null,
        combinedMask,
        rangeMaskState: options.rangeMaskState ?? null,
      });
      currentRgb = neutralResult.rgb;
      if (neutralResult.selectedMasks) {
        selectedMasks = neutralResult.selectedMasks;
      }
    }

    return {
      rgb: currentRgb,
      combinedMask,
      selectedMasks,
      sourceHsl,
      protection,
    };
  }

  window.AstroColorMath = {
    PROTECTION_PRESETS,
    clamp01,
    smoothstep,
    rgbToHsl,
    circularHueDistance,
    makeHueMask,
    buildMasks,
    buildNeutralMasks,
    luma709,
    rodriguesRotate,
    applySingleBand,
    applyNeutralLuminance,
    applyAllBands,
  };
})();
