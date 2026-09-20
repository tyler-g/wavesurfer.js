/**
 * Pure math for mapping a clip canvas window to a PCM sample range.
 * Lives at src root (NOT src/plugins/ — rollup globs every top-level
 * plugins file as a default-export-only entry) so the mapping is
 * unit-testable without breaking the UMD build.
 */

export type ClipSampleWindowParams = {
  /** Length of the clip's PCM buffer (samples, one channel). */
  totalSamples: number
  /** Clip's current duration in seconds (changes live during a resize drag). */
  duration: number
  /** Sample rate of the PCM buffer; <= 0 when unknown. */
  sampleRate: number
  /** Full clip element width in CSS px. */
  clipWidthCss: number
  /** Canvas window position within the clip, CSS px. */
  canvasLeftCss: number
  canvasWidthCss: number
  /**
   * Optional drag-stable seconds-per-CSS-px (derived from the parent
   * timeline width). When provided, the pixel→sample mapping uses it
   * directly instead of span/clipWidthCss, so a given CSS position maps
   * to the same sample on every repaint while a resize drag changes the
   * clip's width — the revealed/cropped edge moves, the rest is still.
   */
  secPerCssPx?: number
  /**
   * Source-start offset in seconds (non-loop trim: the clip's left edge
   * corresponds to this position in the source PCM, not sample 0). The
   * whole canvas window shifts by this amount into the buffer.
   */
  sourceOffsetSec?: number
}

/**
 * In steady state the store keeps the PCM sliced to exactly the clip's
 * duration, so distributing all samples across the clip width is exact.
 * Mid-resize-drag the store hasn't re-sliced yet: a shrinking clip still
 * holds the longer buffer, and pure width-based mapping squeezes the whole
 * waveform into the shrinking width. Capping the span at duration-worth of
 * samples makes the waveform cut off at the drag edge instead — matching
 * the start-anchored truncation buildResizedPcm applies on drag end.
 *
 * When duration exceeds the buffer (re-extending mid-drag), the cap keeps
 * the span at the buffer length — same as legacy behavior; the store
 * materializes the extended audio on drag end.
 */
export function computeClipSampleWindow(
  params: ClipSampleWindowParams,
): { startSample: number; endSample: number } {
  const {
    totalSamples,
    duration,
    sampleRate,
    clipWidthCss,
    canvasLeftCss,
    canvasWidthCss,
    secPerCssPx,
    sourceOffsetSec,
  } = params

  const offsetSamples =
    sampleRate > 0 && sourceOffsetSec && sourceOffsetSec > 0
      ? Math.round(sourceOffsetSec * sampleRate)
      : 0
  const availableSamples = Math.max(0, totalSamples - offsetSamples)
  const durationSamples =
    sampleRate > 0 && duration > 0
      ? Math.round(duration * sampleRate)
      : availableSamples
  const spanSamples = Math.min(availableSamples, durationSamples)
  const samplesPerCssPx =
    secPerCssPx && secPerCssPx > 0 && sampleRate > 0 && spanSamples > 0
      ? sampleRate * secPerCssPx
      : spanSamples > 0 && clipWidthCss > 0
        ? spanSamples / clipWidthCss
        : 0

  const rawStart = Math.floor(canvasLeftCss * samplesPerCssPx) + offsetSamples
  const rawEnd =
    Math.ceil((canvasLeftCss + canvasWidthCss) * samplesPerCssPx) +
    offsetSamples

  // Clamp at the content-window boundary. The buffer may be LONGER than
  // the clip (host passes full-length source PCM so extend drags can
  // reveal trimmed content on either side) — samples outside
  // [offset, offset + duration] exist but are outside the clip and must
  // never paint.
  const endBound = offsetSamples + spanSamples
  return {
    startSample: Math.max(0, Math.min(rawStart, endBound)),
    endSample: Math.max(0, Math.min(rawEnd, endBound)),
  }
}

export type ContentPixelWidthParams = {
  /** Clip's current duration in seconds (changes live during a resize drag). */
  duration: number
  /** Width of the clips container (the timeline) in CSS px. */
  parentWidthCss: number
  /** Total timeline duration in seconds; <= 0 when unknown. */
  totalDuration: number
  /** Device pixel ratio (>= 1). */
  dpr: number
  /** Fallback clip CSS width when the timeline scale is unavailable. */
  fallbackClipWidthCss?: number
}

/**
 * Geometry for a custom-content (renderContent) clip canvas.
 *
 * `contentW` is the clip's content width in device pixels, deliberately
 * UNROUNDED: content renderers position marks as fractions of this width
 * (x = t/duration * contentW), so any rounding here changes the
 * time→pixel scale by up to ±0.5px — and because `duration` sweeps
 * continuously during a resize drag while the rounding steps discretely,
 * every painted mark trembles sub-pixel from frame to frame. Keeping the
 * scale exact makes a mark at a fixed time land on the same pixel every
 * repaint. The canvas BITMAP must still have integer dimensions —
 * `bitmapW` is the rounded width for that; content drawn past it (< 1px
 * at the drag edge) is simply cropped.
 */
export function computeContentPixelWidth(params: ContentPixelWidthParams): {
  contentW: number
  bitmapW: number
} {
  const { duration, parentWidthCss, totalDuration, dpr } = params
  const pxPerSec = totalDuration > 0 ? parentWidthCss / totalDuration : 0
  const contentCssW =
    pxPerSec > 0 ? duration * pxPerSec : (params.fallbackClipWidthCss ?? 1)
  const contentW = Math.max(1, contentCssW * dpr)
  return { contentW, bitmapW: Math.max(1, Math.round(contentW)) }
}

/**
 * Time↔pixel mapping of a WINDOWED custom-content (renderContent) canvas.
 * Passed to `ClipRenderFn` as its 5th argument when the clip opted in via
 * `contentWindowed` (WVY-87). Renderers map clip-relative time to canvas
 * device px as `x = (t - startSec) * pxPerSecDevice` and must ignore the
 * legacy `contentW` argument (which still describes the FULL clip).
 */
export type ClipContentWindow = {
  /** Clip-relative time (s) at canvas x = 0. Negative during a left-edge
   *  resize drag (the window extends left of the clip origin). */
  startSec: number
  /** Clip-relative time (s) at canvas x = bitmapW. */
  endSec: number
  /** Device px per second — EXACT and UNROUNDED (the time→pixel scale). */
  pxPerSecDevice: number
  /** Integer bitmap width in device px. */
  bitmapW: number
}

export type ContentWindowParams = {
  /** Clip's timeline start (s). */
  clipStartTime: number
  /** Raw (unquantized) canvas window within the clip element, CSS px.
   *  `canvasLeftCss` may be negative (left-edge drag lead-in). */
  canvasLeftCss: number
  canvasWidthCss: number
  /** Drag-stable CSS px per second (parent timeline width / total duration). */
  pxPerSecCss: number
  /** Device pixel ratio (>= 1). */
  dpr: number
}

/**
 * Quantize a content-clip canvas window and derive its time mapping.
 *
 * The window POSITION is quantized on the TIMELINE device-pixel grid
 * (clip timeline position + window offset), NOT clip-relative — the same
 * law the PCM path follows (see clips.ts renderWaveform). The clip origin
 * sits at a fractional layout position and moves fractionally during a
 * left-edge drag; rounding in clip coordinates would re-phase every mark's
 * antialiasing per repaint. On the timeline grid, two repaints of the same
 * content are pixel-identical or exact whole-device-pixel translations.
 *
 * `pxPerSecDevice` is deliberately unrounded (same reasoning as
 * `computeContentPixelWidth`): the scale must be exact so a mark at a fixed
 * time lands on the same pixel every repaint.
 */
export function computeContentWindow(
  params: ContentWindowParams,
): ClipContentWindow & { canvasLeftCss: number; canvasWidthCss: number } {
  const { clipStartTime, pxPerSecCss, dpr } = params
  const clipTimelineLeftCss = clipStartTime * pxPerSecCss
  const timelineBase = clipTimelineLeftCss + params.canvasLeftCss
  const canvasLeftCss =
    Math.round(timelineBase * dpr) / dpr - clipTimelineLeftCss
  const canvasWidthCss = Math.round(params.canvasWidthCss * dpr) / dpr
  const bitmapW = Math.max(1, Math.round(canvasWidthCss * dpr))
  const pxPerSecDevice = pxPerSecCss * dpr
  const startSec = canvasLeftCss / pxPerSecCss
  const endSec = startSec + bitmapW / pxPerSecDevice
  return { startSec, endSec, pxPerSecDevice, bitmapW, canvasLeftCss, canvasWidthCss }
}

/**
 * Apply a draw-time gain multiplier to a normalized sample/peak magnitude and
 * clip it at the box (±1) — Ableton clip-view behavior: a boosted waveform
 * flattens against the top and bottom of the clip instead of overflowing it.
 * Draw-time ONLY: peaks/PCM arrays are never modified (they feed the host's
 * merge fingerprints and saved state).
 */
export function applyGainClip(v: number, gainScale: number): number {
  const s = v * gainScale
  return s > 1 ? 1 : s < -1 ? -1 : s
}

/**
 * Positive-modulo wrap of a (phase-shifted) clip time into a loop tile:
 * returns tileT in [0, loopLen). Guards the floating-point edge where
 * `shifted` sits within one ulp BELOW zero (or below a tile multiple) and
 * the mod subtraction lands EXACTLY on loopLen — callers that step by the
 * remaining tile (`loopLen − tileT`) would otherwise make a zero-progress
 * step and hang (this is reachable: left-edge resize drags paint canvas
 * windows at negative clip times).
 */
export function wrapTileTime(shifted: number, loopLen: number): number {
  let tileT = shifted - Math.floor(shifted / loopLen) * loopLen
  if (tileT < 0) tileT += loopLen
  if (tileT >= loopLen) tileT = 0
  return tileT
}

/**
 * Clip-relative times (seconds) of loop wrap points ("seams") inside
 * [windowStart, windowEnd] ∩ (0, duration). A seam sits wherever the
 * tiled playback wraps: t = k·loopLen − (phase mod loopLen), k ≥ 1.
 * Pass the DRAG-COMPENSATED phase (paintPhaseSec) so seams stay
 * timeline-anchored while a left-edge resize is in progress.
 */
export function computeLoopSeamTimes(
  duration: number,
  loopLen: number,
  phaseInLoop: number,
  windowStart: number,
  windowEnd: number,
): number[] {
  if (!(loopLen > 0) || !(duration > 0)) return []
  const phi = ((phaseInLoop % loopLen) + loopLen) % loopLen
  const lo = Math.max(1e-9, windowStart)
  const hi = Math.min(duration - 1e-9, windowEnd)
  if (hi <= lo) return []
  const seams: number[] = []
  let k = Math.max(1, Math.ceil((lo + phi) / loopLen))
  for (; k * loopLen - phi <= hi; k++) {
    const t = k * loopLen - phi
    if (t >= lo) seams.push(t)
    if (seams.length >= 5000) break
  }
  return seams
}

/**
 * Magnetic snap onto a regular grid `m·step + offset` (any integer m).
 * Returns the snapped value when the candidate is within thresholdSec of
 * a grid point, else null. Used to snap resize-drag edges onto loop
 * seams — deliberately independent of the host's snap-to-grid setting.
 */
export function snapToGridPoint(
  candidate: number,
  step: number,
  offset: number,
  thresholdSec: number,
): number | null {
  if (!(step > 0) || !(thresholdSec >= 0)) return null
  const m = Math.round((candidate - offset) / step)
  const snapped = m * step + offset
  return Math.abs(snapped - candidate) <= thresholdSec ? snapped : null
}
