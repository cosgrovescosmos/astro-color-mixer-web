(function () {
  const tiffApi = window.AstroImageIOTiff || null;

  function loadImageFile(file) {
    if (tiffApi && tiffApi.isTiffFile(file)) {
      return loadTiffFile(file);
    }
    return loadBrowserImageFile(file);
  }

  function loadBrowserImageFile(file) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(objectUrl);
        resolve({
          image,
          imageData,
          width: canvas.width,
          height: canvas.height,
          name: file.name,
          type: file.type,
          model: {
            width: canvas.width,
            height: canvas.height,
            channels: 3,
            sourceFormat: inferRasterFormat(file),
            sourceBitDepth: 8,
            rgbFloat: imageDataToFloat32Rgb(imageData),
            originalFileName: file.name,
            warnings: [],
            colorModel: "RGB",
          },
        });
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("The selected image could not be decoded by the browser."));
      };
      image.src = objectUrl;
    });
  }

  async function loadTiffFile(file) {
    if (!tiffApi) {
      throw new Error("TIFF support is not available in this build.");
    }
    const model = await tiffApi.readTiffFile(file);
    const imageData = float32RgbToImageData(model.rgbFloat, model.width, model.height);
    return {
      image: null,
      imageData,
      width: model.width,
      height: model.height,
      name: file.name,
      type: file.type,
      model,
    };
  }

  function inferRasterFormat(file) {
    const lower = (file?.name || "").toLowerCase();
    if (lower.endsWith(".png")) {
      return "png";
    }
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
      return "jpeg";
    }
    if (lower.endsWith(".tif") || lower.endsWith(".tiff")) {
      return "tiff";
    }
    return "unknown";
  }

  function imageDataToFloat32Rgb(imageData) {
    const rgba = imageData.data;
    const rgb = new Float32Array((rgba.length / 4) * 3);

    for (let src = 0, dst = 0; src < rgba.length; src += 4, dst += 3) {
      rgb[dst] = rgba[src] / 255;
      rgb[dst + 1] = rgba[src + 1] / 255;
      rgb[dst + 2] = rgba[src + 2] / 255;
    }

    return rgb;
  }

  function float32RgbToImageData(rgb, width, height) {
    const imageData = new ImageData(width, height);
    const rgba = imageData.data;

    for (let src = 0, dst = 0; src < rgb.length; src += 3, dst += 4) {
      rgba[dst] = Math.round(Math.min(1, Math.max(0, rgb[src])) * 255);
      rgba[dst + 1] = Math.round(Math.min(1, Math.max(0, rgb[src + 1])) * 255);
      rgba[dst + 2] = Math.round(Math.min(1, Math.max(0, rgb[src + 2])) * 255);
      rgba[dst + 3] = 255;
    }

    return imageData;
  }

  function createDownsampledPreviewImageData(imageData, maxEdge = 1100) {
    const { width, height } = imageData;
    const longestEdge = Math.max(width, height);
    if (longestEdge <= maxEdge) {
      return {
        imageData,
        scale: 1,
        width,
        height,
      };
    }

    const scale = maxEdge / longestEdge;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = width;
    srcCanvas.height = height;
    srcCanvas.getContext("2d").putImageData(imageData, 0, 0);

    const dstCanvas = document.createElement("canvas");
    dstCanvas.width = targetWidth;
    dstCanvas.height = targetHeight;
    const dstCtx = dstCanvas.getContext("2d", { willReadFrequently: true });
    dstCtx.imageSmoothingEnabled = true;
    dstCtx.imageSmoothingQuality = "high";
    dstCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);

    return {
      imageData: dstCtx.getImageData(0, 0, targetWidth, targetHeight),
      scale,
      width: targetWidth,
      height: targetHeight,
    };
  }

  function saveAdjustedPng(imageData, filename = "astro-color-mixer-output.png") {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext("2d").putImageData(imageData, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) {
        return;
      }
      const link = document.createElement("a");
      const objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 500);
    }, "image/png");
  }

  function saveAdjustedTiff(rgbFloat, width, height, filename = "astro-color-mixer-output.tif", options = {}) {
    if (!tiffApi || !tiffApi.encodeTiffRgb16 || !tiffApi.saveTiffBuffer) {
      throw new Error("16-bit TIFF export is not available in this build.");
    }
    const buffer = tiffApi.encodeTiffRgb16(rgbFloat, width, height, options);
    tiffApi.saveTiffBuffer(buffer, filename);
  }

  window.AstroImageIO = {
    loadImageFile,
    imageDataToFloat32Rgb,
    float32RgbToImageData,
    createDownsampledPreviewImageData,
    saveAdjustedPng,
    saveAdjustedTiff,
  };
})();
