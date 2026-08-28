# university-memories

Vanilla HTML/CSS/JavaScript graduation memory archive with an optional Three.js Memory Universe.

## Source and generated files

- `index.html` is the source of truth for the main archive.
- `universe.html`, `assets/css/universe.css`, and `assets/js/universe.js` are the source files for Memory Universe.
- `scripts/process-images.mjs` generates the archive WebPs, 384px Universe textures, `public/data.json`, and all deployable HTML/CSS/JS/vendor files.
- `public/` is generated output for Express and GitHub Pages; do not edit its generated copies directly.

Run the complete build with:

```powershell
npm.cmd run build
```

Memory Universe uses the official `three` npm package. The build copies its browser ES module to `public/vendor/three.module.js`, so the deployed experience does not depend on a runtime CDN.
