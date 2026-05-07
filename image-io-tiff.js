(function () {
  function clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  function writeUint16(view, offset, value, littleEndian = true) {
    view.setUint16(offset, value, littleEndian);
  }

  function writeUint32(view, offset, value, littleEndian = true) {
    view.setUint32(offset, value, littleEndian);
  }

  function isTiffFile(file) {
    const lower = (file?.name || "").toLowerCase();
    const type = (file?.type || "").toLowerCase();
    return lower.endsWith(".tif") || lower.endsWith(".tiff") || type === "image/tiff" || type === "image/x-tiff";
  }

  function readTiffFile(file) {
    return file.arrayBuffer().then((buffer) => decodeTiffArrayBuffer(buffer, file.name || "image.tif"));
  }

  function encodeTiffRgb16(rgbFloat, width, height, options = {}) {
    const channels = options.channels === 1 ? 1 : 3;
    const bytesPerSample = 2;
    const samplesPerPixel = channels;
    const bitsOffsetCount = channels;
    const sampleFormatCount = channels;
    const stripByteCount = width * height * samplesPerPixel * bytesPerSample;
    const ifdEntryCount = 11;
    const headerBytes = 8;
    const ifdBytes = 2 + ifdEntryCount * 12 + 4;
    const bitsOffset = headerBytes + ifdBytes;
    const sampleFormatOffset = bitsOffset + bitsOffsetCount * 2;
    const pixelOffset = sampleFormatOffset + sampleFormatCount * 2;
    const totalBytes = pixelOffset + stripByteCount;
    const buffer = new ArrayBuffer(totalBytes);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const littleEndian = true;

    bytes[0] = 0x49;
    bytes[1] = 0x49;
    writeUint16(view, 2, 42, littleEndian);
    writeUint32(view, 4, headerBytes, littleEndian);

    let cursor = headerBytes;
    writeUint16(view, cursor, ifdEntryCount, littleEndian);
    cursor += 2;

    writeIfdEntry(view, cursor, 256, 4, 1, width, littleEndian); // ImageWidth
    cursor += 12;
    writeIfdEntry(view, cursor, 257, 4, 1, height, littleEndian); // ImageLength
    cursor += 12;
    writeIfdEntry(view, cursor, 258, 3, bitsOffsetCount, bitsOffset, littleEndian); // BitsPerSample
    cursor += 12;
    writeIfdEntry(view, cursor, 259, 3, 1, 1, littleEndian); // Compression = uncompressed
    cursor += 12;
    writeIfdEntry(view, cursor, 262, 3, 1, channels === 1 ? 1 : 2, littleEndian); // Photometric
    cursor += 12;
    writeIfdEntry(view, cursor, 273, 4, 1, pixelOffset, littleEndian); // StripOffsets
    cursor += 12;
    writeIfdEntry(view, cursor, 277, 3, 1, samplesPerPixel, littleEndian); // SamplesPerPixel
    cursor += 12;
    writeIfdEntry(view, cursor, 278, 4, 1, height, littleEndian); // RowsPerStrip
    cursor += 12;
    writeIfdEntry(view, cursor, 279, 4, 1, stripByteCount, littleEndian); // StripByteCounts
    cursor += 12;
    writeIfdEntry(view, cursor, 284, 3, 1, 1, littleEndian); // PlanarConfiguration = chunky
    cursor += 12;
    writeIfdEntry(view, cursor, 339, 3, sampleFormatCount, sampleFormatOffset, littleEndian); // SampleFormat = unsigned int
    cursor += 12;

    writeUint32(view, cursor, 0, littleEndian); // next IFD

    for (let index = 0; index < bitsOffsetCount; index += 1) {
      writeUint16(view, bitsOffset + index * 2, 16, littleEndian);
    }
    for (let index = 0; index < sampleFormatCount; index += 1) {
      writeUint16(view, sampleFormatOffset + index * 2, 1, littleEndian);
    }

    let pixelCursor = pixelOffset;
    if (channels === 1) {
      for (let src = 0; src < rgbFloat.length; src += 3) {
        const gray = clamp01(rgbFloat[src]);
        writeUint16(view, pixelCursor, Math.round(gray * 65535), littleEndian);
        pixelCursor += 2;
      }
    } else {
      for (let src = 0; src < rgbFloat.length; src += 3) {
        writeUint16(view, pixelCursor, Math.round(clamp01(rgbFloat[src]) * 65535), littleEndian);
        pixelCursor += 2;
        writeUint16(view, pixelCursor, Math.round(clamp01(rgbFloat[src + 1]) * 65535), littleEndian);
        pixelCursor += 2;
        writeUint16(view, pixelCursor, Math.round(clamp01(rgbFloat[src + 2]) * 65535), littleEndian);
        pixelCursor += 2;
      }
    }

    return buffer;
  }

  function saveTiffBuffer(buffer, filename = "astro-color-mixer-output.tif") {
    const blob = new Blob([buffer], { type: "image/tiff" });
    const link = document.createElement("a");
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 800);
  }

  function writeIfdEntry(view, offset, tag, type, count, valueOrOffset, littleEndian) {
    writeUint16(view, offset, tag, littleEndian);
    writeUint16(view, offset + 2, type, littleEndian);
    writeUint32(view, offset + 4, count, littleEndian);
    if (type === 3 && count === 1) {
      writeUint16(view, offset + 8, valueOrOffset, littleEndian);
      writeUint16(view, offset + 10, 0, littleEndian);
      return;
    }
    writeUint32(view, offset + 8, valueOrOffset, littleEndian);
  }

  function decodeTiffArrayBuffer(buffer, originalFileName = "image.tif") {
    const view = new DataView(buffer);
    if (view.byteLength < 8) {
      throw new Error("This TIFF is too small to decode.");
    }

    const endianMark = String.fromCharCode(view.getUint8(0)) + String.fromCharCode(view.getUint8(1));
    let littleEndian;
    if (endianMark === "II") {
      littleEndian = true;
    } else if (endianMark === "MM") {
      littleEndian = false;
    } else {
      throw new Error("This file does not look like a TIFF.");
    }

    const magic = view.getUint16(2, littleEndian);
    if (magic !== 42) {
      throw new Error("Unsupported TIFF header.");
    }

    const firstIfdOffset = view.getUint32(4, littleEndian);
    if (firstIfdOffset <= 0 || firstIfdOffset >= view.byteLength) {
      throw new Error("Invalid TIFF directory offset.");
    }

    const ifd = parseIfd(view, firstIfdOffset, littleEndian);
    const width = getSingleTagValue(ifd, 256);
    const height = getSingleTagValue(ifd, 257);
    const bitsPerSample = getArrayTagValue(ifd, 258) || [8];
    const compression = getSingleTagValue(ifd, 259, 1);
    const photometric = getSingleTagValue(ifd, 262, 2);
    const stripOffsets = getArrayTagValue(ifd, 273);
    const samplesPerPixel = getSingleTagValue(ifd, 277, 1);
    const rowsPerStrip = getSingleTagValue(ifd, 278, height);
    const stripByteCounts = getArrayTagValue(ifd, 279);
    const planarConfiguration = getSingleTagValue(ifd, 284, 1);
    const predictor = getSingleTagValue(ifd, 317, 1);
    const sampleFormat = getArrayTagValue(ifd, 339) || new Array(samplesPerPixel).fill(1);

    if (!width || !height || !stripOffsets || !stripByteCounts) {
      throw new Error("This TIFF is missing required image data tags.");
    }
    if (![1, 5].includes(compression)) {
      throw new Error("This TIFF variant is not currently supported. Try exporting an uncompressed or LZW-compressed 16-bit RGB or grayscale TIFF from PixInsight.");
    }
    if (planarConfiguration !== 1) {
      throw new Error("Planar TIFFs are not currently supported. Please export chunky/interleaved TIFF data.");
    }
    if (![1, 3].includes(samplesPerPixel)) {
      throw new Error("Only grayscale and RGB TIFF images are currently supported.");
    }
    if (!sampleFormat.every((value) => value === 1)) {
      throw new Error("Only unsigned integer TIFF samples are currently supported.");
    }
    if (!(photometric === 0 || photometric === 1 || photometric === 2)) {
      throw new Error("This TIFF photometric interpretation is not currently supported.");
    }
    if (samplesPerPixel === 3 && photometric !== 2) {
      throw new Error("RGB TIFF data must use RGB photometric interpretation.");
    }

    const normalizedBits = normalizeBitsPerSample(bitsPerSample, samplesPerPixel);
    const sourceBitDepth = normalizedBits[0];
    if (!normalizedBits.every((value) => value === sourceBitDepth)) {
      throw new Error("Mixed TIFF sample bit depths are not currently supported.");
    }
    if (![8, 16].includes(sourceBitDepth)) {
      throw new Error("Only 8-bit and 16-bit TIFF images are currently supported in this build.");
    }
    if (![1, 2].includes(predictor)) {
      throw new Error("This TIFF predictor setting is not currently supported.");
    }

    const rgbFloat = new Float32Array(width * height * 3);
    const bytesPerSample = sourceBitDepth / 8;
    const maxValue = sourceBitDepth === 16 ? 65535 : 255;
    let rowStart = 0;

    for (let stripIndex = 0; stripIndex < stripOffsets.length; stripIndex += 1) {
      const stripOffset = stripOffsets[stripIndex];
      const stripByteCount = stripByteCounts[Math.min(stripIndex, stripByteCounts.length - 1)];
      const rowsInStrip = Math.min(rowsPerStrip, height - rowStart);
      const stripPixels = rowsInStrip * width;
      const expectedBytes = stripPixels * samplesPerPixel * bytesPerSample;

      if (stripOffset < 0 || stripOffset + stripByteCount > view.byteLength) {
        throw new Error("This TIFF has invalid strip offsets.");
      }
      const compressedBytes = new Uint8Array(buffer, stripOffset, stripByteCount);
      let stripData;
      if (compression === 1) {
        if (stripByteCount < expectedBytes) {
          throw new Error("This TIFF strip is shorter than expected for its declared format.");
        }
        stripData = compressedBytes;
      } else {
        stripData = decodeTiffLzw(compressedBytes, expectedBytes);
        if (stripData.length < expectedBytes) {
          throw new Error("This LZW-compressed TIFF strip decoded shorter than expected.");
        }
      }
      if (predictor === 2) {
        applyHorizontalPredictor(stripData, width, rowsInStrip, samplesPerPixel, bytesPerSample, littleEndian);
      }

      let cursor = 0;
      for (let localPixel = 0; localPixel < stripPixels; localPixel += 1) {
        const globalPixel = (rowStart * width) + localPixel;
        const dst = globalPixel * 3;

        if (samplesPerPixel === 1) {
          const sample = sourceBitDepth === 16
            ? readUint16FromArray(stripData, cursor, littleEndian)
            : stripData[cursor];
          cursor += bytesPerSample;
          let normalized = clamp01(sample / maxValue);
          if (photometric === 0) {
            normalized = 1 - normalized;
          }
          rgbFloat[dst] = normalized;
          rgbFloat[dst + 1] = normalized;
          rgbFloat[dst + 2] = normalized;
        } else {
          const r = sourceBitDepth === 16 ? readUint16FromArray(stripData, cursor, littleEndian) : stripData[cursor];
          cursor += bytesPerSample;
          const g = sourceBitDepth === 16 ? readUint16FromArray(stripData, cursor, littleEndian) : stripData[cursor];
          cursor += bytesPerSample;
          const b = sourceBitDepth === 16 ? readUint16FromArray(stripData, cursor, littleEndian) : stripData[cursor];
          cursor += bytesPerSample;
          rgbFloat[dst] = clamp01(r / maxValue);
          rgbFloat[dst + 1] = clamp01(g / maxValue);
          rgbFloat[dst + 2] = clamp01(b / maxValue);
        }
      }

      rowStart += rowsInStrip;
    }

    const warnings = [
      "TIFF metadata is not preserved in this browser build.",
    ];

    return {
      width,
      height,
      channels: 3,
      sourceFormat: "tiff",
      sourceBitDepth,
      rgbFloat,
      originalFileName,
      warnings,
      colorModel: samplesPerPixel === 1 ? "Grayscale" : "RGB",
      compression: compression === 1 ? "Uncompressed" : compression === 5 ? "LZW" : `Compression ${compression}`,
    };
  }

  function readUint16FromArray(array, offset, littleEndian) {
    return littleEndian
      ? (array[offset] | (array[offset + 1] << 8))
      : ((array[offset] << 8) | array[offset + 1]);
  }

  function writeUint16ToArray(array, offset, value, littleEndian) {
    if (littleEndian) {
      array[offset] = value & 0xff;
      array[offset + 1] = (value >> 8) & 0xff;
      return;
    }
    array[offset] = (value >> 8) & 0xff;
    array[offset + 1] = value & 0xff;
  }

  function applyHorizontalPredictor(bytes, width, rows, samplesPerPixel, bytesPerSample, littleEndian) {
    const rowStride = width * samplesPerPixel * bytesPerSample;
    for (let row = 0; row < rows; row += 1) {
      const rowOffset = row * rowStride;
      for (let pixel = 1; pixel < width; pixel += 1) {
        for (let sample = 0; sample < samplesPerPixel; sample += 1) {
          const currentOffset = rowOffset + (pixel * samplesPerPixel + sample) * bytesPerSample;
          const previousOffset = rowOffset + ((pixel - 1) * samplesPerPixel + sample) * bytesPerSample;
          if (bytesPerSample === 1) {
            bytes[currentOffset] = (bytes[currentOffset] + bytes[previousOffset]) & 0xff;
          } else if (bytesPerSample === 2) {
            const current = readUint16FromArray(bytes, currentOffset, littleEndian);
            const previous = readUint16FromArray(bytes, previousOffset, littleEndian);
            writeUint16ToArray(bytes, currentOffset, (current + previous) & 0xffff, littleEndian);
          }
        }
      }
    }
  }

  function decodeTiffLzw(input, expectedBytes) {
    try {
      return decodeTiffLzwVariant(input, expectedBytes, { oldStyle: false });
    } catch (error) {
      try {
        return decodeTiffLzwVariant(input, expectedBytes, { oldStyle: true });
      } catch (_fallbackError) {
        throw error;
      }
    }
  }

  function decodeTiffLzwVariant(input, expectedBytes, { oldStyle }) {
    const CLEAR = 256;
    const EOI = 257;
    let codeSize = 9;
    let nextCode = 258;
    let bitPos = 0;
    let previous = null;
    const output = [];
    let dictionary = makeInitialLzwDictionary();

    while (bitPos + codeSize <= input.length * 8) {
      const code = readLzwCode(input, bitPos, codeSize, oldStyle);
      bitPos += codeSize;

      if (code === CLEAR) {
        dictionary = makeInitialLzwDictionary();
        codeSize = 9;
        nextCode = 258;
        previous = null;
        continue;
      }
      if (code === EOI) {
        break;
      }

      let entry;
      if (dictionary[code]) {
        entry = dictionary[code];
      } else if (code === nextCode && previous) {
        entry = concatUint8(previous, previous[0]);
      } else {
        throw new Error("This LZW-compressed TIFF could not be decoded.");
      }

      for (let index = 0; index < entry.length; index += 1) {
        output.push(entry[index]);
      }

      if (previous) {
        dictionary[nextCode] = concatUint8(previous, entry[0]);
        nextCode += 1;
        if (
          (oldStyle && nextCode === (1 << codeSize) && codeSize < 12) ||
          (!oldStyle && nextCode === ((1 << codeSize) - 1) && codeSize < 12)
        ) {
          codeSize += 1;
        }
      }

      previous = entry;
      if (expectedBytes && output.length >= expectedBytes) {
        break;
      }
    }

    return Uint8Array.from(output);
  }

  function makeInitialLzwDictionary() {
    const dictionary = [];
    for (let index = 0; index < 256; index += 1) {
      dictionary[index] = Uint8Array.of(index);
    }
    return dictionary;
  }

  function readLzwCode(input, bitPos, codeSize, oldStyle) {
    let value = 0;
    if (oldStyle) {
      for (let bit = 0; bit < codeSize; bit += 1) {
        const absoluteBit = bitPos + bit;
        const byteIndex = absoluteBit >> 3;
        const bitIndex = absoluteBit & 7;
        value |= ((input[byteIndex] >> bitIndex) & 1) << bit;
      }
      return value;
    }
    for (let bit = 0; bit < codeSize; bit += 1) {
      const absoluteBit = bitPos + bit;
      const byteIndex = absoluteBit >> 3;
      const bitIndex = 7 - (absoluteBit & 7);
      value = (value << 1) | ((input[byteIndex] >> bitIndex) & 1);
    }
    return value;
  }

  function concatUint8(prefix, trailingByte) {
    const result = new Uint8Array(prefix.length + 1);
    result.set(prefix, 0);
    result[prefix.length] = trailingByte;
    return result;
  }

  function normalizeBitsPerSample(bitsPerSample, samplesPerPixel) {
    if (bitsPerSample.length === 1 && samplesPerPixel > 1) {
      return new Array(samplesPerPixel).fill(bitsPerSample[0]);
    }
    return bitsPerSample;
  }

  function parseIfd(view, offset, littleEndian) {
    const entryCount = view.getUint16(offset, littleEndian);
    const entries = new Map();
    let cursor = offset + 2;
    for (let index = 0; index < entryCount; index += 1) {
      const tag = view.getUint16(cursor, littleEndian);
      const type = view.getUint16(cursor + 2, littleEndian);
      const count = view.getUint32(cursor + 4, littleEndian);
      const value = readIfdValue(view, cursor, type, count, littleEndian);
      entries.set(tag, value);
      cursor += 12;
    }
    return entries;
  }

  function readIfdValue(view, entryOffset, type, count, littleEndian) {
    const typeSize = getTiffTypeSize(type);
    if (!typeSize) {
      return null;
    }
    const byteLength = typeSize * count;
    const valueOffset = byteLength <= 4
      ? entryOffset + 8
      : view.getUint32(entryOffset + 8, littleEndian);

    if (valueOffset < 0 || valueOffset + byteLength > view.byteLength) {
      throw new Error("This TIFF contains invalid tag data.");
    }

    const values = [];
    for (let index = 0; index < count; index += 1) {
      const at = valueOffset + index * typeSize;
      switch (type) {
        case 1:
          values.push(view.getUint8(at));
          break;
        case 3:
          values.push(view.getUint16(at, littleEndian));
          break;
        case 4:
          values.push(view.getUint32(at, littleEndian));
          break;
        default:
          throw new Error("This TIFF contains unsupported tag types.");
      }
    }

    return count === 1 ? values[0] : values;
  }

  function getTiffTypeSize(type) {
    switch (type) {
      case 1:
        return 1;
      case 3:
        return 2;
      case 4:
        return 4;
      default:
        return 0;
    }
  }

  function getSingleTagValue(ifd, tag, fallback = null) {
    if (!ifd.has(tag)) {
      return fallback;
    }
    const value = ifd.get(tag);
    return Array.isArray(value) ? value[0] : value;
  }

  function getArrayTagValue(ifd, tag) {
    if (!ifd.has(tag)) {
      return null;
    }
    const value = ifd.get(tag);
    return Array.isArray(value) ? value : [value];
  }

  window.AstroImageIOTiff = {
    isTiffFile,
    readTiffFile,
    decodeTiffArrayBuffer,
    encodeTiffRgb16,
    saveTiffBuffer,
  };
})();
