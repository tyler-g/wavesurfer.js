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

## Project duration lift

`WebAudioPlayer.setProjectDuration(seconds)` lifts the player's logical `duration` to `max(real audio duration, projectDuration)`. Wavesurfer propagates it automatically from `setOptions({ projectDuration })` and at the end of every `loadAudio` (`propagateProjectDuration()`) — hosts never call it directly.

**Propagation-order invariant (2026-08-12)**: in `setOptions`, `propagateProjectDuration()` must run **BEFORE** `renderer.setOptions(...)`. The renderer re-render synchronously emits `render` → wavesurfer re-emits `redraw`, and redraw listeners (TimelinePlugin gridline layout) read `getEffectiveDuration()` = `max(getDuration(), options.projectDuration)`. With a stale player lift, a projectDuration **shrink** (e.g. Wavvy's post-recording shrink-back) makes that read return the old larger duration while the wrapper is already sized for the new one — gridlines lay out at a compressed px-per-sec and stay misaligned until the next redraw (zoom). Regression test: `src/__tests__/project-duration-propagation.test.ts`. This is what lets a track whose buffer (e.g. Wavvy's silent placeholder) is shorter than the project keep advancing `currentTime`, not self-pause at the buffer end, and accept play/seek positions up to the timeline end. Rationale + host-side rules: wavvy's `docs/architecture/master-transport.md` ("Project duration lift").

**Renderer data-extent invariant**: waveform data is drawn at `audioDuration × pxPerSec`, never stretched across the (wider) projectDuration-based wrapper. `render` / `renderMultiCanvas` / `renderUpdate` all slice channel data against `dataWidth`/`dataTotal`, boundary tiles are drawn narrower, and tiles beyond the audio collapse to width 0. Do not reintroduce `offset / totalWidth` slicing — it draws the live-recording waveform ahead of the cursor whenever the project outgrows the recording buffer.

**Lift-feedback trap**: code that wants the *audio's* duration must use `getDecodedData()?.duration`, not `getDuration()` (lifted). `record.ts` `processPcmData` clip-mode cleanup does this; so does wavvy's `updateProjectDuration`.

## Decoder normalization is IN-PLACE

`Decoder.createBuffer` normalizes >1 peaks by MUTATING the caller's arrays. Never feed it a live, long-lived buffer without `skipNormalization = true` (third arg) or a copy — `updatePeaks` passes the record plugin's live `dataWindow` every 10ms tick, and repeated in-place normalization eroded drawn peaks by a different factor per tick phase (same-input recording tracks rendered different waveforms from identical data; fixed 2026-08-30). Guard: `src/__tests__/decoder-normalize.test.ts`.

## RecordPlugin capture anchor

`setCaptureAnchor(ctxTime)` anchors a take to the AudioContext clock: merged PCM (`src/record-align.ts` `mergeChunksToAnchor`) is trimmed/padded so sample 0 ≡ the anchor, and the live-waveform edge + duration clock derive from `ctx.currentTime − anchor` instead of wall-clock timers. `pushPcmChunk(chunk, startCtxTime?)` carries the chunk's audio-clock timestamp. `startRecording()` clears the anchor — hosts set it per take, AFTER startRecording, once the transport's `playAt` time is known. In anchored mode the live waveform is drawn from the timestamped chunks (`accumulateChunkPeaks`), NOT the analyser — same-input recorders render identical waveforms. The `expectCaptureAnchor` option holds elapsed/waveform at 0 until the anchor lands (no wall-clock snap-back in the pre-anchor window). This is what keeps simultaneously recorded wavvy tracks sample-aligned; see wavvy's `docs/architecture/master-transport.md` "Recording capture anchor".

## TimelinePlugin

Has a `gridSubdivision` option and `setGridSubdivision()` method for variable grid density — used by Wavvy's per-track gridlines. Gridlines/notches are laid out in **absolute px** once per `redraw` event, at `wrapper.scrollWidth / getEffectiveDuration()` — they do NOT track later width/duration changes, so anything that changes either value must end in a redraw that fires with both already consistent (see "Propagation-order invariant" above).

## ClipsPlugin drag ghost

Body drags are Ableton-style (since 2026-07-25): the clip element stays put and a translucent clone (`.ws-clip-ghost`, canvas bitmaps blitted once at drag start) tracks the pointer — snapped to the grid when the host's `setSnapConfig` is enabled — committing on release. Continuous `clip-drag` plugin event fires per pointer move; `clip-drag-end` still sees the final `startTime` on the block. Public per-clip API `showDragGhost(t)` / `hideDragGhost()` + readable `dragTargetTime` let the host preview group moves on non-dragged clips. Details: wavvy's `docs/architecture/clip-rendering.md` "Body-drag ghost".

## Notes

- See `AGENTS.md` in this dir for guidance targeting other AI agents (Codex, Gemini, etc.).
- This file is the Claude Code equivalent.
