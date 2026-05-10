# Astro Color Mixer Web FAQ & Practical Guide

Astro Color Mixer Web is a browser-based nonlinear RGB color and luminance refinement tool for astrophotography. It is designed for images that have already been stretched and visually prepared for finishing work. It is not a calibration tool and it is not intended for raw linear stacks.

## 1. What is Astro Color Mixer Web?

Astro Color Mixer Web is a finishing tool for nonlinear RGB astrophotography. It combines practical astro color bands, Selected Band targeting, Range Mask gating, preview diagnostics, and optional multi-pass refinement.

It is especially useful for:

- emission nebula color shaping
- reflection nebulosity enhancement
- galaxy core and dust refinement
- magenta or violet halo cleanup
- neutral background luminance control
- targeted cleanup through multiple passes

The web app runs entirely client-side in the browser. Image data stays local to the browser session.

## 2. Where does it fit in a workflow?

Use it after:

- calibration
- registration and integration
- background correction
- color calibration
- nonlinear stretch
- any early noise reduction or contrast work that should happen before finishing color

Its normal role is controlled final refinement, not broad upstream correction.

## 3. What kind of image should I use?

Use a nonlinear RGB image.

Good candidates:

- stretched RGB images with stars present
- starless RGB images
- star-reduced RGB images

Avoid using it on:

- raw linear stacks
- data that still needs major global calibration work

Preview is downsampled for speed. Saved output renders from the full-resolution working image.

## 4. What is Stars Present vs Starless / Star-Reduced?

The **Image Type** setting changes how the app protects the image during adjustment.

**Stars Present** is the safer mode for images that still contain normal stars, bright cores, and halos. It is more conservative around bright stellar structures so aggressive color or luminance moves are less likely to create damaged star cores or harsh highlight artifacts.

**Starless / Star-Reduced** is intended for images where stars have already been removed or strongly reduced. Since fewer bright stellar features remain, the tool can act more freely on nebulae, galaxies, dust, and faint structures.

This setting does **not** remove stars. It does **not** create a star mask. It only changes protection behavior during adjustment.

## 5. What is the basic workflow?

1. Load a nonlinear RGB image.
2. Choose **Image Type**.
3. Start in **Base Pass** or Standard workflow.
4. Make broad H/S/L changes.
5. Use the probe, histogram, and polar plot to understand the current target.
6. Refine the selected hue family with **Hue Radius** and **Feather**.
7. Use Range Mask for luminance-specific targeting.
8. Add new refinement passes for targeted work when needed.
9. Inspect preview and mask views.
10. Save a PNG or TIFF output.
11. Save an Adjustment Set if the session should be preserved.

## 6. What are the color bands?

- **Red / H-alpha**: broad red emission and warm red structure control
- **Orange / Dust & Galaxy Cores**: warm dust and core-toned shaping
- **Yellow / Warm Stars**: warm stellar color and gold transitions
- **Green / Cast Control**: green cast cleanup or restrained green restoration
- **Cyan / OIII**: cyan-turquoise emission work
- **Blue / Reflection Nebula**: reflection nebulosity and blue structures
- **Purple / Violet Cleanup**: violet drift and blue-violet transition cleanup
- **Magenta / Halo Cleanup**: magenta halo and artifact cleanup

These are practical editing regions, not strict physical emission-line labels.

## 7. What do Hue, Saturation, and Luminance do?

- **Hue** rotates color direction inside the active band.
- **Saturation** strengthens or weakens color intensity inside the active band.
- **Luminance** brightens or darkens the active band.

These adjustments apply to the currently active pass, which is why broad work and targeted work are often separated into different passes.

## 8. What are Hue Radius and Feather?

Hue Radius and Feather control how the active color band is selected.

- **Hue Radius** sets the outer limit on each side of the hue center.
- **Feather** determines how quickly the selection falls from the strong core to that outer limit.

The current mask model has three practical regions:

- a **strong core** near the hue center
- a **falloff zone** between the strong core and the outer radius
- **unaffected hues** outside the outer radius

So if **Hue Radius = 45°** and **Feather = 0.75**, the affected range reaches `±45°`, but full-strength influence occupies only the inner part of that span. The rest is a smooth feathered falloff to zero.

Practical guidance:

- lower Hue Radius for more selective edits
- higher Hue Radius for a broader color-family reach
- lower Feather for firmer boundaries
- higher Feather for smoother transitions

## 9. What is Range Mask?

Range Mask is a luminance-based selector applied within the active pass.

Controls:

- **Low** defines the lower luminance boundary
- **High** defines the upper luminance boundary
- **Feather** softens both edges
- **Presets** provide starting points for common luminance regions

It is useful for:

- dim background work
- faint-signal emphasis
- highlight targeting
- bright core control
- star-region cleanup

## 10. What is Neutral / Low-Saturation?

When saturation is very low, hue becomes unreliable. Astro Color Mixer Web therefore provides a Neutral / Low-Saturation luminance path for weak-color material.

This is useful for:

- sky background
- gray dust
- low-color halos
- neutral transition regions
- structures where hue-specific editing would be misleading

## 11. What are Refinement Passes?

Refinement Passes are ordered adjustment passes.

Typical use:

- **Base Pass** for broad/global work
- later passes for targeted cleanup or luminance-specific shaping

They are **not** Photoshop layers:

- no blend modes
- no pass opacity control
- passes apply sequentially in order

## 12. What do the probe, histogram, and polar plot do?

The **probe** samples a preview pixel and reports luminance, hue, and saturation.

It also:

- places markers on the histogram and polar plot
- helps identify what part of the image is being measured
- can auto-select the nearest color band when hue is reliable

The **histogram** shows preview luminance distribution and helps place Range Mask.

The **polar plot** shows hue angle and saturation radius for sampled preview pixels. It is a fast diagnostic view of how color is distributed in the current preview.

## 13. What are mask views?

Mask views show what the current adjustment is affecting.

Typical interpretation:

- **white** = included strongly
- **black** = excluded strongly

Mask views can display:

- selected band influence
- Range Mask influence
- combined influence

These views are especially helpful before strong halo cleanup, narrow-band targeting, or background shaping.

## 14. Why can preview differ from saved output?

Preview uses downsampled data so the tool stays responsive.

Saved output renders from the full-resolution working image, which means:

- tiny local details can differ slightly
- overall edit direction should still match
- stale preview can mislead unless refreshed

## 15. What file formats are supported?

The web app is designed primarily for browser-side RGB workflows.

- **PNG** export is supported
- **TIFF** import/export is supported when the included browser-side TIFF I/O code and available browser memory allow it

Large TIFF files can be memory-intensive in a browser session.

## 16. What are Adjustment Sets?

Adjustment Sets are JSON files that store the working state of the app.

They can preserve:

- pass order and enabled state
- H/S/L band values
- selected band behavior
- Hue Radius and Feather
- Range Mask settings
- Neutral / Low-Saturation settings
- image type and related tool state

Starter Presets are canned starting points. Adjustment Sets are your saved session state.

## 17. Common mistakes

- using the tool on linear data
- making excessive hue shifts where smaller targeted passes would be safer
- changing Range Mask inside an existing global pass unintentionally
- ignoring the mask preview before strong edits
- expecting hue to be meaningful in neutral background
- forgetting that preview may be stale after changes
- pushing browser memory too hard with very large TIFFs

## 18. Example workflows

### A. Faint blue reflection nebulosity lift

1. Start in Base Pass or create a dedicated reflection pass.
2. Increase **Blue / Reflection Nebula** saturation modestly.
3. Inspect the band mask.
4. Reduce **Hue Radius** if blue stars are moving more than the nebulosity.
5. Use Range Mask if the goal is faint blue structure rather than highlights.

### B. Magenta halo cleanup

1. Create a new refinement pass.
2. Work mainly in **Magenta / Halo Cleanup**, with **Purple / Violet Cleanup** if needed.
3. Use a narrower **Hue Radius** and enough Feather to keep the transition smooth.
4. Use Range Mask if the artifact is concentrated in brighter star-adjacent regions.

### C. Neutral background luminance control with Range Mask

1. Use the **Luminance** tab.
2. Work through **Neutral / Low-Saturation** rather than a hue band.
3. Enable Range Mask and target the dim background interval.
4. Make a small luminance adjustment.
5. Inspect the histogram and combined mask before increasing strength.
6. Keep this separate from the broad color pass so the workflow stays understandable.
