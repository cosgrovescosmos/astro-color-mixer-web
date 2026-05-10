# Astro Color Mixer Web Technical Appendix

## 1. Introduction

This appendix describes the processing model used by Astro Color Mixer Web and the practical assumptions behind it. The tool is designed for nonlinear RGB astrophotography images and combines hue-band selection, luminance-range masking, low-saturation handling, and sequential refinement passes.

The goal is not to claim physically perfect color reconstruction. The goal is to provide a controlled nonlinear RGB editing model that is useful for astrophotography finishing work in a browser-based environment.

## 2. Design Goals

Astro Color Mixer Web is designed around the following goals:

- controlled nonlinear RGB refinement
- an astro-specific color-band workflow
- prevention of arbitrary global color swings
- support for both stars-present and starless workflows
- visible mask and diagnostic feedback
- client-side processing without uploading image data to a server

This makes the tool a finishing and refinement environment rather than a calibration or reconstruction framework.

## 3. Processing Assumptions

Astro Color Mixer Web assumes:

- nonlinear RGB input
- normalized floating-point RGB values in the range `0..1`
- browser-local image data processing
- preview uses downsampled data for responsiveness
- final save uses full-resolution working data

These assumptions matter because the tool is intended for post-stretch, visually guided adjustment.

## 4. Image Type: Stars Present vs Starless / Star-Reduced

The Image Type setting selects protection behavior appropriate to the image being processed.

In **Stars Present** mode, Astro Color Mixer Web assumes the image still contains bright stellar structures, star cores, and possible halos. Protection is more conservative around bright star-like regions so large color or luminance moves are less likely to produce star-core distortion, oversaturated halos, or harsh highlight artifacts.

In **Starless / Star-Reduced** mode, Astro Color Mixer Web assumes stars have already been removed or strongly reduced. Protection can therefore allow more freedom in nebulae, galaxies, dust, and faint structures.

This setting does **not** detect stars, remove stars, or create a star mask. It changes protection weighting conceptually during adjustment.

## 5. Luminance Model

Astro Color Mixer Web uses the luminance model:

```text
Y = 0.2126 R + 0.7152 G + 0.0722 B
```

Luminance is used for:

- Range Mask construction
- preview diagnostics
- Neutral / Low-Saturation luminance control
- dark and highlight protection

In a nonlinear RGB workflow, luminance remains one of the most stable structural signals for targeted adjustment.

## 6. Hue and Saturation Selection

Hue and saturation are used for selection and adjustment behavior in an HSL-style sense.

Important properties:

- hue is circular
- hue distance must wrap at the ends of the angle domain
- low saturation makes hue unreliable

This is especially important in weak-color background, dust, and halo regions where nominal hue values can be unstable.

## 7. Astro Color Bands

Practical band centers:

- red `0°`
- orange `30°`
- yellow `60°`
- green `120°`
- cyan `180°`
- blue `240°`
- purple `275°`
- magenta `315°`

These bands are practical editing regions, not strict physical line assignments. Labels such as *H-alpha* and *OIII* are workflow cues intended to help users navigate common astrophotography color regions.

## 8. Hue Radius and Feather

Each active color band is built around circular hue distance from a band center.

- **Hue Radius** sets the outer affected angular radius on each side of the hue center
- **Feather** controls how much of that radius is used for falloff instead of full-strength influence
- a `smoothstep`-style falloff is used for soft selection boundaries

Conceptual pseudocode:

```text
distance = circularHueDistance(hue, center)
outerWidth = width
innerWidth = width * (1 - feather)
mask = 1 - smoothstep(innerWidth, outerWidth, distance)
```

This produces three practical regions:

- **strong core**: `distance <= innerWidth`
- **falloff zone**: `innerWidth < distance < outerWidth`
- **off**: `distance >= outerWidth`

So a setting such as `Hue Radius = 45°` and `Feather = 0.75` does **not** mean full-strength influence across the whole `±45°` span. Instead, the strong core occupies only the inner portion, and the rest falls smoothly to zero by the outer radius.

## 9. Saturation Reliability

Low-saturation pixels do not provide reliable hue information. Astro Color Mixer Web therefore uses a saturation reliability term to reduce the chance of neutral background or weak-color dust being treated as a strong hue target.

This helps:

- avoid false hue selection in gray background
- reduce instability in weak-color halos
- support a separate neutral luminance path for low-saturation structures

## 10. Dark and Highlight Protection

Very dark pixels can be noisy or unstable. Very bright pixels can contain star cores, clipped highlights, or structures where strong hue rotation becomes visually harsh.

Astro Color Mixer Web therefore applies conceptual protection for:

- dark background
- bright highlights
- star-core and stars-present behavior

The Image Type mode influences how conservative these protections are.

## 11. Range Mask

Range Mask limits the effect of an adjustment by luminance.

```text
leftRamp = smoothstep(low - feather, low, Y)
rightRamp = 1 - smoothstep(high, high + feather, Y)
rangeMask = clamp01(leftRamp * rightRamp)
```

Interpretation:

- **Low** defines the lower shoulder of the included interval
- **High** defines the upper shoulder
- **Feather** softens both boundaries
- presets act as starting points rather than fixed answers

Because the image is nonlinear, the practical meaning of a luminance interval depends on the current stretch.

## 12. Neutral / Low-Saturation Model

For low-saturation pixels, Astro Color Mixer Web uses a neutral mask rather than assuming hue is trustworthy:

```text
neutralMask = 1 - smoothstep(satStart, satFull, saturation)
```

This is useful for:

- sky background
- gray dust
- weak-color halos
- neutral transition regions

The model is luminance-focused because those regions often need tonal shaping more than hue-specific color editing.

## 13. Chroma-Vector Adjustment

Astro Color Mixer Web uses a practical nonlinear RGB chroma-vector editing model.

Conceptually:

- separate a luminance-like neutral component from chroma
- saturation scales chroma magnitude
- hue shifts rotate chroma direction
- luminance changes the brightness component
- recombine and clamp to a valid RGB range

This should be understood as a practical nonlinear editing model, not a claim of perfect perceptual or physical color science.

## 14. Combined Mask

A band adjustment is influenced by multiple control terms. Approximate combined influence can be described as:

```text
finalMask =
  hueMask *
  saturationReliability *
  darkProtection *
  highlightProtection *
  rangeMask
```

If additional pass-specific terms are applied in code, they conceptually sit on top of this structure. The practical behavior is that hue selection, reliability, protection, and luminance gating combine before the edit is applied.

## 15. Refinement Passes

Refinement Passes are sequential enabled passes stored in the working state.

Conceptually:

```text
working = original
for each enabled pass:
    working = applyPass(working, pass)
```

This supports workflows such as:

- broad global color setup first
- targeted background or halo cleanup later
- highlight or luminance-specific work in a separate pass

## 16. Preview and Diagnostics

Preview is based on downsampled image data for speed.

Diagnostics follow the preview model:

- histogram uses preview luminance
- polar plot uses sampled preview pixels
- probe reads preview coordinates
- mask views represent preview-resolution selection behavior

Final save operates on the full-resolution working image, which is why small local detail differences can exist even when the overall preview direction is accurate.

## 17. Adjustment Set JSON

Adjustment Set JSON stores the working state of the tool. This can include:

- image type
- sensitivity
- pass ordering and enabled state
- band values
- hue radius and feather
- Range Mask state
- Neutral / Low-Saturation state
- related working settings

The file is intended for repeatability and workflow continuity rather than for diagnostic rendering.

## 18. Browser and TIFF Considerations

Because the app runs entirely in the browser:

- memory usage matters for large images
- TIFF import/export depends on the included browser-side TIFF I/O code
- preview responsiveness may depend on browser performance and available RAM

The tool is designed to stay local and client-side, but large astrophotography files can still be demanding in a browser session.

## 19. Limitations

Important limitations:

- not intended for linear calibration
- extreme changes can create artifacts
- preview is approximate
- hue is unreliable in neutral areas
- Range Mask depends on the current stretch
- saturated star cores require care
- browser memory limits can constrain very large files

## 20. Practical Guidance

- start with small adjustments
- inspect masks before strong edits
- create a new pass for targeted Range Mask work
- use **Stars Present** when unsure
- save Adjustment Sets for complex sessions

Astro Color Mixer Web works best when used deliberately, with the user checking both the visual preview and the diagnostic views before committing strong targeted changes.
