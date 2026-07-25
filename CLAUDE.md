# wavesurfer.js (Wavvy's local fork)

Local fork of wavesurfer.js used by the Wavvy DAW. Globally npm-linked (not listed in wavvy's `package.json`).

## Link workflow

1. `cd wavesurfer.js && npm link` (once)
2. `cd ../wavvy && npm link wavesurfer.js` (once)

## Rebuild workflow

**Whenever any source files in this directory change:**

1. `npm run build` (in this dir)
2. `rm -rf ../wavvy/node_modules/.vite` (clear Vite cache)
3. Restart the Wavvy dev server

Skipping any of these causes stale code to be served to the browser.

## Build constraints

**Rollup CJS/UMD builds use `exports: 'default'`** — do not add named exports to `wavesurfer.ts` or the build will fail. Export new utilities from their own module files instead.

## Shadow DOM

WaveSurfer renders inside a shadow root (`src/renderer.ts`). External CSS **cannot** reach clip elements — styles must go in the shadow DOM `<style>` block inside `renderer.ts`.

- Clip elements have `class="ws-clip"`.
- **Clip frame uses `outline` with `outline-offset: -2px` (not `border`)** — zero layout impact, so the clip's inner canvas isn't offset from the wrapper top and the waveform centerline aligns with WaveSurfer's own canvases. Do not reintroduce a border on `.ws-clip`.

## TimelinePlugin

Has a `gridSubdivision` option and `setGridSubdivision()` method for variable grid density — used by Wavvy's per-track gridlines.

## ClipsPlugin drag ghost

Body drags are Ableton-style (since 2026-07-25): the clip element stays put and a translucent clone (`.ws-clip-ghost`, canvas bitmaps blitted once at drag start) tracks the pointer — snapped to the grid when the host's `setSnapConfig` is enabled — committing on release. Continuous `clip-drag` plugin event fires per pointer move; `clip-drag-end` still sees the final `startTime` on the block. Public per-clip API `showDragGhost(t)` / `hideDragGhost()` + readable `dragTargetTime` let the host preview group moves on non-dragged clips. Details: wavvy's `docs/architecture/clip-rendering.md` "Body-drag ghost".

## Notes

- See `AGENTS.md` in this dir for guidance targeting other AI agents (Codex, Gemini, etc.).
- This file is the Claude Code equivalent.
