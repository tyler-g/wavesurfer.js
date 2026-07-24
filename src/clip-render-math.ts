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
