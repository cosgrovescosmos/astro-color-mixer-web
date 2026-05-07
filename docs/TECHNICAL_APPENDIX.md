# Astro Color Mixer Technical Appendix

## Introduction

This appendix summarizes the practical processing model used by Astro Color Mixer Web. The tool is designed for nonlinear RGB astrophotography images and combines color-band selection, luminance-range masking, low-saturation handling, and sequential refinement behavior.

## Nonlinear RGB assumptions

Astro Color Mixer assumes:

- nonlinear RGB input
- normalized floating-point RGB working values in the range `0..1`
- preview is downsampled for interaction speed
- saved output renders from the full-resolution working image

It is not intended for linear calibration work.

## Luminance model

The luminance model is:

```text
Y = 0.2126 R + 0.7152 G + 0.0722 B
```

This luminance is used for:

- Range Mask
- preview diagnostics
- neutral luminance shaping
- dark and highlight protections

## Hue and saturation selection

Hue is treated as a circular quantity, and low saturation makes hue unreliable. Selection is therefore based on practical hue-band distance rather than linear color indexing.

## Practical color-band centers

- red `0°`
- orange `30°`
- yellow `60°`
- green `120°`
- cyan `180°`
- blue `240°`
- purple `275°`
- magenta `315°`

These are practical editing regions, not strict physical line classifications.

## Width and Feather

Selected Band behavior is shaped by:

- **Width** for the stronger hue span
- **Feather** for the falloff into neighboring hues

Conceptual form:

```text
distance = circularHueDistance(hue, center)
mask = 1 - smoothstep(innerWidth, outerWidth, distance)
```

## Range Mask formula

Range Mask limits pass influence by luminance:

```text
leftRamp = smoothstep(low - feather, low, Y)
rightRamp = 1 - smoothstep(high, high + feather, Y)
rangeMask = clamp01(leftRamp * rightRamp)
```

Low and High define the included interval. Feather softens both edges.

## Neutral / Low-Saturation model

For weak-color pixels:

```text
neutralMask = 1 - smoothstep(satStart, satFull, saturation)
```

This provides a luminance-focused path for gray or weak-color structures where hue is not stable enough for targeted hue editing.

## Chroma-vector adjustment concept

Astro Color Mixer uses a practical nonlinear RGB editing model:

- separate a luminance-like neutral component from chroma
- scale saturation by adjusting chroma magnitude
- shift hue by rotating chroma direction
- adjust luminance by changing the brightness component
- recombine and clamp back into valid RGB

This is a practical editing model, not a claim of exact physical color science.

## Refinement pass sequencing

Conceptually:

```text
working = original
for each enabled pass:
    working = applyPass(working, pass)
```

Standard workflow emphasizes broader single-pass work. Advanced workflow exposes targeted passes and Range Mask behavior more explicitly.

## Preview and downsample behavior

The interactive preview is downsampled for speed. Diagnostics such as histogram, polar plot, and probe are tied to preview-resolution behavior. Saved output renders from full-resolution data.

## TIFF considerations in the browser

TIFF support depends on browser-side image I/O code included with the app. Browser memory limits and local machine performance can affect:

- load time
- export time
- responsiveness on very large images

## Limitations

- not for linear calibration
- extreme changes can create artifacts
- preview is approximate
- hue is unreliable in neutral regions
- Range Mask meaning depends on the current stretch
- browser memory can limit very large image work
- TIFF support depends on browser-side format handling
