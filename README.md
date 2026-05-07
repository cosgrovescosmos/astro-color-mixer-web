# Astro Color Mixer Web

Version:
v0.9.3-beta

Description:
Astro Color Mixer is a browser-based nonlinear RGB color and luminance refinement tool for astrophotography.

Hosting:
This folder is designed for static hosting on GitHub Pages.

Required files:
- `index.html`
- `app.css`
- `analysis.css`
- `app.js`
- `core-web-bridge.js`
- `color-math.js`
- `image-io.js`
- `image-io-tiff.js`
- `presets.js`
- `assets/logo.webp`

Squarespace embed:
Use an iframe pointing to the GitHub Pages URL.

Example:
```html
<iframe src="https://cosgrovescosmos.github.io/astro-color-mixer-web/" title="Astro Color Mixer"></iframe>
```

Notes:
- Runs client-side in the browser.
- No image data is uploaded to a server.
- TIFF support depends on included browser-side TIFF I/O code.
- Large images may be memory-intensive.
