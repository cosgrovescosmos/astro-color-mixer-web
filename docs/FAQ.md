# Astro Color Mixer FAQ & Practical Guide

Astro Color Mixer Web is a browser-based nonlinear RGB color and luminance refinement tool for astrophotography. It is intended for images that have already been stretched and are ready for controlled finishing work.

## What is Astro Color Mixer?

Astro Color Mixer is a nonlinear RGB finishing tool built around practical astro color bands, luminance targeting, preview diagnostics, and optional multi-pass refinement. It is designed for controlled color shaping, not broad calibration.

## What kind of image should I use?

Use a nonlinear RGB image.

Good candidates:

- stretched RGB images
- stars-present images
- starless or strongly star-reduced images

Not recommended:

- raw linear stacks
- images that still need calibration or major global correction

## What is Stars Present vs Starless / Star-Reduced?

**Stars Present** is the safer mode for images with normal stars, bright cores, and halos. It uses more conservative protection in bright stellar regions.

**Starless / Star-Reduced** allows more freedom in nebulae, galaxies, dust, and faint structures after stars have been removed or heavily reduced.

This setting does not remove stars. It changes the protection behavior used during adjustment.

## What is Standard vs Advanced workflow?

**Standard** mode is meant for broad image-first work with a simpler control flow.

**Advanced** mode reveals:

- Refinement Passes
- Range Mask controls
- pass-aware compare behavior
- more targeted correction workflows

Use Standard when shaping the image globally. Move to Advanced when you want separate surgical corrections.

## What do the Color Mixer sliders do?

- **Hue** rotates the selected color region
- **Saturation** strengthens or weakens color intensity
- **Luminance** brightens or darkens the selected region

These apply to the currently active pass.

## What are Selected Band Width and Feather?

- **Width** controls how broad the selected hue family is
- **Feather** controls how softly the selection falls off into neighboring hues

Narrow width is more selective. More feather makes the transition smoother.

## What is Range Mask?

Range Mask limits an adjustment by luminance.

- **Low** defines the lower brightness boundary
- **High** defines the upper brightness boundary
- **Feather** softens the edges
- presets give quick starting points for shadows, midtones, highlights, faint signal, and bright cores

## What is Neutral / Low-Saturation?

When saturation is very low, hue becomes unreliable. Neutral / Low-Saturation gives those pixels a luminance-focused adjustment path instead of forcing hue-based logic into gray background and weak-color structures.

## What are Refinement Passes?

Refinement Passes are sequential adjustment passes.

- **Base Pass** is for broad/global work
- later passes are for targeted cleanup or luminance shaping

They are not Photoshop layers. There are no blend modes or pass opacity controls.

## What do the probe, histogram, and polar plot do?

- the **probe** samples a preview pixel and reports luminance, hue, and saturation
- the **histogram** shows preview luminance distribution and helps place Range Mask
- the **polar plot** shows hue angle and saturation distribution

The probe can also auto-select the nearest color band when hue is reliable.

## Why can preview differ from saved output?

Preview uses downsampled data for responsiveness. Saving renders from full-resolution data. The overall direction should match, but fine detail can differ slightly.

## What file formats are supported?

- image load: PNG, JPEG, and supported TIFF
- image save: PNG and TIFF

TIFF behavior depends on the included browser-side TIFF I/O code and the memory limits of the browser.

## What are Adjustment Sets?

Adjustment Sets are JSON files that preserve the working state of the web app, including:

- image type
- sensitivity
- selected color adjustments
- range mask settings
- neutral luminance settings

Starter Presets are canned starting points. Adjustment Sets are your saved working state.

## Common mistakes

- using the tool on linear data
- making extreme hue shifts instead of smaller targeted moves
- applying Range Mask in a broad pass unintentionally
- ignoring mask views before strong changes
- expecting hue to be meaningful in neutral background
- forgetting preview may be stale if Auto Preview is off
- trying to process images too large for available browser memory

## TIFF and browser limitations

The web version runs fully client-side. No image data is uploaded to a server, but very large TIFF files can consume significant memory depending on browser limits.
