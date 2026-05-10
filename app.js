(function () {
  const RECIPE_VERSION = "Astro Color Mixer Web v0.9.3-beta";
  const {
    loadImageFile,
    imageDataToFloat32Rgb,
    float32RgbToImageData,
    createDownsampledPreviewImageData,
    saveAdjustedPng,
    saveAdjustedTiff,
  } = window.AstroImageIO;
  const {
    applyAllBands,
    smoothstep,
    clamp01,
    rgbToHsl,
  } = window.AstroColorMath;
  const {
    BAND_DEFS,
    BUILT_IN_PRESETS,
    createBandDefaults,
    exportPresetToJson,
    importPresetFromJson,
    mergePresetIntoBands,
  } = window.AstroPresets;

  const SENSITIVITY_RANGES = {
    Fine: { hueShift: 5, saturation: 15, luminance: 10 },
    Normal: { hueShift: 20, saturation: 60, luminance: 30 },
    Advanced: { hueShift: 45, saturation: 100, luminance: 60 },
  };

  const RANGE_MASK_PRESETS = {
    All: { enabled: false, low: 0.0, high: 1.0, feather: 0.1, preset: "All" },
    Shadows: { enabled: true, low: 0.0, high: 0.33, feather: 0.08, preset: "Shadows" },
    Midtones: { enabled: true, low: 0.25, high: 0.75, feather: 0.1, preset: "Midtones" },
    Highlights: { enabled: true, low: 0.66, high: 1.0, feather: 0.08, preset: "Highlights" },
    "Faint Signal": { enabled: true, low: 0.05, high: 0.45, feather: 0.08, preset: "Faint Signal" },
    "Bright Cores / Stars": { enabled: true, low: 0.75, high: 1.0, feather: 0.05, preset: "Bright Cores / Stars" },
  };

  const PROCESS_DEBOUNCE_MS = 120;
  const FAST_PREVIEW_MAX_EDGE = 1100;
  const POLAR_SAMPLE_LIMIT = 2200;
  const HISTOGRAM_BINS = 256;
  const PROBE_MIN_SATURATION = 0.08;
  const PROBE_MIN_LUMINANCE = 0.02;
  const NEUTRAL_BAND_ID = "neutral";
  const NEUTRAL_LABEL = "Neutral / Low-Saturation";
  const NEUTRAL_SENSITIVITY_RANGES = {
    Fine: 5,
    Normal: 20,
    Advanced: 50,
  };
  const SLIDER_STEPS = {
    hueShift: 0.5,
    saturation: 1,
    luminance: 0.5,
    neutralLuminance: 0.5,
  };

  function createDefaultNeutralLuminance() {
    return {
      luminance: 0,
      satStart: 0.04,
      satFull: 0.16,
    };
  }

  function createDefaultRangeMask() {
    return { ...RANGE_MASK_PRESETS.All };
  }

  function createBasePass(id = 1) {
    const pass = createAdjustment(id, "Base Pass");
    pass.isBasePass = true;
    return pass;
  }

  function createAdjustmentName(baseLabel = "Pass", index = 1) {
    return `${baseLabel} ${index}`;
  }

  function createAdjustment(id, label = createAdjustmentName("Pass", id)) {
    return {
      id,
      label,
      isBasePass: false,
      enabled: true,
      selectedBandId: "red",
      soloBand: false,
      rangeMask: createDefaultRangeMask(),
      neutralLuminance: createDefaultNeutralLuminance(),
      bands: createBandDefaults(),
    };
  }

  function cloneAdjustment(adjustment, id, label) {
    return {
      id,
      label,
      isBasePass: false,
      enabled: adjustment.enabled,
      selectedBandId: adjustment.selectedBandId,
      soloBand: adjustment.soloBand,
      rangeMask: { ...adjustment.rangeMask },
      neutralLuminance: { ...adjustment.neutralLuminance },
      bands: adjustment.bands.map((band) => ({ ...band })),
    };
  }

  function buildCurrentRecipe() {
    return {
      version: RECIPE_VERSION,
      imageType: state.imageType,
      sensitivity: state.sensitivity,
      globalStrength: state.globalStrength,
      passes: state.adjustments.map((adjustment) => ({
        id: adjustment.id,
        label: adjustment.label,
        isBasePass: adjustment.isBasePass,
        enabled: adjustment.enabled,
        selectedBandId: adjustment.selectedBandId,
        soloBand: adjustment.soloBand,
        rangeMask: { ...adjustment.rangeMask },
        neutralLuminance: { ...adjustment.neutralLuminance },
        bands: adjustment.bands.map((band) => ({ ...band })),
      })),
      activePassId: state.selectedAdjustmentId,
    };
  }

  function applyRecipeToState(recipeLike) {
    const recipe = typeof recipeLike === "string" ? JSON.parse(recipeLike) : recipeLike;
    state.imageType = recipe.imageType || "stars";
    state.sensitivity = recipe.sensitivity || "Normal";
    state.globalStrength = typeof recipe.globalStrength === "number" ? recipe.globalStrength : 1;
    state.adjustments = Array.isArray(recipe.passes) && recipe.passes.length
      ? recipe.passes.map((pass, index) => ({
          ...createAdjustment(pass.id ?? index + 1, pass.label ?? `Pass ${index + 1}`),
          ...pass,
          enabled: pass.enabled !== false,
          rangeMask: { ...createDefaultRangeMask(), ...(pass.rangeMask || {}) },
          neutralLuminance: { ...createDefaultNeutralLuminance(), ...(pass.neutralLuminance || {}) },
          bands: Array.isArray(pass.bands) && pass.bands.length
            ? mergePresetIntoBands(createBandDefaults(), Object.fromEntries(pass.bands.map((band) => [band.id, band])))
            : createBandDefaults(),
        }))
      : [createBasePass(1)];
    state.selectedAdjustmentId = recipe.activePassId || state.adjustments[0].id;
    state.nextAdjustmentId = state.adjustments.reduce((maxId, adjustment) => Math.max(maxId, adjustment.id), 0) + 1;
    clampBandsToSensitivity();
    populateSelectors();
    renderAdjustmentStack();
    renderStarterPresetsState();
    syncActivePassCard();
    renderSliderPanel();
    syncSelectedBandControls();
    syncRangeMaskControls();
    updateHueWheel();
    renderPreview(true);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function imageDataToCanvas(imageData) {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext("2d").putImageData(imageData, 0, 0);
    return canvas;
  }

  function maskToImageData(mask, width, height) {
    const imageData = new ImageData(width, height);
    const rgba = imageData.data;
    if (!mask) {
      return imageData;
    }
    for (let i = 0; i < mask.length; i += 1) {
      const value = Math.round(clamp(mask[i], 0, 1) * 255);
      const dst = i * 4;
      rgba[dst] = value;
      rgba[dst + 1] = value;
      rgba[dst + 2] = value;
      rgba[dst + 3] = 255;
    }
    return imageData;
  }

  function maskToFloat32Rgb(mask, width, height) {
    const rgb = new Float32Array(width * height * 3);
    if (!mask) {
      return rgb;
    }
    for (let index = 0; index < mask.length; index += 1) {
      const value = clamp(mask[index], 0, 1);
      const dst = index * 3;
      rgb[dst] = value;
      rgb[dst + 1] = value;
      rgb[dst + 2] = value;
    }
    return rgb;
  }

  function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function drawViewportProbe(ctx, screenX, screenY) {
    ctx.save();
    ctx.strokeStyle = "rgba(255, 235, 168, 0.96)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(screenX, screenY, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(10, 12, 16, 0.9)";
    ctx.lineWidth = 2.8;
    ctx.beginPath();
    ctx.moveTo(screenX - 10, screenY);
    ctx.lineTo(screenX + 10, screenY);
    ctx.moveTo(screenX, screenY - 10);
    ctx.lineTo(screenX, screenY + 10);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 235, 168, 0.96)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(screenX - 10, screenY);
    ctx.lineTo(screenX + 10, screenY);
    ctx.moveTo(screenX, screenY - 10);
    ctx.lineTo(screenX, screenY + 10);
    ctx.stroke();
    ctx.restore();
  }

  function computeRangeMask(luminance, rangeMaskState) {
    if (!rangeMaskState.enabled) {
      return 1.0;
    }
    const low = rangeMaskState.low;
    const high = rangeMaskState.high;
    const feather = rangeMaskState.feather;
    const leftRamp = smoothstep(low - feather, low, luminance);
    const rightRamp = 1 - smoothstep(high, high + feather, luminance);
    return clamp01(leftRamp * rightRamp);
  }

  class CanvasViewport {
    constructor({
      canvas,
      container,
      zoomSlider,
      zoomValue,
      statusBar,
      label,
      onProbe = null,
      onCompareChange = null,
    }) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.container = container;
      this.zoomSlider = zoomSlider;
      this.zoomValue = zoomValue;
      this.statusBar = statusBar;
      this.label = label;
      this.onProbe = onProbe;
      this.onCompareChange = onCompareChange;

      this.originalSource = null;
      this.displaySource = null;
      this.imageWidth = 0;
      this.imageHeight = 0;
      this.scale = 1;
      this.fitScale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this.isFitMode = true;
      this.isDragging = false;
      this.lastPointerX = 0;
      this.lastPointerY = 0;
      this.pointerDownX = 0;
      this.pointerDownY = 0;
      this.showOriginalHold = false;
      this.allowOriginalHold = true;
      this.holdThreshold = 5;
      this.holdDelayMs = 200;
      this.defaultLabelText = "Adjusted View — click to probe · hold to compare before this pass";
      this.holdLabelText = "Before Active Pass — release to return to final";
      this.statusLines = [];
      this.probe = null;
      this.holdTimerId = 0;
      this.didDrag = false;
      this.holdActivated = false;
      this.activePointerId = null;

      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);

      this.runUiCallback = (callback, ...args) => {
        if (typeof callback !== "function") {
          return;
        }
        window.requestAnimationFrame(() => {
          try {
            callback(...args);
          } catch (error) {
            console.error(error);
            this.log(`UI callback error: ${error?.message || error}`);
          }
        });
      };

      this.canvas.addEventListener("wheel", (event) => {
        if (!this.displaySource) {
          return;
        }
        event.preventDefault();
        const direction = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        const nextScale = clamp(this.scale * direction, 0.1, 8);
        this.setZoom(nextScale, event.offsetX, event.offsetY);
        this.log(`wheel ${nextScale.toFixed(2)}x`);
      }, { passive: false });

      this.canvas.addEventListener("pointerdown", (event) => {
        if (!this.displaySource) {
          return;
        }
        this.activePointerId = event.pointerId;
        this.isDragging = true;
        this.didDrag = false;
        this.holdActivated = false;
        this.lastPointerX = event.clientX;
        this.lastPointerY = event.clientY;
        this.pointerDownX = event.clientX;
        this.pointerDownY = event.clientY;
        window.clearTimeout(this.holdTimerId);
        if (this.allowOriginalHold && this.originalSource) {
          this.holdTimerId = window.setTimeout(() => {
            if (!this.isDragging || this.didDrag) {
              return;
            }
            this.showOriginalHold = true;
            this.holdActivated = true;
            this.render("hold-original");
            this.runUiCallback(this.onCompareChange, true);
          }, this.holdDelayMs);
        }
        this.canvas.setPointerCapture(event.pointerId);
      });

      this.canvas.addEventListener("pointermove", (event) => {
        if (!this.isDragging || !this.displaySource) {
          return;
        }
        const movedX = event.clientX - this.pointerDownX;
        const movedY = event.clientY - this.pointerDownY;
        if (!this.didDrag && Math.hypot(movedX, movedY) > this.holdThreshold) {
          this.didDrag = true;
          window.clearTimeout(this.holdTimerId);
          if (this.showOriginalHold) {
            this.showOriginalHold = false;
            this.holdActivated = false;
          }
          this.lastPointerX = event.clientX;
          this.lastPointerY = event.clientY;
          this.render("hold-cancel");
          this.runUiCallback(this.onCompareChange, false);
          return;
        }
        if (!this.didDrag) {
          return;
        }
        const deltaX = event.clientX - this.lastPointerX;
        const deltaY = event.clientY - this.lastPointerY;
        this.lastPointerX = event.clientX;
        this.lastPointerY = event.clientY;
        this.offsetX += deltaX;
        this.offsetY += deltaY;
        this.isFitMode = false;
        this.render("pan");
      });

      const endDrag = (event) => {
        if (!this.isDragging) {
          return;
        }
        window.clearTimeout(this.holdTimerId);
        this.isDragging = false;
        const shouldProbe = !this.didDrag && !this.holdActivated;
        const probeX = event.offsetX;
        const probeY = event.offsetY;
        this.showOriginalHold = false;
        this.holdActivated = false;
        this.render("hold-adjusted");
        this.runUiCallback(this.onCompareChange, false);
        if (shouldProbe) {
          this.runUiCallback(this.onProbe, probeX, probeY);
        }
        if (typeof event.pointerId === "number" && this.canvas.hasPointerCapture(event.pointerId)) {
          this.canvas.releasePointerCapture(event.pointerId);
        }
        this.activePointerId = null;
      };

      this.canvas.addEventListener("pointerup", endDrag);
      this.canvas.addEventListener("pointercancel", endDrag);

      window.addEventListener("keydown", (event) => {
        if (event.code !== "Space" || event.repeat || !this.displaySource || !this.allowOriginalHold || !this.originalSource) {
          return;
        }
        this.showOriginalHold = true;
        this.render("hold-original");
        this.runUiCallback(this.onCompareChange, true);
      });

      window.addEventListener("keyup", (event) => {
        if (event.code !== "Space") {
          return;
        }
        this.showOriginalHold = false;
        this.render("hold-adjusted");
        this.runUiCallback(this.onCompareChange, false);
      });
    }

    setSources({
      originalSource,
      displaySource,
      labelText,
      holdLabelText,
      allowOriginalHold = true,
    }) {
      this.originalSource = originalSource || null;
      this.displaySource = displaySource || null;
      this.allowOriginalHold = allowOriginalHold;
      this.defaultLabelText = labelText || "Adjusted View — click to probe · hold to compare before this pass";
      this.holdLabelText = holdLabelText || (allowOriginalHold
        ? "Before Active Pass — release to return to final"
        : "Original View");
      this.showOriginalHold = false;

      if (this.displaySource) {
        this.imageWidth = this.displaySource.width;
        this.imageHeight = this.displaySource.height;
      } else if (this.originalSource) {
        this.imageWidth = this.originalSource.width;
        this.imageHeight = this.originalSource.height;
      } else {
        this.imageWidth = 0;
        this.imageHeight = 0;
      }
    }

    fit() {
      if (!this.displaySource) {
        return;
      }
      const { width, height } = this.getContainerSize();
      this.fitScale = Math.min(width / this.imageWidth, height / this.imageHeight);
      this.scale = this.fitScale;
      this.offsetX = (width - this.imageWidth * this.scale) / 2;
      this.offsetY = (height - this.imageHeight * this.scale) / 2;
      this.isFitMode = true;
      this.render("fit");
    }

    setZoom(scale, anchorX = null, anchorY = null) {
      if (!this.displaySource) {
        return;
      }
      const nextScale = clamp(scale, 0.1, 8);
      const useAnchor = Number.isFinite(anchorX) && Number.isFinite(anchorY);

      if (useAnchor) {
        const imagePoint = this.screenToImage(anchorX, anchorY);
        this.scale = nextScale;
        this.offsetX = anchorX - imagePoint.x * this.scale;
        this.offsetY = anchorY - imagePoint.y * this.scale;
      } else {
        const { width, height } = this.getContainerSize();
        const centerX = width / 2;
        const centerY = height / 2;
        const imagePoint = this.screenToImage(centerX, centerY);
        this.scale = nextScale;
        this.offsetX = centerX - imagePoint.x * this.scale;
        this.offsetY = centerY - imagePoint.y * this.scale;
      }

      this.isFitMode = Math.abs(this.scale - this.fitScale) < 0.0001;
      this.render("zoom");
    }

    setZoomPreset(scale) {
      this.setZoom(scale);
    }

    setZoomFromUi(value) {
      this.setZoom(Number(value));
    }

    setProbe(probe) {
      this.probe = probe;
      this.render("probe");
    }

    resetInteraction() {
      window.clearTimeout(this.holdTimerId);
      if (typeof this.activePointerId === "number" && this.canvas.hasPointerCapture(this.activePointerId)) {
        this.canvas.releasePointerCapture(this.activePointerId);
      }
      this.isDragging = false;
      this.didDrag = false;
      this.holdActivated = false;
      this.showOriginalHold = false;
      this.activePointerId = null;
      this.render("interaction-reset");
    }

    render(reason = "render") {
      const { width, height, dpr } = this.resizeCanvas();

      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      if (!this.displaySource) {
        this.updateUi(reason);
        return;
      }

      const source = this.showOriginalHold && this.allowOriginalHold && this.originalSource
        ? this.originalSource
        : this.displaySource;

      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.save();
      this.ctx.translate(this.offsetX, this.offsetY);
      this.ctx.scale(this.scale, this.scale);
      this.ctx.drawImage(source, 0, 0);
      this.ctx.restore();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (this.probe) {
        const probeScreen = this.imageToScreen(this.probe.x, this.probe.y);
        drawViewportProbe(this.ctx, probeScreen.x * dpr, probeScreen.y * dpr);
      }

      this.updateUi(
        reason,
        `draw=${Math.round(this.imageWidth * this.scale)}x${Math.round(this.imageHeight * this.scale)} @ ${Math.round(this.offsetX)},${Math.round(this.offsetY)} view=${width}x${height}`
      );
    }

    resize() {
      if (!this.displaySource) {
        this.resizeCanvas();
        this.render("resize-empty");
        return;
      }
      if (this.isFitMode) {
        this.fit();
        return;
      }
      this.render("resize");
    }

    screenToImage(x, y) {
      return {
        x: (x - this.offsetX) / this.scale,
        y: (y - this.offsetY) / this.scale,
      };
    }

    imageToScreen(x, y) {
      return {
        x: this.offsetX + x * this.scale,
        y: this.offsetY + y * this.scale,
      };
    }

    resizeCanvas() {
      const { width, height } = this.getContainerSize();
      const dpr = window.devicePixelRatio || 1;
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));

      if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
        this.canvas.width = pixelWidth;
        this.canvas.height = pixelHeight;
      }

      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;

      return { width, height, dpr };
    }

    getContainerSize() {
      return {
        width: Math.max(1, this.container.clientWidth),
        height: Math.max(1, this.container.clientHeight),
      };
    }

    updateUi(reason, extra = "") {
      if (this.label) {
        this.label.textContent = this.showOriginalHold && this.allowOriginalHold
          ? this.holdLabelText
          : this.defaultLabelText;
      }
      if (this.zoomSlider) {
        this.zoomSlider.value = String(this.scale);
      }
      if (this.zoomValue) {
        this.zoomValue.textContent = this.isFitMode ? "Fit" : `${this.scale.toFixed(2)}x`;
      }
      if (extra) {
        this.log(`${reason}: scale=${this.scale.toFixed(4)} fit=${this.fitScale.toFixed(4)} ${extra}`);
      }
    }

    log(message) {
      if (!this.statusBar) {
        return;
      }
      const stamp = new Date().toLocaleTimeString();
      this.statusLines.push(`[${stamp}] ${message}`);
      this.statusLines = this.statusLines.slice(-18);
      this.statusBar.textContent = this.statusLines.join("\n");
      this.statusBar.scrollTop = this.statusBar.scrollHeight;
    }
  }

  const state = {
    appMode: "standard",
    imageType: "stars",
    sensitivity: "Normal",
    globalStrength: 1,
    selectedTab: "saturation",
    selectedToolTab: "band",
    previewMode: "adjusted",
    bypass: false,
    autoPreview: true,
    fastPreview: true,
    autoSelectBandFromProbe: true,
    analysisOpen: true,
    analysisMode: "compact",
    panelContentMode: "diagnostics",
    compareMode: "auto",
    polarMode: "selected",
    affectedOnly: false,
    nextAdjustmentId: 2,
    selectedAdjustmentId: 1,
    adjustments: [createBasePass(1)],
    pendingRangeMaskState: null,
    pendingPreset: null,
    previewSource: null,
    loadedImageData: null,
    loadedImageModel: null,
    loadedFullRgb: null,
    loadedImageName: "",
    loadedWidth: 0,
    loadedHeight: 0,
    previewRgb: null,
    previewWidth: 0,
    previewHeight: 0,
    currentResult: null,
    processTimerId: 0,
    processFrameId: 0,
    processRequestId: 0,
    passUiFrameId: 0,
    lastProcessAt: 0,
    isSaving: false,
    probe: null,
    starterPresetsAutoCollapsed: false,
    hasSeenAdvancedModeIntro: false,
    sliderInteractionDepth: 0,
  };

  const elements = {
    technicalAppendixButton: document.getElementById("technical-appendix-btn"),
    faqButton: document.getElementById("faq-btn"),
    loadButton: document.getElementById("load-image-btn"),
    saveButton: document.getElementById("save-image-btn"),
    savePresetButton: document.getElementById("save-preset-btn"),
    loadPresetButton: document.getElementById("load-preset-btn"),
    starterPresetsPanel: document.getElementById("starter-presets-panel"),
    starterPresetSelect: document.getElementById("starter-preset-select"),
    applyStarterPresetButton: document.getElementById("apply-starter-preset-btn"),
    appModeSelect: document.getElementById("app-mode-select"),
    modeHint: document.getElementById("mode-hint"),
    renderPreviewButton: document.getElementById("render-preview-btn"),
    input: document.getElementById("image-file-input"),
    presetInput: document.getElementById("preset-file-input"),
    imageTypeSelect: document.getElementById("image-type-select"),
    sensitivitySelect: document.getElementById("sensitivity-select"),
    previewModeSelect: document.getElementById("preview-mode-select"),
    compareModeSelect: document.getElementById("compare-mode-select"),
    analysisModeSelect: document.getElementById("analysis-mode-select"),
    exportFormatSelect: document.getElementById("export-format-select"),
    bypassToggle: document.getElementById("bypass-toggle"),
    autoPreviewToggle: document.getElementById("auto-preview-toggle"),
    fastPreviewToggle: document.getElementById("fast-preview-toggle"),
    fitButton: document.getElementById("fit-btn"),
    zoom1xButton: document.getElementById("zoom-100-btn"),
    zoom2xButton: document.getElementById("zoom-200-btn"),
    zoomSlider: document.getElementById("zoom-slider"),
    zoomValue: document.getElementById("zoom-value"),
    canvas: document.getElementById("preview-canvas"),
    wrap: document.getElementById("canvas-wrap"),
    label: document.getElementById("preview-label"),
    previewFile: document.getElementById("preview-file"),
    previewWarning: document.getElementById("preview-warning"),
    statusBar: document.getElementById("status-bar"),
    canvasHint: document.getElementById("canvas-hint"),
    analysisPanel: document.getElementById("analysis-panel"),
    analysisSummaryLine: document.getElementById("analysis-summary-line"),
    panelModeDiagnosticsBtn: document.getElementById("panel-mode-diagnostics-btn"),
    panelModePassesBtn: document.getElementById("panel-mode-passes-btn"),
    panelModeSplitBtn: document.getElementById("panel-mode-split-btn"),
    analysisDiagnosticsGrid: document.getElementById("analysis-diagnostics-grid"),
    passManagerCard: document.getElementById("pass-manager-card"),
    passManagerList: document.getElementById("pass-manager-list"),
    passManagerNewBtn: document.getElementById("pass-manager-new-btn"),
    passManagerDuplicateBtn: document.getElementById("pass-manager-duplicate-btn"),
    passManagerDeleteBtn: document.getElementById("pass-manager-delete-btn"),
    passManagerHeader: document.querySelector("#pass-manager-card .pass-manager-header"),
    passManagerActions: document.querySelector("#pass-manager-card .pass-manager-actions"),
    polarLayout: document.querySelector("#analysis-panel .polar-layout"),
    polarSide: document.querySelector("#analysis-panel .polar-side"),
    polarModeSelect: document.getElementById("polar-mode-select"),
    affectedOnlyToggle: document.getElementById("affected-only-toggle"),
    diagnosticStats: document.getElementById("diagnostic-stats"),
    polarCanvas: document.getElementById("polar-canvas"),
    polarStateLabel: document.getElementById("polar-state-label"),
    histogramCanvas: document.getElementById("histogram-canvas"),
    histogramStateLabel: document.getElementById("histogram-state-label"),
    histogramStats: document.getElementById("histogram-stats"),
    autoSelectProbeToggle: document.getElementById("auto-select-probe-toggle"),
    probeReadout: document.getElementById("probe-readout"),
    debugPanel: document.getElementById("debug-panel"),
    analysisBody: document.querySelector("#analysis-panel .analysis-body"),
    analysisToolbar: document.querySelector("#analysis-panel .analysis-panel-toolbar"),
    histogramCard: document.querySelector("#analysis-panel .histogram-card"),
    polarCard: document.querySelector("#analysis-panel .polar-card"),
    tabButtons: Array.from(document.querySelectorAll("[data-tab]")),
    toolTabButtons: Array.from(document.querySelectorAll("[data-tool-tab]")),
    sliderPanel: document.getElementById("slider-panel"),
    activeSummary: document.getElementById("active-summary"),
    activePassStrip: document.getElementById("active-pass-strip"),
    passSelect: document.getElementById("pass-select"),
    addAdjustmentBtn: document.getElementById("add-adjustment-btn"),
    duplicateAdjustmentBtn: document.getElementById("duplicate-adjustment-btn"),
    deleteAdjustmentBtn: document.getElementById("delete-adjustment-btn"),
    activePassTitle: document.getElementById("active-pass-title"),
    activePassPill: document.getElementById("active-pass-pill"),
    activePassCompareNote: document.getElementById("active-pass-compare-note"),
    selectedBandPill: document.getElementById("selected-band-pill"),
    selectedBandSelect: document.getElementById("selected-band-select"),
    soloBandToggle: document.getElementById("solo-band-toggle"),
    soloBandToggleButton: document.getElementById("solo-band-toggle-btn"),
    widthSlider: document.getElementById("width-slider"),
    widthValue: document.getElementById("width-value"),
    featherSlider: document.getElementById("feather-slider"),
    featherValue: document.getElementById("feather-value"),
    hueWheelCanvas: document.getElementById("hue-wheel-canvas"),
    hueProfileCanvas: document.getElementById("hue-profile-canvas"),
    hueWheelReadout: document.getElementById("hue-wheel-readout"),
    resetSelectedMiniBtn: document.getElementById("reset-selected-mini-btn"),
    resetSelectedBtn: document.getElementById("reset-selected-btn"),
    resetAllBtn: document.getElementById("reset-all-btn"),
    bandTab: document.getElementById("band-tab"),
    rangeMaskTab: document.getElementById("range-mask-tab"),
    rangeMaskStatus: document.getElementById("range-mask-status"),
    rangeMaskEnabled: document.getElementById("range-mask-enabled"),
    rangeMaskPreset: document.getElementById("range-mask-preset"),
    rangeMaskLow: document.getElementById("range-mask-low"),
    rangeMaskHigh: document.getElementById("range-mask-high"),
    rangeMaskFeather: document.getElementById("range-mask-feather"),
    rangeMaskLowValue: document.getElementById("range-mask-low-value"),
    rangeMaskHighValue: document.getElementById("range-mask-high-value"),
    rangeMaskFeatherValue: document.getElementById("range-mask-feather-value"),
    resetRangeMaskMiniBtn: document.getElementById("reset-range-mask-mini-btn"),
    resetRangeMaskBtn: document.getElementById("reset-range-mask-btn"),
    rangeMaskPassModal: document.getElementById("range-mask-pass-modal"),
    rangeMaskKeepCurrentBtn: document.getElementById("range-mask-keep-current-btn"),
    rangeMaskNewPassBtn: document.getElementById("range-mask-new-pass-btn"),
    rangeMaskCancelBtn: document.getElementById("range-mask-cancel-btn"),
    presetPassModal: document.getElementById("preset-pass-modal"),
    presetReplaceCurrentBtn: document.getElementById("preset-replace-current-btn"),
    presetApplyNewPassBtn: document.getElementById("preset-apply-new-pass-btn"),
    presetCancelBtn: document.getElementById("preset-cancel-btn"),
    advancedModeModal: document.getElementById("advanced-mode-modal"),
    advancedModeContinueBtn: document.getElementById("advanced-mode-continue-btn"),
    advancedModeCancelBtn: document.getElementById("advanced-mode-cancel-btn"),
  };

  const viewport = new CanvasViewport({
    canvas: elements.canvas,
    container: elements.wrap,
    zoomSlider: elements.zoomSlider,
    zoomValue: elements.zoomValue,
    statusBar: elements.statusBar,
    label: elements.label,
    onProbe: handlePreviewProbeAtScreenPoint,
    onCompareChange: () => updateAnalysis(),
  });

  function getSelectedAdjustment() {
    return state.adjustments.find((adjustment) => adjustment.id === state.selectedAdjustmentId) || state.adjustments[0];
  }

  function getAdjustmentById(id) {
    return state.adjustments.find((adjustment) => adjustment.id === id) || null;
  }

  function getSelectedBandId() {
    return getSelectedAdjustment().selectedBandId;
  }

  function hasMeaningfulEdits(adjustment) {
    if (Math.abs(adjustment.neutralLuminance.luminance) > 0.0001) {
      return true;
    }
    return adjustment.bands.some((band) =>
      Math.abs(band.hueShift) > 0.0001 ||
      Math.abs(band.saturation) > 0.0001 ||
      Math.abs(band.luminance) > 0.0001
    );
  }

  function isBasePass(adjustment) {
    return Boolean(adjustment?.isBasePass);
  }

  function getNextPassNumber() {
    let maxNumber = 1;
    state.adjustments.forEach((adjustment) => {
      const match = adjustment.label.match(/Pass\s+(\d+)/i);
      if (match) {
        maxNumber = Math.max(maxNumber, Number(match[1]));
      }
    });
    return maxNumber + 1;
  }

  function getPassTypeLabel(adjustment) {
    if (isBasePass(adjustment)) {
      return "Global";
    }
    return adjustment.rangeMask.enabled ? "Targeted" : "Refinement";
  }

  function summarizePassAdjustments(adjustment) {
    const parts = [];
    if (Math.abs(adjustment.neutralLuminance.luminance) > 0.0001) {
      parts.push(`Neutral L ${formatSignedInt(adjustment.neutralLuminance.luminance)}`);
    }
    adjustment.bands.forEach((band) => {
      if (Math.abs(band.hueShift) > 0.0001) {
        parts.push(`${shortBandLabel(band.label)} H ${formatSignedInt(band.hueShift)}`);
      }
      if (Math.abs(band.saturation) > 0.0001) {
        parts.push(`${shortBandLabel(band.label)} S ${formatSignedInt(band.saturation)}`);
      }
      if (Math.abs(band.luminance) > 0.0001) {
        parts.push(`${shortBandLabel(band.label)} L ${formatSignedInt(band.luminance)}`);
      }
    });
    return parts.length ? parts.slice(0, 3).join(" · ") : "No active adjustments";
  }

  function summarizePassRangeMask(adjustment) {
    if (!adjustment.rangeMask.enabled) {
      return "Range Off";
    }
    if (adjustment.rangeMask.preset && adjustment.rangeMask.preset !== "Custom" && adjustment.rangeMask.preset !== "All") {
      return `Range ${adjustment.rangeMask.preset}`;
    }
    return `Range ${adjustment.rangeMask.low.toFixed(2)}–${adjustment.rangeMask.high.toFixed(2)} · F ${adjustment.rangeMask.feather.toFixed(2)}`;
  }

  function getCompactRangeMaskStatus(adjustment = getSelectedAdjustment()) {
    if (!adjustment.rangeMask.enabled) {
      return "Range Mask: Off";
    }
    if (adjustment.rangeMask.preset && adjustment.rangeMask.preset !== "Custom" && adjustment.rangeMask.preset !== "All") {
      return `Range Mask: ${adjustment.rangeMask.preset}`;
    }
    return `Range ${adjustment.rangeMask.low.toFixed(2)}–${adjustment.rangeMask.high.toFixed(2)} · F ${adjustment.rangeMask.feather.toFixed(2)}`;
  }

  function createNeutralPass(label = `Pass ${getNextPassNumber()}`) {
    return createAdjustment(state.nextAdjustmentId++, label);
  }

  function isDefaultRangeMask(rangeMask) {
    return !rangeMask.enabled &&
      Math.abs(rangeMask.low - 0) <= 0.0001 &&
      Math.abs(rangeMask.high - 1) <= 0.0001 &&
      Math.abs(rangeMask.feather - 0.1) <= 0.0001 &&
      (rangeMask.preset || "All") === "All";
  }

  function isAdvancedMode() {
    return state.appMode === "advanced";
  }

  function syncAppModeUI() {
    document.body.dataset.appMode = state.appMode;
    if (elements.appModeSelect) {
      elements.appModeSelect.value = state.appMode;
    }
    if (elements.modeHint) {
      elements.modeHint.textContent = isAdvancedMode()
        ? "Passes + masks"
        : "Single pass";
    }
    if (!isAdvancedMode()) {
      state.panelContentMode = "diagnostics";
      state.selectedToolTab = "band";
      if (!["adjusted", "original"].includes(state.previewMode)) {
        state.previewMode = "adjusted";
      }
    } else if (state.panelContentMode === "diagnostics") {
      state.panelContentMode = "split";
    }
  }

  function maybeForkRangeMask(nextRangeMask) {
    const adjustment = getSelectedAdjustment();
    if (!adjustment.rangeMask.enabled && nextRangeMask.enabled && hasMeaningfulEdits(adjustment)) {
      state.pendingRangeMaskState = { ...nextRangeMask };
      renderRangeMaskPassPrompt(true);
      return true;
    }
    if (!adjustment.rangeMask.enabled && !nextRangeMask.enabled) {
      adjustment.rangeMask = nextRangeMask;
      return false;
    }
    adjustment.rangeMask = nextRangeMask;
    return false;
  }

  function renderRangeMaskPassPrompt(visible) {
    if (!elements.rangeMaskPassModal) {
      return;
    }
    elements.rangeMaskPassModal.classList.toggle("is-hidden", !visible);
    elements.rangeMaskPassModal.setAttribute("aria-hidden", String(!visible));
    if (visible) {
      window.requestAnimationFrame(() => elements.rangeMaskNewPassBtn?.focus());
    }
  }

  function renderPresetPassPrompt(visible) {
    if (!elements.presetPassModal) {
      return;
    }
    elements.presetPassModal.classList.toggle("is-hidden", !visible);
    elements.presetPassModal.setAttribute("aria-hidden", String(!visible));
  }

  function renderAdvancedModePrompt(visible) {
    if (!elements.advancedModeModal) {
      return;
    }
    elements.advancedModeModal.classList.toggle("is-hidden", !visible);
    elements.advancedModeModal.setAttribute("aria-hidden", String(!visible));
    if (visible) {
      window.requestAnimationFrame(() => elements.advancedModeContinueBtn?.focus());
    }
  }

  function renderStarterPresetsState() {
    if (!elements.starterPresetsPanel) {
      return;
    }
    const hasRefinementPasses = state.adjustments.length > 1;
    const shouldDemote = hasRefinementPasses || isAdvancedMode() || hasMeaningfulEdits(getSelectedAdjustment());
    elements.starterPresetsPanel.classList.toggle("is-demoted", shouldDemote);
    if (isAdvancedMode()) {
      elements.starterPresetsPanel.open = false;
      state.starterPresetsAutoCollapsed = true;
      return;
    }
    if (shouldDemote && !state.starterPresetsAutoCollapsed) {
      elements.starterPresetsPanel.open = false;
      state.starterPresetsAutoCollapsed = true;
    }
    if (!shouldDemote) {
      elements.starterPresetsPanel.open = true;
    }
  }

  function syncActivePassCard() {
    if (!elements.activePassTitle || !elements.activePassPill || !elements.activePassCompareNote) {
      return;
    }
    const adjustment = getSelectedAdjustment();
    if (elements.activePassStrip) {
      elements.activePassStrip.textContent = `Active Pass: ${adjustment.label} · ${getCompactRangeMaskStatus(adjustment)}`;
    }
    elements.activePassTitle.textContent = `Editing: ${adjustment.label}`;
    elements.activePassPill.textContent = isBasePass(adjustment)
      ? "Global pass"
      : (adjustment.rangeMask.enabled ? "Targeted refinement" : "Refinement pass");
    if (!isAdvancedMode()) {
      elements.activePassCompareNote.textContent = "Editing adjusted image.";
      return;
    }
    const compareLabel = state.compareMode === "original"
      ? "Compare to original"
      : (state.compareMode === "pass" ? "Compare to before this pass" : "Compare auto");
    elements.activePassCompareNote.textContent = isBasePass(adjustment)
      ? `Editing Base Pass · Global · ${compareLabel}`
      : `${adjustment.rangeMask.enabled ? "Editing targeted pass · Range Mask" : "Editing refinement pass"} · ${compareLabel}`;
  }

  function applyPendingRangeMaskToCurrentPass() {
    if (!state.pendingRangeMaskState) {
      return;
    }
    getSelectedAdjustment().rangeMask = { ...state.pendingRangeMaskState };
    state.pendingRangeMaskState = null;
    renderRangeMaskPassPrompt(false);
    syncRangeMaskControls();
    renderAdjustmentStack();
    updateAnalysis();
    renderPreview(true);
  }

  function createRangeMaskRefinementPass() {
    if (!state.pendingRangeMaskState) {
      return;
    }
    viewport.resetInteraction();
    const current = getSelectedAdjustment();
    const passNumber = getNextPassNumber();
    const refinement = createAdjustment(state.nextAdjustmentId++, `Pass ${passNumber}: Range Mask`);
    refinement.selectedBandId = current.selectedBandId;
    refinement.rangeMask = { ...state.pendingRangeMaskState };
    state.adjustments.push(refinement);
    state.pendingRangeMaskState = null;
    renderRangeMaskPassPrompt(false);
    state.selectedAdjustmentId = refinement.id;
    populateSelectors();
    renderAdjustmentStack();
    renderPassManager();
    renderStarterPresetsState();
    syncActivePassCard();
    renderSliderPanel();
    syncSelectedBandControls();
    syncRangeMaskControls();
    updateHueWheel();
    window.requestAnimationFrame(() => renderPreview(true));
    viewport.log("New refinement pass created for targeted Range Mask work.");
  }

  function init() {
    syncAppModeUI();
    if (elements.debugPanel) {
      elements.debugPanel.open = false;
    }
    if (elements.analysisPanel) {
      elements.analysisPanel.open = state.analysisOpen;
      elements.analysisPanel.dataset.mode = state.analysisMode;
    }
    populateSelectors();
    bindEvents();
    syncTabButtons();
    syncToolTabs();
    syncAnalysisPanel();
    renderAdjustmentStack();
    renderStarterPresetsState();
    syncActivePassCard();
    renderSliderPanel();
    syncSelectedBandControls();
    syncRangeMaskControls();
    updateHueWheel();
    syncPreviewFile();
    viewport.render();
  }

  function populateSelectors() {
    const adjustment = getSelectedAdjustment();
    if (elements.appModeSelect) {
      elements.appModeSelect.value = state.appMode;
    }
    elements.imageTypeSelect.innerHTML = `
      <option value="stars">Stars Present</option>
      <option value="starless">Starless / Star-Reduced</option>
    `;
    elements.imageTypeSelect.value = state.imageType;

    elements.sensitivitySelect.innerHTML = Object.keys(SENSITIVITY_RANGES)
      .map((name) => `<option value="${name}">${name}</option>`)
      .join("");
    elements.sensitivitySelect.value = state.sensitivity;

    const hasActiveRangeMask = !!(adjustment && adjustment.rangeMask && adjustment.rangeMask.enabled);
    if (state.appMode === "standard" && !["adjusted", "original"].includes(state.previewMode)) {
      state.previewMode = "adjusted";
    }
    if (!hasActiveRangeMask && state.previewMode === "range-mask") {
      state.previewMode = "adjusted";
    }
    elements.previewModeSelect.innerHTML = state.appMode === "advanced"
      ? `
        <option value="adjusted">Adjusted</option>
        <option value="original">Original</option>
        <option value="current-mask">Current Mask</option>
        <option value="combined-mask">Combined Mask</option>
        ${hasActiveRangeMask ? '<option value="range-mask">Range Mask</option>' : ""}
      `
      : `
        <option value="adjusted">Adjusted</option>
        <option value="original">Original</option>
      `;
    elements.previewModeSelect.value = state.previewMode;
    if (elements.compareModeSelect) {
      elements.compareModeSelect.value = state.compareMode;
    }
    if (elements.analysisModeSelect) {
      elements.analysisModeSelect.value = state.analysisMode;
    }
    elements.starterPresetSelect.innerHTML = BUILT_IN_PRESETS
      .map((preset) => `<option value="${preset.name}">${preset.name}</option>`)
      .join("");

    if (elements.passSelect) {
      elements.passSelect.innerHTML = state.adjustments
        .map((adjustment) => {
          const suffix = adjustment.enabled ? "" : " (Off)";
          return `<option value="${adjustment.id}">${adjustment.label}${suffix}</option>`;
        })
        .join("");
      elements.passSelect.value = String(adjustment.id);
    }

    elements.selectedBandSelect.innerHTML = [
      `<option value="${NEUTRAL_BAND_ID}">${NEUTRAL_LABEL}</option>`,
      ...adjustment.bands.map((band) => `<option value="${band.id}">${band.label}</option>`),
    ]
      .join("");
    elements.selectedBandSelect.value = adjustment.selectedBandId;

    elements.polarModeSelect.value = state.polarMode;
    elements.affectedOnlyToggle.checked = state.affectedOnly;
    elements.autoPreviewToggle.checked = state.autoPreview;
    elements.fastPreviewToggle.checked = state.fastPreview;
    elements.bypassToggle.checked = state.bypass;
    elements.autoSelectProbeToggle.checked = state.autoSelectBandFromProbe;

    elements.rangeMaskPreset.innerHTML = Object.keys(RANGE_MASK_PRESETS)
      .map((name) => `<option value="${name}">${name}</option>`)
      .join("");
    elements.rangeMaskPreset.value = adjustment.rangeMask.preset;
  }

  function bindEvents() {
    elements.technicalAppendixButton.addEventListener("click", () => {
      window.open("docs/TECHNICAL_APPENDIX.html", "_blank", "noopener");
    });
    elements.faqButton?.addEventListener("click", () => {
      window.open("docs/FAQ.html", "_blank", "noopener");
    });
    elements.appModeSelect?.addEventListener("change", () => {
      const requestedMode = elements.appModeSelect.value;
      if (requestedMode === "advanced" && !state.hasSeenAdvancedModeIntro) {
        elements.appModeSelect.value = state.appMode;
        renderAdvancedModePrompt(true);
        return;
      }
      state.appMode = requestedMode;
      viewport.resetInteraction();
      syncAppModeUI();
      populateSelectors();
      syncToolTabs();
      syncActivePassCard();
      syncPreviewFile();
      syncViewportMode();
      updateAnalysis();
    });
    elements.advancedModeContinueBtn?.addEventListener("click", () => {
      state.hasSeenAdvancedModeIntro = true;
      state.appMode = "advanced";
      renderAdvancedModePrompt(false);
      viewport.resetInteraction();
      syncAppModeUI();
      populateSelectors();
      syncToolTabs();
      syncActivePassCard();
      syncPreviewFile();
      syncViewportMode();
      updateAnalysis();
    });
    elements.advancedModeCancelBtn?.addEventListener("click", () => {
      renderAdvancedModePrompt(false);
      state.appMode = "standard";
      viewport.resetInteraction();
      syncAppModeUI();
      populateSelectors();
      syncToolTabs();
      syncActivePassCard();
      syncPreviewFile();
      syncViewportMode();
      updateAnalysis();
    });
    elements.loadButton.addEventListener("click", () => elements.input.click());
    elements.saveButton.addEventListener("click", () => {
      void saveImageOutput();
    });
    elements.savePresetButton.addEventListener("click", savePresetToFile);
    elements.loadPresetButton.addEventListener("click", () => elements.presetInput.click());
    elements.applyStarterPresetButton.addEventListener("click", () => {
      applyBuiltInPresetByName(elements.starterPresetSelect.value);
    });
    elements.renderPreviewButton.addEventListener("click", () => renderPreview(true));
    elements.autoSelectProbeToggle.addEventListener("change", () => {
      state.autoSelectBandFromProbe = elements.autoSelectProbeToggle.checked;
      updateAnalysis();
    });

    elements.input.addEventListener("change", async (event) => {
      const [file] = event.target.files;
      event.target.value = "";
      if (!file) {
        return;
      }
      try {
        const loaded = await loadImageFile(file);
        state.loadedImageData = loaded.imageData;
        state.loadedImageModel = loaded.model || null;
        state.loadedFullRgb = loaded.model?.rgbFloat || imageDataToFloat32Rgb(loaded.imageData);
        state.loadedImageName = loaded.model?.originalFileName || loaded.name;
        state.loadedWidth = loaded.model?.width || loaded.width;
        state.loadedHeight = loaded.model?.height || loaded.height;
        state.probe = null;
        elements.exportFormatSelect.value = state.loadedImageModel?.sourceFormat === "tiff" ? "tiff" : "png";
        syncPreviewFile();
        rebuildPreviewSource();
        viewport.fit();
        renderPreview(true);
      } catch (error) {
        viewport.log(`error: ${error.message}`);
        window.alert(error.message);
      }
    });

    elements.presetInput.addEventListener("change", async (event) => {
      const [file] = event.target.files;
      event.target.value = "";
      if (!file) {
        return;
      }
      try {
        const text = await file.text();
        const preset = importPresetFromJson(text);
        applyPreset(preset);
        viewport.log(`Loaded preset ${file.name}.`);
      } catch (error) {
        viewport.log(`Preset load failed: ${error.message}`);
      }
    });

    elements.imageTypeSelect.addEventListener("change", () => {
      state.imageType = elements.imageTypeSelect.value;
      renderPreview(true);
    });

    elements.sensitivitySelect.addEventListener("change", () => {
      state.sensitivity = elements.sensitivitySelect.value;
      clampBandsToSensitivity();
      renderSliderPanel();
      renderPreview(true);
    });

    elements.previewModeSelect.addEventListener("change", () => {
      state.previewMode = elements.previewModeSelect.value;
      syncViewportMode();
    });

    elements.compareModeSelect?.addEventListener("change", () => {
      state.compareMode = elements.compareModeSelect.value;
      syncActivePassCard();
      updateCanvasHint();
      syncViewportMode();
      updateAnalysis();
    });

    elements.analysisModeSelect.addEventListener("change", () => {
      state.analysisMode = elements.analysisModeSelect.value;
      state.analysisOpen = state.analysisMode !== "collapsed";
      syncAnalysisPanel();
      updateAnalysis();
    });

    [elements.panelModeDiagnosticsBtn, elements.panelModePassesBtn, elements.panelModeSplitBtn].forEach((button) => {
      button?.addEventListener("click", () => {
        state.panelContentMode = button.dataset.panelMode;
        viewport.resetInteraction();
        syncAnalysisPanel();
        syncViewportMode();
        updateAnalysis();
      });
      button?.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });

    elements.bypassToggle.addEventListener("change", () => {
      state.bypass = elements.bypassToggle.checked;
      syncViewportMode();
    });

    elements.autoPreviewToggle.addEventListener("change", () => {
      state.autoPreview = elements.autoPreviewToggle.checked;
      elements.renderPreviewButton.classList.toggle("is-highlighted", !state.autoPreview);
    });

    elements.fastPreviewToggle.addEventListener("change", () => {
      state.fastPreview = elements.fastPreviewToggle.checked;
      if (state.loadedImageData) {
        rebuildPreviewSource();
        renderPreview(true);
      }
    });

    elements.analysisPanel.addEventListener("toggle", () => {
      state.analysisOpen = elements.analysisPanel.open;
      state.analysisMode = state.analysisOpen ? (state.analysisMode === "collapsed" ? "compact" : state.analysisMode) : "collapsed";
      elements.analysisModeSelect.value = state.analysisMode;
      updateAnalysis();
    });

    elements.polarModeSelect.addEventListener("change", () => {
      state.polarMode = elements.polarModeSelect.value;
      updateAnalysis();
    });

    elements.affectedOnlyToggle.addEventListener("change", () => {
      state.affectedOnly = elements.affectedOnlyToggle.checked;
      updateAnalysis();
    });

    elements.fitButton.addEventListener("click", () => {
      viewport.fit();
      viewport.log("manual fit");
    });
    elements.zoom1xButton.addEventListener("click", () => {
      viewport.setZoomPreset(1);
      viewport.log("manual 1x");
    });
    elements.zoom2xButton.addEventListener("click", () => {
      viewport.setZoomPreset(2);
      viewport.log("manual 2x");
    });
    elements.zoomSlider.addEventListener("input", () => {
      const nextZoom = Number(elements.zoomSlider.value);
      viewport.setZoomFromUi(nextZoom);
      viewport.log(`manual slider ${nextZoom.toFixed(2)}x`);
    });

    elements.tabButtons.forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedTab = button.dataset.tab;
        syncTabButtons();
        renderSliderPanel();
      });
    });

    elements.toolTabButtons.forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedToolTab = button.dataset.toolTab;
        syncToolTabs();
      });
    });

    elements.addAdjustmentBtn.addEventListener("click", () => {
      viewport.resetInteraction();
      const passNumber = getNextPassNumber();
      const adjustment = createNeutralPass(`Pass ${passNumber}`);
      state.adjustments.push(adjustment);
      state.selectedAdjustmentId = adjustment.id;
      populateSelectors();
      renderAdjustmentStack();
      renderPassManager();
      renderStarterPresetsState();
      syncActivePassCard();
      renderSliderPanel();
      syncSelectedBandControls();
      syncRangeMaskControls();
      updateHueWheel();
      window.requestAnimationFrame(() => renderPreview(true));
    });

    elements.passManagerNewBtn?.addEventListener("click", () => {
      elements.addAdjustmentBtn.click();
    });

    elements.passManagerDuplicateBtn?.addEventListener("click", () => {
      elements.duplicateAdjustmentBtn.click();
    });

    elements.passManagerDeleteBtn?.addEventListener("click", () => {
      elements.deleteAdjustmentBtn.click();
    });

    elements.rangeMaskKeepCurrentBtn.addEventListener("click", () => {
      applyPendingRangeMaskToCurrentPass();
    });

    elements.rangeMaskNewPassBtn.addEventListener("click", () => {
      createRangeMaskRefinementPass();
    });

    elements.rangeMaskCancelBtn.addEventListener("click", () => {
      state.pendingRangeMaskState = null;
      renderRangeMaskPassPrompt(false);
      syncRangeMaskControls();
    });

    if (elements.rangeMaskPassModal) {
      elements.rangeMaskPassModal.addEventListener("click", (event) => {
        if (event.target === elements.rangeMaskPassModal) {
          event.preventDefault();
        }
      });
    }

    if (elements.presetPassModal) {
      elements.presetPassModal.addEventListener("click", (event) => {
        if (event.target === elements.presetPassModal) {
          event.preventDefault();
        }
      });
    }

    elements.duplicateAdjustmentBtn.addEventListener("click", () => {
      viewport.resetInteraction();
      const source = getSelectedAdjustment();
      const nextId = state.nextAdjustmentId++;
      const duplicate = cloneAdjustment(source, nextId, `Copy of ${source.label}`);
      state.adjustments.push(duplicate);
      state.selectedAdjustmentId = duplicate.id;
      populateSelectors();
      renderAdjustmentStack();
      renderPassManager();
      renderStarterPresetsState();
      syncActivePassCard();
      renderSliderPanel();
      syncSelectedBandControls();
      syncRangeMaskControls();
      updateHueWheel();
      window.requestAnimationFrame(() => renderPreview(true));
    });

    elements.deleteAdjustmentBtn.addEventListener("click", () => {
      const selected = getSelectedAdjustment();
      if (isBasePass(selected)) {
        window.alert("Base Pass cannot be deleted.");
        return;
      }
      if (!window.confirm(`Delete ${selected.label}?`)) {
        return;
      }
      const selectedIndex = state.adjustments.findIndex((adjustment) => adjustment.id === state.selectedAdjustmentId);
      state.adjustments.splice(selectedIndex, 1);
      selectAdjustmentById(state.adjustments[Math.max(0, selectedIndex - 1)].id);
    });

    elements.passSelect.addEventListener("change", () => {
      selectAdjustmentById(elements.passSelect.value);
    });

    elements.selectedBandSelect.addEventListener("change", () => {
      getSelectedAdjustment().selectedBandId = elements.selectedBandSelect.value;
      renderAdjustmentStack();
      renderSliderPanel();
      syncSelectedBandControls();
      updateHueWheel();
      renderPreview(true);
    });

    elements.soloBandToggleButton.addEventListener("click", () => {
      const adjustment = getSelectedAdjustment();
      adjustment.soloBand = !adjustment.soloBand;
      syncSelectedBandControls();
      renderPreview(true);
    });

    elements.widthSlider.addEventListener("input", () => {
      if (isNeutralSelected()) {
        return;
      }
      state.sliderInteractionDepth = 1;
      getSelectedBand().width = Number(elements.widthSlider.value);
      syncSelectedBandControls();
      updateHueWheel();
      renderPreview();
    });
    commitRange(elements.widthSlider);

    elements.featherSlider.addEventListener("input", () => {
      if (isNeutralSelected()) {
        return;
      }
      state.sliderInteractionDepth = 1;
      getSelectedBand().feather = Number(elements.featherSlider.value);
      syncSelectedBandControls();
      updateHueWheel();
      renderPreview();
    });
    commitRange(elements.featherSlider);

    const resetSelectedBand = () => {
      if (isNeutralSelected()) {
        getSelectedAdjustment().neutralLuminance = createDefaultNeutralLuminance();
        renderSliderPanel();
        syncSelectedBandControls();
        updateHueWheel();
        renderPreview(true);
        return;
      }
      const defaults = createBandDefaults();
      const adjustment = getSelectedAdjustment();
      const selectedDefault = defaults.find((band) => band.id === adjustment.selectedBandId);
      const index = adjustment.bands.findIndex((band) => band.id === adjustment.selectedBandId);
      adjustment.bands[index] = selectedDefault;
      renderSliderPanel();
      syncSelectedBandControls();
      updateHueWheel();
      renderPreview(true);
    };
    elements.resetSelectedBtn.addEventListener("click", resetSelectedBand);
    elements.resetSelectedMiniBtn.addEventListener("click", resetSelectedBand);

    elements.resetAllBtn.addEventListener("click", () => {
      if (!window.confirm(`Reset all controls in ${getSelectedAdjustment().label}?`)) {
        return;
      }
      const selected = getSelectedAdjustment();
      const selectedIndex = state.adjustments.findIndex((adjustment) => adjustment.id === selected.id);
      state.adjustments[selectedIndex] = isBasePass(selected)
        ? createBasePass(selected.id)
        : createAdjustment(selected.id, selected.label);
      populateSelectors();
      renderAdjustmentStack();
      renderSliderPanel();
      syncSelectedBandControls();
      syncRangeMaskControls();
      updateHueWheel();
      renderPreview(true);
    });

    elements.rangeMaskEnabled.addEventListener("change", () => {
      const adjustment = getSelectedAdjustment();
      const nextRangeMask = {
        ...adjustment.rangeMask,
        enabled: elements.rangeMaskEnabled.checked,
      };
      if (!nextRangeMask.enabled && nextRangeMask.preset !== "All") {
        nextRangeMask.preset = "All";
      }
      if (maybeForkRangeMask(nextRangeMask)) {
        populateSelectors();
        syncRangeMaskControls();
        return;
      }
      populateSelectors();
      syncRangeMaskControls();
      renderAdjustmentStack();
      updateAnalysis();
      if (state.previewMode === "range-mask") {
        syncViewportMode();
      }
    });

    elements.rangeMaskPreset.addEventListener("change", () => {
      applyRangeMaskPreset(elements.rangeMaskPreset.value);
    });

    elements.presetReplaceCurrentBtn.addEventListener("click", () => {
      if (!state.pendingPreset) {
        return;
      }
      const { preset, adjustmentId } = state.pendingPreset;
      state.pendingPreset = null;
      renderPresetPassPrompt(false);
      applyPreset(preset, adjustmentId);
      viewport.log(`Applied starter preset ${preset._displayName || "preset"}.`);
    });

    elements.presetApplyNewPassBtn.addEventListener("click", () => {
      if (!state.pendingPreset) {
        return;
      }
      const { preset } = state.pendingPreset;
      const passNumber = getNextPassNumber();
      const newPass = createNeutralPass(`Pass ${passNumber}`);
      state.adjustments.push(newPass);
      state.selectedAdjustmentId = newPass.id;
      state.pendingPreset = null;
      renderPresetPassPrompt(false);
      applyPreset(preset, newPass.id);
      renderPassManager();
      viewport.log(`Applied starter preset ${preset._displayName || "preset"} to new pass.`);
    });

    elements.presetCancelBtn.addEventListener("click", () => {
      state.pendingPreset = null;
      renderPresetPassPrompt(false);
    });

    elements.rangeMaskLow.addEventListener("input", () => {
      state.sliderInteractionDepth = 1;
      const adjustment = getSelectedAdjustment();
      const nextRangeMask = {
        ...adjustment.rangeMask,
        enabled: true,
        low: Math.min(Number(elements.rangeMaskLow.value), adjustment.rangeMask.high),
        preset: "Custom",
      };
      adjustment.rangeMask = nextRangeMask;
      syncRangeMaskReadoutsOnly();
      updateHistogram();
      if (state.previewMode === "range-mask") {
        syncViewportMode();
      }
      renderPreview();
    });
    elements.rangeMaskHigh.addEventListener("input", () => {
      state.sliderInteractionDepth = 1;
      const adjustment = getSelectedAdjustment();
      const nextRangeMask = {
        ...adjustment.rangeMask,
        enabled: true,
        high: Math.max(Number(elements.rangeMaskHigh.value), adjustment.rangeMask.low),
        preset: "Custom",
      };
      adjustment.rangeMask = nextRangeMask;
      syncRangeMaskReadoutsOnly();
      updateHistogram();
      if (state.previewMode === "range-mask") {
        syncViewportMode();
      }
      renderPreview();
    });
    elements.rangeMaskFeather.addEventListener("input", () => {
      state.sliderInteractionDepth = 1;
      const adjustment = getSelectedAdjustment();
      const nextRangeMask = {
        ...adjustment.rangeMask,
        enabled: true,
        feather: Number(elements.rangeMaskFeather.value),
        preset: "Custom",
      };
      adjustment.rangeMask = nextRangeMask;
      syncRangeMaskReadoutsOnly();
      updateHistogram();
      if (state.previewMode === "range-mask") {
        syncViewportMode();
      }
      renderPreview();
    });
    commitRange(elements.rangeMaskLow);
    commitRange(elements.rangeMaskHigh);
    commitRange(elements.rangeMaskFeather);

    const resetRangeMask = () => {
      getSelectedAdjustment().rangeMask = createDefaultRangeMask();
      syncRangeMaskControls();
      renderAdjustmentStack();
      updateAnalysis();
      if (state.previewMode === "range-mask") {
        syncViewportMode();
      }
    };
    elements.resetRangeMaskBtn.addEventListener("click", resetRangeMask);
    elements.resetRangeMaskMiniBtn.addEventListener("click", resetRangeMask);
  }

  function handlePreviewProbeAtScreenPoint(screenX, screenY) {
    if (!state.previewRgb || !viewport.displaySource) {
      return;
    }
    const imagePoint = viewport.screenToImage(screenX, screenY);
    const x = Math.round(imagePoint.x);
    const y = Math.round(imagePoint.y);
    if (x < 0 || y < 0 || x >= state.previewWidth || y >= state.previewHeight) {
      return;
    }
    state.probe = sampleProbeAt(x, y);
    maybeAutoSelectBandFromProbe(state.probe);
    viewport.setProbe(state.probe);
    updateAnalysis();
    viewport.log(`probe ${x},${y} Yb=${state.probe.before.y.toFixed(3)} Ya=${state.probe.after.y.toFixed(3)}`);
  }

  function commitRange(element) {
    ["change", "pointerup", "mouseup", "touchend"].forEach((eventName) => {
      element.addEventListener(eventName, () => {
        state.sliderInteractionDepth = 0;
        renderAdjustmentStack();
        renderPreview(true);
      });
    });
  }

  function schedulePassViewerRefresh() {
    if (state.passUiFrameId) {
      return;
    }
    state.passUiFrameId = window.requestAnimationFrame(() => {
      state.passUiFrameId = 0;
      renderPassManager();
      syncActivePassCard();
    });
  }

  function rebuildPreviewSource() {
    if (!state.loadedImageData) {
      return;
    }
    if (state.fastPreview) {
      const preview = createDownsampledPreviewImageData(state.loadedImageData, FAST_PREVIEW_MAX_EDGE);
      state.previewSource = preview.imageData;
    } else {
      state.previewSource = state.loadedImageData;
    }
    state.previewRgb = imageDataToFloat32Rgb(state.previewSource);
    state.previewWidth = state.previewSource.width;
    state.previewHeight = state.previewSource.height;
    viewport.setSources({
      originalSource: imageDataToCanvas(state.previewSource),
      displaySource: imageDataToCanvas(state.previewSource),
      labelText: "Adjusted View — click to probe · hold to compare before this pass",
      allowOriginalHold: true,
    });
    viewport.setProbe(state.probe);
  }

  function syncPreviewFile() {
    if (!elements.previewFile) {
      return;
    }
    if (!state.loadedImageName) {
      elements.previewFile.textContent = "No image loaded.";
      elements.previewFile.title = "";
      if (elements.previewWarning) {
        elements.previewWarning.textContent = "";
        elements.previewWarning.title = "";
      }
      return;
    }
    const model = state.loadedImageModel;
    const formatText = model
      ? `${model.sourceBitDepth}-bit ${String(model.sourceFormat || "unknown").toUpperCase()}`
      : "8-bit UNKNOWN";
    const compressionText = model?.sourceFormat === "tiff" && model?.compression
      ? `/${model.compression}`
      : "";
    const dimensionText = state.loadedWidth && state.loadedHeight
      ? ` · ${state.loadedWidth}×${state.loadedHeight}`
      : "";
    elements.previewFile.textContent = `${state.loadedImageName} · ${formatText}${compressionText}${dimensionText}`;
    elements.previewFile.title = elements.previewFile.textContent;
    if (elements.previewWarning) {
      const warningText = model?.warnings?.length ? "Metadata not preserved" : "";
      elements.previewWarning.textContent = warningText;
      elements.previewWarning.title = model?.warnings?.length ? model.warnings[0] : "";
    }
  }

  function renderPreview(immediate = false) {
    if (!state.previewRgb) {
      return;
    }
    const deferAnalysis = !immediate && state.adjustments.length >= 3 && state.sliderInteractionDepth > 0;
    window.clearTimeout(state.processTimerId);
    if (state.processFrameId) {
      window.cancelAnimationFrame(state.processFrameId);
      state.processFrameId = 0;
    }
    if (!state.autoPreview && !immediate) {
      viewport.log("Preview pending. Click Render Preview.");
      return;
    }
    if (immediate) {
      state.processRequestId += 1;
      processPreview(false);
      return;
    }
    const debounceMs = state.adjustments.length >= 3
      ? 110
      : (state.adjustments.length > 1 ? 80 : PROCESS_DEBOUNCE_MS);
    const requestId = ++state.processRequestId;
    state.processTimerId = window.setTimeout(() => {
      state.processFrameId = window.requestAnimationFrame(() => {
        state.processFrameId = 0;
        if (requestId !== state.processRequestId) {
          return;
        }
        processPreview(deferAnalysis);
      });
    }, debounceMs);
  }

  function shouldUsePassAwareCompare() {
    if (!isAdvancedMode() || state.previewMode === "original" || state.bypass) {
      return false;
    }
    if (state.compareMode === "original") {
      return false;
    }
    return hasMeaningfulEdits(getSelectedAdjustment());
  }

  function applyAdjustmentStackToRgb(sourceRgb, width, height) {
    const adjustments = state.adjustments.filter((adjustment) => adjustment.enabled);
    let workingRgb = Float32Array.from(sourceRgb);
    let selectedResult = null;
    let beforeSelectedRgb = Float32Array.from(sourceRgb);
    let afterSelectedRgb = Float32Array.from(sourceRgb);
    const selectedPassId = state.selectedAdjustmentId;

    adjustments.forEach((adjustment) => {
      if (adjustment.id === selectedPassId) {
        beforeSelectedRgb = Float32Array.from(workingRgb);
      }
      const processingBands = adjustment.soloBand && adjustment.selectedBandId !== NEUTRAL_BAND_ID
        ? adjustment.bands.filter((band) => band.id === adjustment.selectedBandId)
        : adjustment.bands.slice();
      const neutralState = Math.abs(adjustment.neutralLuminance.luminance) <= 0.0001
        ? adjustment.neutralLuminance
        : (adjustment.soloBand && adjustment.selectedBandId !== NEUTRAL_BAND_ID
          ? { ...adjustment.neutralLuminance, luminance: 0 }
          : adjustment.neutralLuminance);

      const result = applyAllBands(
        workingRgb,
        width,
        height,
        processingBands,
        {
          imageType: state.imageType,
          globalStrength: state.globalStrength,
          selectedBandId: adjustment.selectedBandId,
          rangeMaskState: adjustment.rangeMask,
          neutralLuminanceState: neutralState,
        }
      );

      workingRgb = result.rgb;
      if (adjustment.id === state.selectedAdjustmentId) {
        selectedResult = result;
        afterSelectedRgb = Float32Array.from(result.rgb);
      }
    });

    const count = width * height;
    return {
      rgb: workingRgb,
      beforeSelectedRgb,
      afterSelectedRgb,
      selectedResult: selectedResult || {
        rgb: workingRgb,
        selectedMasks: { finalMask: new Float32Array(count) },
        combinedMask: new Float32Array(count),
      },
    };
  }

  function processPreview(deferAnalysis = false) {
    state.lastProcessAt = performance.now();
    const stacked = applyAdjustmentStackToRgb(state.previewRgb, state.previewWidth, state.previewHeight);
    const result = stacked.selectedResult;

    state.currentResult = {
      ...result,
      width: state.previewWidth,
      height: state.previewHeight,
      rgb: stacked.rgb,
      beforeSelectedRgb: stacked.beforeSelectedRgb,
      afterSelectedRgb: stacked.afterSelectedRgb,
      adjustedImageData: float32RgbToImageData(stacked.rgb, state.previewWidth, state.previewHeight),
    };

    refreshProbe();

    syncViewportMode();
    if (deferAnalysis) {
      updateActiveSummary();
      updateAnalysisSummaryLine();
      updateCanvasHint();
      return;
    }
    updateAnalysis();
  }

  function syncViewportMode() {
    if (!state.previewSource) {
      return;
    }

    const originalCanvas = imageDataToCanvas(state.previewSource);
    let displayImageData = state.previewSource;
    const passAwareCompare = shouldUsePassAwareCompare();
    const compareNoun = passAwareCompare ? "before this pass" : "original";
    const holdLabelText = passAwareCompare
      ? "Before Active Pass — release to return to final"
      : "Original View — release to return to final";
    let labelText = `Adjusted View — click to probe · hold to compare ${compareNoun}`;
    let allowOriginalHold = true;

    if (state.previewMode === "original") {
      displayImageData = state.previewSource;
      labelText = "Original View";
      allowOriginalHold = false;
    } else if (state.previewMode === "current-mask") {
      displayImageData = maskToImageData(
        state.currentResult?.selectedMasks?.finalMask,
        state.previewWidth,
        state.previewHeight
      );
      labelText = `Current Mask — click to probe · hold to compare ${compareNoun}`;
    } else if (state.previewMode === "combined-mask") {
      displayImageData = maskToImageData(
        state.currentResult?.combinedMask,
        state.previewWidth,
        state.previewHeight
      );
      labelText = `Combined Mask — click to probe · hold to compare ${compareNoun}`;
    } else if (state.previewMode === "range-mask") {
      displayImageData = buildRangeMaskPreviewImageData();
      labelText = getSelectedAdjustment().rangeMask.enabled
        ? `Range Mask View — click to probe · hold to compare ${compareNoun}`
        : "Range Mask View — Range Mask Off";
    } else if (state.currentResult?.adjustedImageData) {
      displayImageData = state.currentResult.adjustedImageData;
    }

    if (state.bypass && state.previewMode === "adjusted") {
      displayImageData = state.previewSource;
      labelText = "Bypass View — click to probe · hold to compare original";
    }

    const compareSource = passAwareCompare && state.currentResult?.beforeSelectedRgb
      ? float32RgbToImageData(state.currentResult.beforeSelectedRgb, state.previewWidth, state.previewHeight)
      : state.previewSource;

    viewport.setSources({
      originalSource: imageDataToCanvas(compareSource),
      displaySource: imageDataToCanvas(displayImageData),
      labelText,
      holdLabelText,
      allowOriginalHold,
    });
    viewport.render("mode-sync");
  }

  function buildRangeMaskPreviewImageData() {
    if (!state.previewRgb) {
      return state.previewSource;
    }

    const count = state.previewWidth * state.previewHeight;
    const mask = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const base = index * 3;
      const y = luma709(
        state.previewRgb[base],
        state.previewRgb[base + 1],
        state.previewRgb[base + 2]
      );
      mask[index] = computeRangeMask(y, getSelectedAdjustment().rangeMask);
    }
    return maskToImageData(mask, state.previewWidth, state.previewHeight);
  }

  function syncAnalysisPanel() {
    elements.analysisPanel.open = state.analysisOpen;
    elements.analysisPanel.dataset.mode = state.analysisMode;
    elements.analysisModeSelect.value = state.analysisMode;
    elements.analysisPanel.dataset.panelMode = state.panelContentMode;
    syncAnalysisContentMode();
  }

  function syncAnalysisContentMode() {
    const isCollapsed = state.analysisMode === "collapsed" || !state.analysisOpen;
    const mode = isAdvancedMode() ? state.panelContentMode : "diagnostics";
    const showDiagnostics = !isCollapsed && (mode === "diagnostics" || mode === "split");
    const showPasses = !isCollapsed && isAdvancedMode() && (mode === "passes" || mode === "split");
    elements.analysisPanel.dataset.panelMode = mode;

    if (elements.canvas) {
      elements.canvas.style.pointerEvents = "auto";
    }
    if (elements.wrap) {
      elements.wrap.style.pointerEvents = "auto";
    }

    if (elements.histogramCard) {
      elements.histogramCard.classList.toggle("is-hidden", !showDiagnostics);
    }
    if (elements.polarCard) {
      elements.polarCard.classList.toggle("is-hidden", !showDiagnostics);
    }
    if (elements.passManagerCard) {
      elements.passManagerCard.classList.toggle("is-hidden", !showPasses);
    }

    if (elements.analysisBody && elements.passManagerCard && elements.histogramCard && elements.polarCard) {
      const bodyStyle = elements.analysisBody.style;
      const passesStyle = elements.passManagerCard.style;
      const histogramStyle = elements.histogramCard.style;
      const polarStyle = elements.polarCard.style;
      const polarLayoutStyle = elements.polarLayout?.style;
      const polarSideStyle = elements.polarSide?.style;

      bodyStyle.display = "grid";
      bodyStyle.gap = "0.5rem";
      bodyStyle.alignItems = "start";
      bodyStyle.alignContent = "start";
      bodyStyle.minHeight = "0";
      bodyStyle.height = "auto";
      bodyStyle.maxHeight = "none";

      [passesStyle, histogramStyle, polarStyle].forEach((style) => {
        style.minWidth = "0";
        style.minHeight = "0";
        style.height = "auto";
        style.maxHeight = "none";
        style.alignSelf = "start";
        style.overflow = "hidden";
      });

      if (polarLayoutStyle) {
        polarLayoutStyle.display = "flex";
        polarLayoutStyle.flexDirection = "row";
        polarLayoutStyle.justifyContent = "space-between";
        polarLayoutStyle.alignItems = "start";
        polarLayoutStyle.gap = "0.45rem";
      }

      if (polarSideStyle) {
        polarSideStyle.width = "180px";
        polarSideStyle.minWidth = "180px";
        polarSideStyle.maxWidth = "180px";
        polarSideStyle.flex = "0 0 180px";
      }

      if (isCollapsed) {
        bodyStyle.gridTemplateColumns = "1fr";
        passesStyle.display = "none";
        histogramStyle.display = "none";
        polarStyle.display = "none";
      } else if (!isAdvancedMode()) {
        bodyStyle.gridTemplateColumns = "minmax(0, 1.08fr) minmax(360px, 0.92fr)";
        passesStyle.display = "none";
        histogramStyle.display = "grid";
        polarStyle.display = "grid";
        histogramStyle.gridColumn = "1";
        polarStyle.gridColumn = "2";
        histogramStyle.height = state.analysisMode === "full" ? "228px" : "204px";
        polarStyle.height = state.analysisMode === "full" ? "228px" : "204px";
        if (elements.polarCanvas) {
          const size = state.analysisMode === "full" ? "210px" : "186px";
          elements.polarCanvas.style.width = size;
          elements.polarCanvas.style.height = size;
        }
      } else if (mode === "passes") {
        bodyStyle.gridTemplateColumns = "1fr";
        passesStyle.display = "grid";
        histogramStyle.display = "none";
        polarStyle.display = "none";
        passesStyle.gridColumn = "1";
      } else if (mode === "split") {
        bodyStyle.display = "flex";
        bodyStyle.flexDirection = "row";
        bodyStyle.alignItems = "stretch";
        bodyStyle.justifyContent = "stretch";
        bodyStyle.flexWrap = "nowrap";
        passesStyle.display = "grid";
        histogramStyle.display = "grid";
        polarStyle.display = "grid";
        passesStyle.order = "1";
        histogramStyle.order = "2";
        polarStyle.order = "3";
        passesStyle.flex = "0 0 27%";
        histogramStyle.flex = "0 0 33%";
        polarStyle.flex = "1 1 40%";
        const splitHeight = state.analysisMode === "full" ? "228px" : "204px";
        passesStyle.height = splitHeight;
        histogramStyle.height = splitHeight;
        polarStyle.height = splitHeight;
        if (elements.polarCanvas) {
          const size = state.analysisMode === "full" ? "220px" : "186px";
          elements.polarCanvas.style.width = size;
          elements.polarCanvas.style.height = size;
        }
      } else {
        bodyStyle.gridTemplateColumns = "minmax(0, 1.02fr) minmax(380px, 0.98fr)";
        passesStyle.display = "none";
        histogramStyle.display = "grid";
        polarStyle.display = "grid";
        histogramStyle.gridColumn = "1";
        polarStyle.gridColumn = "2";
        histogramStyle.height = state.analysisMode === "full" ? "228px" : "204px";
        polarStyle.height = state.analysisMode === "full" ? "228px" : "204px";
        if (elements.polarCanvas) {
          const size = state.analysisMode === "full" ? "210px" : "186px";
          elements.polarCanvas.style.width = size;
          elements.polarCanvas.style.height = size;
        }
      }
    }

    [elements.panelModeDiagnosticsBtn, elements.panelModePassesBtn, elements.panelModeSplitBtn].forEach((button) => {
      if (!button) {
        return;
      }
      button.classList.toggle("is-active", button.dataset.panelMode === mode);
      button.disabled = !isAdvancedMode() && button.dataset.panelMode !== "diagnostics";
    });
  }

  function updateAnalysis() {
    syncActivePassCard();
    syncAnalysisContentMode();
    updatePolarPlots();
    updateHistogram();
    updateActiveSummary();
    updateAnalysisSummaryLine();
    updateCanvasHint();
  }

  function getDisplayedAnalysisState() {
    const passAwareCompare = shouldUsePassAwareCompare();
    const compareActive = Boolean(viewport.showOriginalHold);

    if (compareActive) {
      if (passAwareCompare) {
        return {
          label: "Before Pass",
          rgb: state.currentResult?.beforeSelectedRgb || state.previewRgb,
          probePoint: state.probe?.before || null,
          context: "pass-before",
        };
      }
      return {
        label: "Original",
        rgb: state.previewRgb,
        probePoint: state.probe?.original || state.probe?.before || null,
        context: "original",
      };
    }

    if (passAwareCompare) {
      return {
        label: "After Pass",
        rgb: state.currentResult?.afterSelectedRgb || state.currentResult?.rgb || state.previewRgb,
        probePoint: state.probe?.after || state.probe?.final || null,
        context: "pass-after",
      };
    }

    return {
      label: state.previewMode === "original" ? "Original" : "Adjusted",
      rgb: state.previewMode === "original"
        ? state.previewRgb
        : (state.currentResult?.rgb || state.previewRgb),
      probePoint: state.previewMode === "original"
        ? (state.probe?.original || state.probe?.before || null)
        : (state.probe?.final || state.probe?.after || null),
      context: state.previewMode === "original" ? "original" : "adjusted",
    };
  }

  function updateCanvasHint() {
    if (!elements.canvasHint) {
      return;
    }
    elements.canvasHint.textContent = shouldUsePassAwareCompare()
      ? "Click to probe · Hold to compare before this pass"
      : "Click to probe · Hold to compare original";
  }

  function refreshProbe() {
    if (!state.probe || !state.previewRgb) {
      viewport.setProbe(state.probe);
      return;
    }
    const x = clamp(Math.round(state.probe.x), 0, state.previewWidth - 1);
    const y = clamp(Math.round(state.probe.y), 0, state.previewHeight - 1);
    state.probe = sampleProbeAt(x, y);
    viewport.setProbe(state.probe);
  }

  function sampleProbeAt(x, y) {
    const pixelIndex = y * state.previewWidth + x;
    const base = pixelIndex * 3;
    const originalRgb = state.previewRgb;
    const beforeRgb = state.currentResult?.beforeSelectedRgb || state.previewRgb;
    const afterRgb = state.currentResult?.afterSelectedRgb || state.previewRgb;
    const finalRgb = state.currentResult?.rgb || state.previewRgb;
    const originalR = originalRgb[base];
    const originalG = originalRgb[base + 1];
    const originalB = originalRgb[base + 2];
    const beforeR = beforeRgb[base];
    const beforeG = beforeRgb[base + 1];
    const beforeB = beforeRgb[base + 2];
    const afterR = afterRgb[base];
    const afterG = afterRgb[base + 1];
    const afterB = afterRgb[base + 2];
    const finalR = finalRgb[base];
    const finalG = finalRgb[base + 1];
    const finalB = finalRgb[base + 2];
    const [originalH, originalS] = rgbToHsl(originalR, originalG, originalB);
    const [beforeH, beforeS] = rgbToHsl(beforeR, beforeG, beforeB);
    const [afterH, afterS] = rgbToHsl(afterR, afterG, afterB);
    const [finalH, finalS] = rgbToHsl(finalR, finalG, finalB);
    const originalY = luma709(originalR, originalG, originalB);
    const beforeY = luma709(beforeR, beforeG, beforeB);
    const afterY = luma709(afterR, afterG, afterB);
    const finalY = luma709(finalR, finalG, finalB);
    const isReliable = afterS >= PROBE_MIN_SATURATION && afterY >= PROBE_MIN_LUMINANCE;
    const nearestBand = isReliable ? nearestBandForHue(afterH) : null;

    return {
      x,
      y,
      original: { r: originalR, g: originalG, b: originalB, h: originalH, s: originalS, y: originalY },
      before: { r: beforeR, g: beforeG, b: beforeB, h: beforeH, s: beforeS, y: beforeY },
      after: { r: afterR, g: afterG, b: afterB, h: afterH, s: afterS, y: afterY },
      final: { r: finalR, g: finalG, b: finalB, h: finalH, s: finalS, y: finalY },
      rangeMaskValue: computeRangeMask(beforeY, getSelectedAdjustment().rangeMask),
      reliableColor: isReliable,
      suggestedNeutral: afterS < PROBE_MIN_SATURATION,
      nearestBand,
    };
  }

  function maybeAutoSelectBandFromProbe(probe) {
    if (!probe) {
      return;
    }
    if (!state.autoSelectBandFromProbe) {
      return;
    }
    const adjustment = getSelectedAdjustment();
    if (probe.suggestedNeutral) {
      if (state.selectedTab === "luminance" && adjustment.selectedBandId !== NEUTRAL_BAND_ID) {
        adjustment.selectedBandId = NEUTRAL_BAND_ID;
        renderSliderPanel();
        syncSelectedBandControls();
        updateHueWheel();
        renderAdjustmentStack();
      }
      return;
    }
    if (!probe.reliableColor || !probe.nearestBand) {
      return;
    }
    if (adjustment.selectedBandId === probe.nearestBand.bandId) {
      return;
    }
    adjustment.selectedBandId = probe.nearestBand.bandId;
    renderSliderPanel();
    syncSelectedBandControls();
    updateHueWheel();
    renderAdjustmentStack();
  }

  function nearestBandForHue(hueDeg) {
    let bestBandId = null;
    let bestDistance = Infinity;
    BAND_DEFS.forEach((band) => {
      const distance = circularHueDistance(hueDeg, band.center);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestBandId = band.id;
      }
    });
    return { bandId: bestBandId, distance: bestDistance };
  }

  function circularHueDistance(a, b) {
    const d = Math.abs(a - b);
    return Math.min(d, 360 - d);
  }

  function updatePolarPlots() {
    if (!state.currentResult || !state.previewRgb) {
      elements.diagnosticStats.textContent = "No image loaded.";
      clearPolarPlots();
      return;
    }

    const count = state.currentResult.width * state.currentResult.height;
    const finalMask = state.currentResult.selectedMasks?.finalMask || new Float32Array(count);
    const combinedMask = state.currentResult.combinedMask || new Float32Array(count);
    let selectedAffected = 0;
    let combinedAffected = 0;

    for (let index = 0; index < count; index += 1) {
      if (finalMask[index] > 0.001) {
        selectedAffected += 1;
      }
      if (combinedMask[index] > 0.001) {
        combinedAffected += 1;
      }
    }

    const protectionLabel = state.imageType === "stars" ? "Stars Present" : "Starless / Star-Reduced";
    elements.diagnosticStats.textContent =
      `Preview ${state.currentResult.width} x ${state.currentResult.height}. ` +
      `Image type: ${protectionLabel}. ` +
      `Selected band coverage: ${selectedAffected.toLocaleString()} pixels. ` +
      `Combined coverage: ${combinedAffected.toLocaleString()} pixels.`;

    const displayState = getDisplayedAnalysisState();
    const points = samplePolarData(displayState.rgb);
    if (elements.polarStateLabel) {
      elements.polarStateLabel.textContent = displayState.label;
    }
    drawPolarCanvas(elements.polarCanvas, points, displayState.probePoint);
  }

  function clearPolarPlots() {
    if (!elements.polarCanvas) {
      return;
    }
    const ctx = elements.polarCanvas.getContext("2d");
    ctx.clearRect(0, 0, elements.polarCanvas.width, elements.polarCanvas.height);
  }

  function samplePolarData(sourceRgb) {
    const points = [];
    const count = state.currentResult.width * state.currentResult.height;
    const step = Math.max(1, Math.floor(count / POLAR_SAMPLE_LIMIT));
    const filterMask = state.polarMode === "selected"
      ? state.currentResult.selectedMasks?.finalMask
      : state.currentResult.combinedMask;

    for (let index = 0; index < count; index += step) {
      const maskValue = filterMask ? filterMask[index] : 0;
      if (state.affectedOnly && maskValue <= 0.001) {
        continue;
      }

      const base = index * 3;
      const r = sourceRgb[base];
      const g = sourceRgb[base + 1];
      const b = sourceRgb[base + 2];
      const [h, s] = rgbToHsl(r, g, b);
      points.push({ h, s, color: rgbCss(r, g, b), maskValue });
    }

    return points;
  }

  function drawPolarCanvas(canvas, points, probePoint) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.42;
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1].forEach((factor) => {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * factor, 0, Math.PI * 2);
      ctx.stroke();
    });

    for (let degree = 0; degree < 360; degree += 30) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(toRad(degree - 90)) * radius, cy + Math.sin(toRad(degree - 90)) * radius);
      ctx.stroke();
    }

    points.forEach((point) => {
      const angle = toRad(point.h - 90);
      const r = point.s * radius;
      const alpha = state.affectedOnly ? Math.max(0.24, point.maskValue) : 0.78;
      ctx.fillStyle = point.color.replace("rgb(", "rgba(").replace(")", `, ${alpha})`);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, 1.2, 0, Math.PI * 2);
      ctx.fill();
    });

    if (probePoint) {
      const angle = toRad(probePoint.h - 90);
      const r = probePoint.s * radius;
      const px = cx + Math.cos(angle) * r;
      const py = cy + Math.sin(angle) * r;
      ctx.strokeStyle = "rgba(255,235,168,0.98)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px - 8, py);
      ctx.lineTo(px + 8, py);
      ctx.moveTo(px, py - 8);
      ctx.lineTo(px, py + 8);
      ctx.stroke();
      ctx.fillStyle = "#fff2b2";
      ctx.beginPath();
      ctx.arc(px, py, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function updateHistogram() {
    if (!state.previewRgb) {
      elements.histogramStats.textContent = "No image loaded.";
      elements.probeReadout.textContent = "Probe: click image to inspect luminance and color position.";
      elements.analysisSummaryLine.textContent = "Probe: click image to inspect luminance and color position.";
      return;
    }

    const displayState = getDisplayedAnalysisState();
    if (elements.histogramStateLabel) {
      elements.histogramStateLabel.textContent = displayState.label;
    }
    drawHistogramCanvas(
      elements.histogramCanvas,
      displayState.rgb,
      displayState.probePoint?.y ?? null
    );

    const rangeMask = getSelectedAdjustment().rangeMask;
    const status = rangeMask.enabled ? "Range Mask On" : "Range Mask Off";
    elements.histogramStats.textContent =
      `${status} · Low ${rangeMask.low.toFixed(2)} · High ${rangeMask.high.toFixed(2)} · Feather ${rangeMask.feather.toFixed(2)}` +
      (state.probe
        ? ` · Probe (${state.probe.x},${state.probe.y}) Y original ${state.probe.original.y.toFixed(3)} · Y final ${state.probe.final.y.toFixed(3)} · In range ${state.probe.rangeMaskValue > 0.001 ? "yes" : "no"}`
        : "");

    const fullReadout = state.probe
      ? `Probe: x ${state.probe.x}, y ${state.probe.y} · L ${getDisplayedProbePoint().y.toFixed(2)} · ${getProbeHueReadout()} · Sat ${getDisplayedProbePoint().s.toFixed(2)} · RGB ${getDisplayedProbePoint().r.toFixed(2)}/${getDisplayedProbePoint().g.toFixed(2)}/${getDisplayedProbePoint().b.toFixed(2)} · ${getProbeBandReadout()}`
      : "Probe: click image to inspect luminance and color position.";
    const compactReadout = state.probe
      ? `Probe: L ${getDisplayedProbePoint().y.toFixed(2)} · ${getProbeHueReadout()} · Sat ${getDisplayedProbePoint().s.toFixed(2)} · Range: ${getProbeRangeLabel()}`
      : "Probe: click image to inspect luminance and color position.";
    elements.probeReadout.textContent = compactReadout;
  }

  function updateAnalysisSummaryLine() {
    if (!elements.analysisSummaryLine) {
      return;
    }
    elements.analysisSummaryLine.textContent = state.probe
      ? `Probe: L ${getDisplayedProbePoint().y.toFixed(2)} · ${getProbeHueReadout()} · Sat ${getDisplayedProbePoint().s.toFixed(2)} · Range: ${getProbeRangeLabel()}`
      : "Probe: click image to inspect luminance and color position.";
  }

  function getProbeRangeLabel() {
    if (!getSelectedAdjustment().rangeMask.enabled) {
      return "Range Mask Off";
    }
    return state.probe && state.probe.rangeMaskValue > 0.001 ? "Included" : "Excluded";
  }

  function getDisplayedProbePoint() {
    if (!state.probe) {
      return null;
    }
    const displayState = getDisplayedAnalysisState();
    return displayState.probePoint || state.probe.final || state.probe.after || state.probe.original || state.probe.before;
  }

  function getProbeHueReadout() {
    const point = getDisplayedProbePoint();
    if (!state.probe || !point || state.probe.suggestedNeutral || !state.probe.reliableColor) {
      return "Hue unreliable";
    }
    return `Hue ${Math.round(point.h)}°`;
  }

  function getProbeBandReadout() {
    if (!state.probe) {
      return "Band: none";
    }
    if (state.probe.suggestedNeutral) {
      if (state.autoSelectBandFromProbe && state.selectedTab === "luminance") {
        return `Suggested: ${NEUTRAL_LABEL} · Range: ${getProbeRangeLabel()}`;
      }
      return `Suggested: ${NEUTRAL_LABEL} · Range: ${getProbeRangeLabel()}`;
    }
    if (!state.probe.reliableColor || !state.probe.nearestBand) {
      return "Band: not selected — low color reliability";
    }
    const nearest = getBandById(state.probe.nearestBand.bandId);
    if (state.autoSelectBandFromProbe) {
      return `Band: ${nearest.label} · Range: ${getProbeRangeLabel()}`;
    }
    return `Suggested Band: ${nearest.label} · Range: ${getProbeRangeLabel()}`;
  }

  function drawHistogramCanvas(canvas, sourceRgb, probeY) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const bins = new Array(HISTOGRAM_BINS).fill(0);
    let maxBin = 0;
    for (let index = 0; index < sourceRgb.length; index += 3) {
      const y = luma709(sourceRgb[index], sourceRgb[index + 1], sourceRgb[index + 2]);
      const binIndex = Math.min(HISTOGRAM_BINS - 1, Math.floor(y * (HISTOGRAM_BINS - 1)));
      bins[binIndex] += 1;
      if (bins[binIndex] > maxBin) {
        maxBin = bins[binIndex];
      }
    }

    const w = canvas.width;
    const h = canvas.height;
    const pad = { left: 24, right: 12, top: 12, bottom: 34 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    ctx.fillStyle = "rgba(12, 15, 19, 0.9)";
    ctx.fillRect(0, 0, w, h);

    const rangeMask = getSelectedAdjustment().rangeMask;
    const lowX = pad.left + rangeMask.low * plotW;
    const highX = pad.left + rangeMask.high * plotW;
    const featherPx = rangeMask.feather * plotW;
    const leftFeatherX = Math.max(pad.left, lowX - featherPx);
    const rightFeatherX = Math.min(pad.left + plotW, highX + featherPx);

    ctx.fillStyle = rangeMask.enabled ? "rgba(214,162,27,0.12)" : "rgba(214,162,27,0.06)";
    ctx.fillRect(leftFeatherX, pad.top, rightFeatherX - leftFeatherX, plotH);
    ctx.fillStyle = rangeMask.enabled ? "rgba(240,161,42,0.26)" : "rgba(240,161,42,0.14)";
    ctx.fillRect(lowX, pad.top, Math.max(1, highX - lowX), plotH);

    bins.forEach((count, index) => {
      const normalized = maxBin ? count / maxBin : 0;
      const x = pad.left + (index / HISTOGRAM_BINS) * plotW;
      const barWidth = plotW / HISTOGRAM_BINS;
      const barHeight = normalized * plotH;
      ctx.fillStyle = "rgba(126, 145, 173, 0.72)";
      ctx.fillRect(x, pad.top + plotH - barHeight, Math.max(1, barWidth), barHeight);
    });

    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);

    ctx.strokeStyle = "#f0a12a";
    ctx.lineWidth = 2;
    [lowX, highX].forEach((x) => {
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + plotH);
      ctx.stroke();
    });

    if (probeY !== null && Number.isFinite(probeY)) {
      const probeX = pad.left + clamp01(probeY) * plotW;
      ctx.strokeStyle = "rgba(255,235,168,0.98)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(probeX, pad.top);
      ctx.lineTo(probeX, pad.top + plotH);
      ctx.stroke();
      ctx.fillStyle = "#fff2b2";
      ctx.beginPath();
      ctx.arc(probeX, pad.top + plotH + 3.5, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    const gradientY = h - 15;
    const gradient = ctx.createLinearGradient(pad.left, 0, pad.left + plotW, 0);
    gradient.addColorStop(0, "#000000");
    gradient.addColorStop(0.5, "#7f7f7f");
    gradient.addColorStop(1, "#ffffff");
    ctx.fillStyle = gradient;
    ctx.fillRect(pad.left, gradientY, plotW, 7);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.strokeRect(pad.left, gradientY, plotW, 7);

    ctx.fillStyle = "rgba(255,255,255,0.72)";
    ctx.font = "11px Avenir Next, sans-serif";
    ctx.textBaseline = "bottom";
    ctx.fillText("0.0", pad.left, gradientY - 2);
    ctx.textAlign = "center";
    ctx.fillText("Gray Level", pad.left + plotW / 2, gradientY - 2);
    ctx.textAlign = "right";
    ctx.fillText("1.0", pad.left + plotW, gradientY - 2);
    ctx.textAlign = "start";
  }

  async function saveImageOutput() {
    if (!state.loadedImageData || !state.loadedFullRgb) {
      viewport.log("Load an image before saving.");
      return;
    }
    if (state.isSaving) {
      viewport.log("Save already in progress.");
      return;
    }

    const format = elements.exportFormatSelect.value;

    state.isSaving = true;
    const previousLabel = elements.saveButton.textContent;
    elements.saveButton.disabled = true;
    elements.saveButton.textContent = format === "tiff" ? "Rendering TIFF..." : "Rendering PNG...";
    viewport.log(`Preparing full-resolution ${String(format).toUpperCase()} ${state.loadedWidth}x${state.loadedHeight}...`);

    await new Promise((resolve) => window.setTimeout(resolve, 30));

    try {
      const name = state.loadedImageName.replace(/\.[^.]+$/, "") || "astro-color-mixer-output";
      let imageData;
      let rgbFloat;
      let outputName;
      let tiffChannels = 3;

      if (state.previewMode === "current-mask" || state.previewMode === "combined-mask") {
        const result = applyAdjustmentStackToRgb(
          state.loadedFullRgb,
          state.loadedWidth,
          state.loadedHeight
        ).selectedResult;
        const mask = state.previewMode === "current-mask"
          ? result.selectedMasks?.finalMask
          : result.combinedMask;
        imageData = maskToImageData(mask, state.loadedWidth, state.loadedHeight);
        rgbFloat = maskToFloat32Rgb(mask, state.loadedWidth, state.loadedHeight);
        outputName = format === "tiff"
          ? `${name}-${state.previewMode}.tif`
          : `${name}-${state.previewMode}.png`;
        elements.saveButton.textContent = format === "tiff" ? "Saving Mask TIFF..." : "Saving Mask PNG...";
      } else if (state.previewMode === "range-mask") {
        const rangeMask = buildFullResolutionRangeMask();
        imageData = maskToImageData(rangeMask, state.loadedWidth, state.loadedHeight);
        rgbFloat = maskToFloat32Rgb(rangeMask, state.loadedWidth, state.loadedHeight);
        outputName = format === "tiff"
          ? `${name}-range-mask.tif`
          : `${name}-range-mask.png`;
        elements.saveButton.textContent = format === "tiff" ? "Saving Range Mask TIFF..." : "Saving Range Mask PNG...";
      } else {
        const result = applyAdjustmentStackToRgb(
          state.loadedFullRgb,
          state.loadedWidth,
          state.loadedHeight
        );
        rgbFloat = result.rgb;
        imageData = float32RgbToImageData(result.rgb, state.loadedWidth, state.loadedHeight);
        outputName = format === "tiff"
          ? `${name}_ACM.tif`
          : `${name}-astro-color-mixer.png`;
        elements.saveButton.textContent = format === "tiff" ? "Saving TIFF..." : "Saving PNG...";
      }

      await new Promise((resolve) => window.setTimeout(resolve, 0));
      if (format === "tiff") {
        saveAdjustedTiff(rgbFloat || imageDataToFloat32Rgb(imageData), state.loadedWidth, state.loadedHeight, outputName, { channels: tiffChannels });
        viewport.log(`Saved full-resolution 16-bit TIFF ${state.loadedWidth}x${state.loadedHeight}.`);
      } else {
        saveAdjustedPng(imageData, outputName);
        viewport.log(`Saved full-resolution PNG ${state.loadedWidth}x${state.loadedHeight}.`);
      }
    } finally {
      state.isSaving = false;
      elements.saveButton.disabled = false;
      elements.saveButton.textContent = previousLabel;
    }
  }

  function buildFullResolutionRangeMaskImageData() {
    return maskToImageData(buildFullResolutionRangeMask(), state.loadedWidth, state.loadedHeight);
  }

  function buildFullResolutionRangeMask() {
    const count = state.loadedWidth * state.loadedHeight;
    const mask = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const base = index * 3;
      const y = luma709(
        state.loadedFullRgb[base],
        state.loadedFullRgb[base + 1],
        state.loadedFullRgb[base + 2]
      );
      mask[index] = computeRangeMask(y, getSelectedAdjustment().rangeMask);
    }
    return mask;
  }

  function savePresetToFile() {
    const adjustment = getSelectedAdjustment();
    const presetText = exportPresetToJson({
      imageType: state.imageType,
      globalStrength: state.globalStrength,
      sensitivity: state.sensitivity,
      rangeMask: adjustment.rangeMask,
      neutralLuminance: adjustment.neutralLuminance,
      bands: adjustment.bands,
      selectedBandId: adjustment.selectedBandId,
      soloBand: adjustment.soloBand,
    });
    const base = state.loadedImageName.replace(/\.[^.]+$/, "") || "astro-color-mixer";
    downloadTextFile(`${base}-adjustment-set.json`, presetText);
    viewport.log("Adjustment Set JSON saved.");
  }

  function applyBuiltInPresetByName(name) {
    const preset = BUILT_IN_PRESETS.find((item) => item.name === name);
    if (!preset) {
      return;
    }
    if (preset.name === "Reset All") {
      state.imageType = "stars";
      state.sensitivity = "Normal";
      state.adjustments = [createBasePass(1)];
      state.nextAdjustmentId = 2;
      state.selectedAdjustmentId = 1;
      populateSelectors();
      renderAdjustmentStack();
      syncSelectedBandControls();
      syncRangeMaskControls();
      renderSliderPanel();
      updateHueWheel();
      renderPreview(true);
      viewport.log("Applied starter preset Reset All.");
      return;
    }
    const adjustment = getSelectedAdjustment();
    const presetPayload = {
      version: "stack-14",
      imageType: preset.imageType,
      globalStrength: preset.globalStrength,
      sensitivity: preset.sensitivity,
      rangeMask: preset.rangeMask || RANGE_MASK_PRESETS.All,
      neutralLuminance: preset.neutralLuminance || createDefaultNeutralLuminance(),
      bands: preset.bands,
      _displayName: preset.name,
    };
    if (isAdvancedMode() && hasMeaningfulEdits(adjustment)) {
      state.pendingPreset = {
        preset: presetPayload,
        adjustmentId: adjustment.id,
      };
      renderPresetPassPrompt(true);
      return;
    }
    applyPreset(presetPayload, adjustment.id);
    viewport.log(`Applied starter preset ${preset.name}.`);
  }

  function applyPreset(preset, adjustmentId = state.selectedAdjustmentId) {
    const adjustment = getAdjustmentById(adjustmentId) || getSelectedAdjustment();
    state.imageType = preset.imageType || "stars";
    state.globalStrength = typeof preset.globalStrength === "number" ? preset.globalStrength : 1;
    state.sensitivity = preset.sensitivity || "Normal";
    adjustment.rangeMask = {
      ...RANGE_MASK_PRESETS.All,
      ...(preset.rangeMask || {}),
    };
    adjustment.neutralLuminance = {
      ...createDefaultNeutralLuminance(),
      ...(preset.neutralLuminance || {}),
    };
    adjustment.bands = mergePresetIntoBands(createBandDefaults(), preset.bands);
    adjustment.selectedBandId = preset.selectedBandId || adjustment.selectedBandId || "red";
    adjustment.soloBand = Boolean(preset.soloBand);
    clampBandsToSensitivity();
    populateSelectors();
    renderAdjustmentStack();
    syncSelectedBandControls();
    syncRangeMaskControls();
    renderSliderPanel();
    updateHueWheel();
    renderPreview(true);
  }

  function selectAdjustmentById(id) {
    viewport.resetInteraction();
    state.selectedAdjustmentId = Number(id);
    populateSelectors();
    renderAdjustmentStack();
    renderPassManager();
    renderStarterPresetsState();
    syncActivePassCard();
    renderSliderPanel();
    syncSelectedBandControls();
    syncRangeMaskControls();
    updateHueWheel();
    window.requestAnimationFrame(() => renderPreview(true));
  }

  function rgbCss(r, g, b) {
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
  }

  function getProcessingBands() {
    const adjustment = getSelectedAdjustment();
    if (!adjustment.soloBand) {
      return adjustment.bands.slice();
    }
    if (adjustment.selectedBandId === NEUTRAL_BAND_ID) {
      return [];
    }
    return adjustment.bands.filter((band) => band.id === adjustment.selectedBandId);
  }

  function getNeutralProcessingState() {
    const adjustment = getSelectedAdjustment();
    if (Math.abs(adjustment.neutralLuminance.luminance) <= 0.0001) {
      return adjustment.neutralLuminance;
    }
    if (adjustment.soloBand && adjustment.selectedBandId !== NEUTRAL_BAND_ID) {
      return { ...adjustment.neutralLuminance, luminance: 0 };
    }
    return adjustment.neutralLuminance;
  }

  function renderAdjustmentStack() {
    if (!elements.passSelect) {
      return;
    }
    const selected = getSelectedAdjustment();
    elements.passSelect.innerHTML = state.adjustments
      .map((adjustment) => {
        const offSuffix = adjustment.enabled ? "" : " (Off)";
        return `<option value="${adjustment.id}">${adjustment.label}${offSuffix}</option>`;
      })
      .join("");
    elements.passSelect.value = String(selected.id);
    elements.deleteAdjustmentBtn.disabled = isBasePass(selected);
    renderStarterPresetsState();
    syncActivePassCard();
    renderPassManager();
  }

  function renderPassManager() {
    if (!elements.passManagerList) {
      return;
    }
    const selected = getSelectedAdjustment();
    elements.passManagerList.innerHTML = state.adjustments.map((adjustment, index) => `
      <div class="pass-manager-row ${adjustment.id === selected.id ? "is-selected" : ""}" data-pass-id="${adjustment.id}" tabindex="0" role="button" aria-pressed="${adjustment.id === selected.id ? "true" : "false"}">
        <input class="pass-manager-enabled" type="checkbox" ${adjustment.enabled ? "checked" : ""} data-pass-id="${adjustment.id}" aria-label="Enable pass">
        <span class="pass-manager-name">${index + 1}. ${adjustment.label}</span>
        <span class="pass-manager-type">${getPassTypeLabel(adjustment)}</span>
        <span class="pass-manager-summary">${summarizePassAdjustments(adjustment)}</span>
        <span class="pass-manager-range">${summarizePassRangeMask(adjustment)}</span>
      </div>
    `).join("");

    elements.passManagerList.querySelectorAll(".pass-manager-row").forEach((row) => {
      const activate = (event) => {
        if (event.target.classList.contains("pass-manager-enabled")) {
          return;
        }
        selectAdjustmentById(row.dataset.passId);
      };
      row.addEventListener("click", activate);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate(event);
        }
      });
    });

    elements.passManagerList.querySelectorAll(".pass-manager-enabled").forEach((toggle) => {
      toggle.addEventListener("click", (event) => event.stopPropagation());
      toggle.addEventListener("change", () => {
        const adjustment = getAdjustmentById(Number(toggle.dataset.passId));
        adjustment.enabled = toggle.checked;
        renderAdjustmentStack();
        renderPassManager();
        syncActivePassCard();
        renderPreview(true);
      });
    });

    if (elements.passManagerDeleteBtn) {
      elements.passManagerDeleteBtn.disabled = isBasePass(selected);
    }
  }

  function renderSliderPanel() {
    const adjustment = getSelectedAdjustment();
    const metricKey = getMetricKeyForTab(state.selectedTab);
    const range = state.selectedTab === "luminance"
      ? SENSITIVITY_RANGES[state.sensitivity][metricKey]
      : SENSITIVITY_RANGES[state.sensitivity][metricKey];
    const step = String(SLIDER_STEPS[metricKey]);
    const rows = [];
    if (state.selectedTab === "luminance") {
      const neutralRange = NEUTRAL_SENSITIVITY_RANGES[state.sensitivity];
      const neutralActive = Math.abs(adjustment.neutralLuminance.luminance) > 0.0001;
      rows.push(`
        <div class="band-row is-neutral ${adjustment.selectedBandId === NEUTRAL_BAND_ID ? "is-selected" : ""} ${neutralActive ? "is-active" : ""}" data-band-id="${NEUTRAL_BAND_ID}" title="Adjusts luminance in low-saturation areas where hue is unreliable. Best used with Range Mask for background sky, halos, gray dust, or neutral structures.">
          <div class="band-meta">
            <div class="band-name-row">
              <span class="band-name">${NEUTRAL_LABEL}</span>
              ${neutralActive ? '<span class="band-active-pill">active</span>' : ""}
            </div>
          </div>
          <input
            class="band-slider"
            type="range"
            min="${-neutralRange}"
            max="${neutralRange}"
            step="${SLIDER_STEPS.neutralLuminance}"
            value="${adjustment.neutralLuminance.luminance}"
            data-band-id="${NEUTRAL_BAND_ID}"
            data-metric="luminance"
            style="background:${getSliderGradient(null, "neutral-luminance")}"
          >
          <output class="band-value">${formatMetricValue("luminance", adjustment.neutralLuminance.luminance)}</output>
          <button class="band-reset" type="button" data-band-id="${NEUTRAL_BAND_ID}" data-metric="luminance" title="Reset">x</button>
        </div>
      `);
    }

    rows.push(...adjustment.bands.map((band) => {
      const isActive = Math.abs(band.hueShift) > 0.0001 || Math.abs(band.saturation) > 0.0001 || Math.abs(band.luminance) > 0.0001;
      return `
        <div class="band-row ${band.id === adjustment.selectedBandId ? "is-selected" : ""} ${isActive ? "is-active" : ""}" data-band-id="${band.id}">
          <div class="band-meta">
            <div class="band-name-row">
              <span class="band-name">${band.label}</span>
              ${isActive ? '<span class="band-active-pill">active</span>' : ""}
            </div>
            <span class="band-center">Center ${band.center}&deg;</span>
          </div>
          <input
            class="band-slider"
            type="range"
            min="${-range}"
            max="${range}"
            step="${step}"
            value="${band[metricKey]}"
            data-band-id="${band.id}"
            data-metric="${metricKey}"
            style="background:${getSliderGradient(band, state.selectedTab)}"
          >
          <output class="band-value">${formatMetricValue(metricKey, band[metricKey])}</output>
          <button class="band-reset" type="button" data-band-id="${band.id}" data-metric="${metricKey}" title="Reset">x</button>
        </div>
      `;
    }));

    elements.sliderPanel.innerHTML = rows.join("");

    elements.sliderPanel.querySelectorAll(".band-row").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target.classList.contains("band-slider") || event.target.classList.contains("band-reset")) {
          return;
        }
        adjustment.selectedBandId = row.dataset.bandId;
        renderAdjustmentStack();
        renderSliderPanel();
        syncSelectedBandControls();
        updateHueWheel();
        renderPreview(true);
      });
    });

    elements.sliderPanel.querySelectorAll(".band-slider").forEach((slider) => {
      slider.addEventListener("input", () => {
        state.sliderInteractionDepth = 1;
        if (slider.dataset.bandId === NEUTRAL_BAND_ID) {
          adjustment.neutralLuminance.luminance = Number(slider.value);
          adjustment.selectedBandId = NEUTRAL_BAND_ID;
          slider.closest(".band-row").querySelector(".band-value").textContent =
            formatMetricValue("luminance", adjustment.neutralLuminance.luminance);
          updateBandRowVisual(slider.closest(".band-row"), { id: NEUTRAL_BAND_ID, hueShift: 0, saturation: 0, luminance: adjustment.neutralLuminance.luminance });
          syncBandRowSelection();
          updateActiveSummary();
          schedulePassViewerRefresh();
          syncSelectedBandControls();
          updateHueWheel();
          renderPreview();
          return;
        }
        const band = getBandByIdFromAdjustment(adjustment, slider.dataset.bandId);
        band[slider.dataset.metric] = Number(slider.value);
        adjustment.selectedBandId = band.id;
        slider.closest(".band-row").querySelector(".band-value").textContent =
          formatMetricValue(slider.dataset.metric, band[slider.dataset.metric]);
        updateBandRowVisual(slider.closest(".band-row"), band);
        syncBandRowSelection();
        updateActiveSummary();
        schedulePassViewerRefresh();
        syncSelectedBandControls();
        updateHueWheel();
        renderPreview();
      });
      commitRange(slider);
    });

    elements.sliderPanel.querySelectorAll(".band-reset").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (button.dataset.bandId === NEUTRAL_BAND_ID) {
          adjustment.neutralLuminance.luminance = 0;
          adjustment.selectedBandId = NEUTRAL_BAND_ID;
          renderAdjustmentStack();
          renderSliderPanel();
          syncSelectedBandControls();
          updateHueWheel();
          renderPreview(true);
          return;
        }
        const band = getBandByIdFromAdjustment(adjustment, button.dataset.bandId);
        band[button.dataset.metric] = 0;
        adjustment.selectedBandId = band.id;
        renderAdjustmentStack();
        renderSliderPanel();
        syncSelectedBandControls();
        updateHueWheel();
        renderPreview(true);
      });
    });

    updateActiveSummary();
  }

  function updateActiveSummary() {
    const adjustment = getSelectedAdjustment();
    const active = [];
    if (Math.abs(adjustment.neutralLuminance.luminance) > 0.0001) {
      active.push(`Neutral L ${formatSignedInt(adjustment.neutralLuminance.luminance)}`);
    }
    adjustment.bands.forEach((band) => {
      if (Math.abs(band.hueShift) > 0.0001) {
        active.push(`${shortBandLabel(band.label)} H ${formatSignedInt(band.hueShift)}`);
      }
      if (Math.abs(band.saturation) > 0.0001) {
        active.push(`${shortBandLabel(band.label)} S ${formatSignedInt(band.saturation)}`);
      }
      if (Math.abs(band.luminance) > 0.0001) {
        active.push(`${shortBandLabel(band.label)} L ${formatSignedInt(band.luminance)}`);
      }
    });
    elements.activeSummary.textContent = active.length ? `Active: ${active.join(" · ")}` : "Active: none";
    if (elements.activePassStrip) {
      elements.activePassStrip.textContent = `Active Pass: ${adjustment.label} · ${getCompactRangeMaskStatus(adjustment)}`;
    }
  }

  function updateBandRowVisual(row, band) {
    if (!row) {
      return;
    }
    const isActive = Math.abs(band.hueShift) > 0.0001 || Math.abs(band.saturation) > 0.0001 || Math.abs(band.luminance) > 0.0001;
    row.classList.toggle("is-active", isActive);
    let pill = row.querySelector(".band-active-pill");
    if (isActive && !pill) {
      pill = document.createElement("span");
      pill.className = "band-active-pill";
      pill.textContent = "active";
      row.querySelector(".band-name-row").appendChild(pill);
    } else if (!isActive && pill) {
      pill.remove();
    }
  }

  function syncBandRowSelection() {
    elements.sliderPanel.querySelectorAll(".band-row").forEach((row) => {
      row.classList.toggle("is-selected", row.dataset.bandId === getSelectedBandId());
    });
  }

  function syncTabButtons() {
    elements.tabButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tab === state.selectedTab);
    });
  }

  function syncToolTabs() {
    if (!isAdvancedMode()) {
      state.selectedToolTab = "band";
    }
    elements.toolTabButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.toolTab === state.selectedToolTab);
    });
    elements.bandTab.classList.toggle("is-hidden", state.selectedToolTab !== "band");
    elements.rangeMaskTab.classList.toggle("is-hidden", !isAdvancedMode() || state.selectedToolTab !== "range-mask");
  }

  function syncSelectedBandControls() {
    const adjustment = getSelectedAdjustment();
    const band = getSelectedBand();
    const neutralSelected = isNeutralSelected();
    elements.selectedBandPill.textContent = neutralSelected ? NEUTRAL_LABEL : band.label;
    elements.selectedBandSelect.value = neutralSelected ? NEUTRAL_BAND_ID : band.id;
    elements.soloBandToggle.checked = adjustment.soloBand;
    elements.soloBandToggleButton.setAttribute("aria-pressed", String(adjustment.soloBand && !neutralSelected));
    elements.soloBandToggleButton.classList.toggle("is-active", adjustment.soloBand && !neutralSelected);
    elements.soloBandToggleButton.classList.toggle("is-disabled", neutralSelected);
    elements.soloBandToggleButton.disabled = neutralSelected;
    elements.widthSlider.disabled = neutralSelected;
    elements.featherSlider.disabled = neutralSelected;
    if (neutralSelected) {
      elements.widthValue.textContent = "N/A";
      elements.featherValue.textContent = "N/A";
    } else {
      elements.widthSlider.value = String(band.width);
      elements.widthValue.textContent = `${band.width.toFixed(0)}°`;
      elements.featherSlider.value = String(band.feather);
      elements.featherValue.textContent = band.feather.toFixed(2);
    }
  }

  function syncRangeMaskControls() {
    const rangeMask = getSelectedAdjustment().rangeMask;
    elements.rangeMaskEnabled.checked = rangeMask.enabled;
    elements.rangeMaskPreset.value = rangeMask.preset;
    elements.rangeMaskLow.value = String(rangeMask.low);
    elements.rangeMaskHigh.value = String(rangeMask.high);
    elements.rangeMaskFeather.value = String(rangeMask.feather);
    elements.rangeMaskLowValue.textContent = rangeMask.low.toFixed(2);
    elements.rangeMaskHighValue.textContent = rangeMask.high.toFixed(2);
    elements.rangeMaskFeatherValue.textContent = rangeMask.feather.toFixed(2);
    elements.rangeMaskStatus.textContent = getCompactRangeMaskStatus();
  }

  function syncRangeMaskReadoutsOnly() {
    const rangeMask = getSelectedAdjustment().rangeMask;
    elements.rangeMaskPreset.value = rangeMask.preset;
    elements.rangeMaskLowValue.textContent = rangeMask.low.toFixed(2);
    elements.rangeMaskHighValue.textContent = rangeMask.high.toFixed(2);
    elements.rangeMaskFeatherValue.textContent = rangeMask.feather.toFixed(2);
    elements.rangeMaskStatus.textContent = getCompactRangeMaskStatus();
  }

  function normalizeHueDegrees(degrees) {
    let value = degrees % 360;
    if (value < 0) {
      value += 360;
    }
    return value;
  }

  function formatAngleDegrees(value) {
    const rounded = Math.round(value * 100) / 100;
    if (Math.abs(rounded - Math.round(rounded)) < 0.005) {
      return `${Math.round(rounded)}`;
    }
    return rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }

  function buildWheelReadoutHtml(lines, note = "") {
    const body = lines.map(({ label, value }) => (
      `<div class="wheel-readout-line"><span class="wheel-readout-label">${label}</span><span class="wheel-readout-value">${value}</span></div>`
    )).join("");
    return `<div class="wheel-readout-title">Selection</div>${body}${note ? `<div class="wheel-readout-note">${note}</div>` : ""}`;
  }

  function drawAnnularSector(ctx, cx, cy, innerRadius, outerRadius, startDeg, endDeg, fillStyle) {
    const start = normalizeHueDegrees(startDeg);
    const end = normalizeHueDegrees(endDeg);
    const spans = end <= start
      ? [{ start, end: 360 }, { start: 0, end }]
      : [{ start, end }];
    ctx.fillStyle = fillStyle;
    spans.forEach((span) => {
      const a0 = toRad(span.start - 90);
      const a1 = toRad(span.end - 90);
      ctx.beginPath();
      ctx.arc(cx, cy, outerRadius, a0, a1, false);
      ctx.arc(cx, cy, innerRadius, a1, a0, true);
      ctx.closePath();
      ctx.fill();
    });
  }

  function drawBoundaryMarker(ctx, cx, cy, angleDeg, innerRadius, outerRadius, color, width = 2) {
    const a = toRad(angleDeg - 90);
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.moveTo(cx + Math.cos(a) * innerRadius, cy + Math.sin(a) * innerRadius);
    ctx.lineTo(cx + Math.cos(a) * outerRadius, cy + Math.sin(a) * outerRadius);
    ctx.stroke();
  }

  function updateHueProfile(neutralSelected, band, outerWidth, innerWidth) {
    const canvas = elements.hueProfileCanvas;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const left = 8;
    const right = w - 8;
    const top = 6;
    const bottom = h - 8;
    const usableW = Math.max(1, right - left);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0f1115";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#1f2430";
    ctx.fillRect(left, top, usableW, bottom - top);
    if (neutralSelected) {
      const gradient = ctx.createLinearGradient(left, 0, right, 0);
      gradient.addColorStop(0, "#2d333c");
      gradient.addColorStop(0.5, "#d7d9dd");
      gradient.addColorStop(1, "#2d333c");
      ctx.fillStyle = gradient;
      ctx.fillRect(left, top, usableW, bottom - top);
      return;
    }
    const domain = 75;
    const centerX = Math.round((left + right) * 0.5);
    for (let x = left; x < right; x += 1) {
      const t = ((x - left) / Math.max(1, usableW - 1)) * 2 - 1;
      const distance = Math.abs(t) * domain;
      let color = "#232831";
      if (distance <= innerWidth + 1e-6) {
        color = "#f5be2d";
      } else if (distance <= outerWidth + 1e-6) {
        const blend = clamp((distance - innerWidth) / Math.max(1e-6, outerWidth - innerWidth), 0, 1);
        const start = { r: 199, g: 151, b: 45 };
        const end = { r: 77, g: 65, b: 39 };
        color = `rgb(${Math.round(start.r + (end.r - start.r) * blend)}, ${Math.round(start.g + (end.g - start.g) * blend)}, ${Math.round(start.b + (end.b - start.b) * blend)})`;
      }
      ctx.fillStyle = color;
      ctx.fillRect(x, top, 1, bottom - top);
    }
    const innerDx = Math.round((innerWidth / domain) * (usableW * 0.5));
    const outerDx = Math.round((outerWidth / domain) * (usableW * 0.5));
    ctx.strokeStyle = "#f5f5f5";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX, top - 1);
    ctx.lineTo(centerX, bottom + 1);
    ctx.stroke();
    ctx.strokeStyle = "#d9dce2";
    ctx.beginPath();
    ctx.moveTo(centerX - innerDx, top - 1);
    ctx.lineTo(centerX - innerDx, bottom + 1);
    ctx.moveTo(centerX + innerDx, top - 1);
    ctx.lineTo(centerX + innerDx, bottom + 1);
    ctx.stroke();
    ctx.strokeStyle = "#d6b366";
    ctx.beginPath();
    ctx.moveTo(centerX - outerDx, top - 1);
    ctx.lineTo(centerX - outerDx, bottom + 1);
    ctx.moveTo(centerX + outerDx, top - 1);
    ctx.lineTo(centerX + outerDx, bottom + 1);
    ctx.stroke();
  }

  function applyRangeMaskPreset(name) {
    getSelectedAdjustment().rangeMask = { ...RANGE_MASK_PRESETS[name] };
    syncRangeMaskControls();
    renderAdjustmentStack();
    renderPassManager();
    updateAnalysis();
    if (state.previewMode === "range-mask") {
      syncViewportMode();
    }
    renderPreview(true);
  }

  function updateHueWheel() {
    const band = getSelectedBand();
    const canvas = elements.hueWheelCanvas;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2 + 6;
    const radius = 34;

    ctx.clearRect(0, 0, w, h);

    if (isNeutralSelected()) {
      const adjustment = getSelectedAdjustment();
      const gradient = ctx.createLinearGradient(cx - radius, 0, cx + radius, 0);
      gradient.addColorStop(0, "#1d2229");
      gradient.addColorStop(0.5, "#7f848b");
      gradient.addColorStop(1, "#eceff3");
      ctx.beginPath();
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 10;
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 12;
      ctx.arc(cx, cy, radius + 24, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.fillStyle = "#0f1115";
      ctx.arc(cx, cy, radius - 15, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.font = "600 10px Avenir Next, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("NEUTRAL", cx, cy + 4);

      elements.hueWheelReadout.innerHTML = buildWheelReadoutHtml(
        [
          { label: "Selection", value: "Low-saturation" },
          { label: "Hue Radius", value: "Not used" },
          { label: "Feather", value: "N/A" },
        ],
        adjustment.rangeMask.enabled
          ? `Low-saturation luminance · Sat ${adjustment.neutralLuminance.satStart.toFixed(2)}-${adjustment.neutralLuminance.satFull.toFixed(2)}`
          : "Neutral luminance affects all low-saturation regions. Use Range Mask for tighter control."
      );
      elements.hueWheelReadout.classList.toggle("is-advisory", !adjustment.rangeMask.enabled && Math.abs(adjustment.neutralLuminance.luminance) > 0.0001);
      updateHueProfile(true);
      return;
    }

    for (let degree = 0; degree < 360; degree += 4) {
      drawAnnularSector(ctx, cx, cy, radius - 5, radius + 5, degree, degree + 4, `hsl(${degree + 2} 72% 54%)`);
    }

    drawAnnularSector(ctx, cx, cy, radius + 18, radius + 30, 0, 360, "rgba(255,255,255,0.08)");

    const outerWidth = band.width;
    const innerWidth = band.feather <= 1e-6 ? outerWidth : outerWidth * (1 - band.feather);
    const outerTrackInner = radius + 18;
    const outerTrackOuter = radius + 30;
    if (innerWidth + 1e-6 < outerWidth) {
      const featherSegments = Math.max(18, Math.ceil((outerWidth - innerWidth) / 2));
      for (let i = 0; i < featherSegments; i += 1) {
        const t0 = i / featherSegments;
        const t1 = (i + 1) / featherSegments;
        const blend = (t0 + t1) * 0.5;
        const startColor = { r: 199, g: 151, b: 45 };
        const endColor = { r: 77, g: 65, b: 39 };
        const color = `rgb(${Math.round(startColor.r + (endColor.r - startColor.r) * blend)}, ${Math.round(startColor.g + (endColor.g - startColor.g) * blend)}, ${Math.round(startColor.b + (endColor.b - startColor.b) * blend)})`;
        drawAnnularSector(
          ctx,
          cx,
          cy,
          outerTrackInner + 1,
          outerTrackOuter - 1,
          band.center - (innerWidth + (outerWidth - innerWidth) * t1),
          band.center - (innerWidth + (outerWidth - innerWidth) * t0),
          color
        );
        drawAnnularSector(
          ctx,
          cx,
          cy,
          outerTrackInner + 1,
          outerTrackOuter - 1,
          band.center + (innerWidth + (outerWidth - innerWidth) * t0),
          band.center + (innerWidth + (outerWidth - innerWidth) * t1),
          color
        );
      }
    }
    if (innerWidth > 1e-6) {
      drawAnnularSector(ctx, cx, cy, outerTrackInner, outerTrackOuter, band.center - innerWidth, band.center + innerWidth, "#f5be2d");
    }
    drawBoundaryMarker(ctx, cx, cy, band.center - outerWidth, outerTrackOuter - 2, outerTrackOuter + 5, "#d6b366", 2);
    drawBoundaryMarker(ctx, cx, cy, band.center + outerWidth, outerTrackOuter - 2, outerTrackOuter + 5, "#d6b366", 2);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(toRad(band.center - 90));
    ctx.beginPath();
    ctx.moveTo(radius - 7, 0);
    ctx.lineTo(radius + 32, 0);
    ctx.strokeStyle = "#f4df96";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.fillStyle = "#0f1115";
    ctx.arc(cx, cy, radius - 15, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.88)";
    ctx.font = "600 11px Avenir Next, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(band.id.toUpperCase(), cx, cy + 4);

    const affectedLow = formatAngleDegrees(normalizeHueDegrees(band.center - outerWidth));
    const affectedHigh = formatAngleDegrees(normalizeHueDegrees(band.center + outerWidth));
    elements.hueWheelReadout.innerHTML = buildWheelReadoutHtml(
      [
        { label: "Hue center", value: `${formatAngleDegrees(band.center)}°` },
        { label: "Hue Radius", value: `±${formatAngleDegrees(outerWidth)}°` },
        { label: "Strong core", value: `±${formatAngleDegrees(innerWidth)}°` },
        { label: "Falloff", value: `${formatAngleDegrees(innerWidth)}°–${formatAngleDegrees(outerWidth)}°` },
        { label: "Affected range", value: `${affectedLow}°–${affectedHigh}°` },
        { label: "Feather", value: band.feather.toFixed(2) },
      ],
      "Strong core is full strength. The feather zone falls smoothly to zero by the outer radius."
    );
    elements.hueWheelReadout.classList.remove("is-advisory");
    updateHueProfile(false, band, outerWidth, innerWidth);
  }

  function getMetricKeyForTab(tab) {
    if (tab === "hue") {
      return "hueShift";
    }
    if (tab === "luminance") {
      return "luminance";
    }
    return "saturation";
  }

  function getSliderGradient(band, tab) {
    if (tab === "neutral-luminance") {
      return "linear-gradient(90deg, #1d2229, #8b9199, #eceff3)";
    }
    const center = band.center;
    if (tab === "hue") {
      return `linear-gradient(90deg, hsl(${(center - 22 + 360) % 360} 76% 45%), hsl(${center} 82% 54%), hsl(${(center + 22) % 360} 76% 45%))`;
    }
    if (tab === "saturation") {
      return `linear-gradient(90deg, hsl(${center} 10% 42%), hsl(${center} 78% 54%))`;
    }
    return `linear-gradient(90deg, hsl(${center} 55% 22%), hsl(${center} 72% 50%), hsl(${center} 74% 74%))`;
  }

  function formatMetricValue(metricKey, value) {
    if (metricKey === "hueShift") {
      return `${value >= 0 ? "+" : ""}${value.toFixed(1)}°`;
    }
    return `${value >= 0 ? "+" : ""}${formatCompactNumber(value)}`;
  }

  function clampBandsToSensitivity() {
    const ranges = SENSITIVITY_RANGES[state.sensitivity];
    state.adjustments.forEach((adjustment) => {
      adjustment.bands.forEach((band) => {
        band.hueShift = clamp(band.hueShift, -ranges.hueShift, ranges.hueShift);
        band.saturation = clamp(band.saturation, -ranges.saturation, ranges.saturation);
        band.luminance = clamp(band.luminance, -ranges.luminance, ranges.luminance);
      });
      adjustment.neutralLuminance.luminance = clamp(
        adjustment.neutralLuminance.luminance,
        -NEUTRAL_SENSITIVITY_RANGES[state.sensitivity],
        NEUTRAL_SENSITIVITY_RANGES[state.sensitivity]
      );
    });
  }

  function shortBandLabel(label) {
    return label.split(" / ")[0];
  }

  function formatSignedInt(value) {
    return `${value >= 0 ? "+" : ""}${formatCompactNumber(value)}`;
  }

  function formatCompactNumber(value) {
    return Number.isInteger(value) ? `${value}` : value.toFixed(1);
  }

  function getBandByIdFromAdjustment(adjustment, id) {
    return adjustment.bands.find((band) => band.id === id);
  }

  function getBandById(id) {
    return getBandByIdFromAdjustment(getSelectedAdjustment(), id);
  }

  function getSelectedBand() {
    const adjustment = getSelectedAdjustment();
    return getBandByIdFromAdjustment(adjustment, adjustment.selectedBandId) || adjustment.bands[0];
  }

  function isNeutralSelected() {
    return getSelectedBandId() === NEUTRAL_BAND_ID;
  }

  function luma709(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function toRad(degrees) {
    return degrees * Math.PI / 180;
  }

  init();
  window.computeRangeMask = computeRangeMask;
  window.AstroColorMixerRecipe = {
    serializeCurrentRecipe() {
      return JSON.stringify(buildCurrentRecipe(), null, 2);
    },
    loadRecipe(recipeLike) {
      applyRecipeToState(recipeLike);
      return buildCurrentRecipe();
    },
  };
})();
