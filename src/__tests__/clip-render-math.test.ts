import {
  computeClipSampleWindow,
  computeContentPixelWidth,
  computeLoopSeamTimes,
  snapToGridPoint,
  wrapTileTime,
} from '../clip-render-math.js'

describe('computeClipSampleWindow', () => {
  const sr = 44100

  test('steady state: PCM spans exactly the clip duration → full buffer maps across the clip width', () => {
    const totalSamples = 5 * sr
    const { startSample, endSample } = computeClipSampleWindow({
      totalSamples,
      duration: 5,
      sampleRate: sr,
      clipWidthCss: 1000,
      canvasLeftCss: 0,
      canvasWidthCss: 1000,
    })
    expect(startSample).toBe(0)
    expect(endSample).toBe(totalSamples)
  })

  test('shrink mid-drag: duration shorter than PCM → span capped at duration-worth of samples (cut off, not squish)', () => {
    // 5s buffer, clip dragged down to 3s. The full clip width must map to
    // the FIRST 3s of samples — matching buildResizedPcm's start-anchored
    // truncation on drag end — not squeeze all 5s into the width.
    const totalSamples = 5 * sr
    const { startSample, endSample } = computeClipSampleWindow({
      totalSamples,
      duration: 3,
      sampleRate: sr,
      clipWidthCss: 600,
      canvasLeftCss: 0,
      canvasWidthCss: 600,
    })
    expect(startSample).toBe(0)
    expect(endSample).toBe(3 * sr)
  })

  test('shrink mid-drag: windowed canvas maps proportionally within the capped span', () => {
    const totalSamples = 5 * sr
    const { startSample, endSample } = computeClipSampleWindow({
      totalSamples,
      duration: 3,
      sampleRate: sr,
      clipWidthCss: 600,
      canvasLeftCss: 300, // second half of the clip
      canvasWidthCss: 300,
    })
    expect(startSample).toBe(1.5 * sr)
    expect(endSample).toBe(3 * sr)
  })

  test('extend mid-drag: duration longer than PCM → span stays capped at the buffer (unchanged legacy behavior)', () => {
    const totalSamples = 4 * sr
    const { endSample } = computeClipSampleWindow({
      totalSamples,
      duration: 6,
      sampleRate: sr,
      clipWidthCss: 1200,
      canvasLeftCss: 0,
      canvasWidthCss: 1200,
    })
    expect(endSample).toBe(totalSamples)
  })

  test('unknown sample rate falls back to width-based mapping of the full buffer', () => {
    const totalSamples = 5 * sr
    const { startSample, endSample } = computeClipSampleWindow({
      totalSamples,
      duration: 3,
      sampleRate: 0,
      clipWidthCss: 1000,
      canvasLeftCss: 250,
      canvasWidthCss: 500,
    })
    expect(startSample).toBe(totalSamples * 0.25)
    expect(endSample).toBe(totalSamples * 0.75)
  })

  test('full-length PCM + shrunk clip: window clamps at the duration boundary (no tail bleed)', () => {
    // Clip shrunk to 3s but PCM holds the full 5s source (host passes
    // un-truncated effective PCM). A canvas slightly wider than the clip
    // must not map past duration-worth of samples — the trimmed tail
    // exists in the buffer but is outside the clip.
    const totalSamples = 5 * sr
    const secPerCssPx = 3 / 600 // 3s clip over 600 CSS px
    const { startSample, endSample } = computeClipSampleWindow({
      totalSamples,
      duration: 3,
      sampleRate: sr,
      clipWidthCss: 600,
      canvasLeftCss: 0,
      canvasWidthCss: 610, // extends past the clip edge
      secPerCssPx,
    })
    expect(startSample).toBe(0)
    expect(endSample).toBe(3 * sr)
  })

  test('stable secPerCssPx: same pixel maps to the same sample as the clip extends', () => {
    // Extend drag on a shrunk clip (5s source, currently 3s → 4s). With
    // the stable coefficient, the sample under a given CSS position must
    // not change as duration/width grow — the tail reveals, the rest is
    // pixel-still.
    const totalSamples = 5 * sr
    const secPerCssPx = 1 / 200 // constant zoom: 200 px per second
    const at3s = computeClipSampleWindow({
      totalSamples,
      duration: 3,
      sampleRate: sr,
      clipWidthCss: 600,
      canvasLeftCss: 100,
      canvasWidthCss: 400,
      secPerCssPx,
    })
    const at4s = computeClipSampleWindow({
      totalSamples,
      duration: 4,
      sampleRate: sr,
      clipWidthCss: 800,
      canvasLeftCss: 100,
      canvasWidthCss: 400,
      secPerCssPx,
    })
    expect(at4s.startSample).toBe(at3s.startSample)
    expect(at4s.endSample).toBe(at3s.endSample)
  })

  test('sourceOffsetSec: 0 (or omitted) behaves identically to the no-offset call', () => {
    const totalSamples = 5 * sr
    const base = {
      totalSamples,
      duration: 3,
      sampleRate: sr,
      clipWidthCss: 600,
      canvasLeftCss: 100,
      canvasWidthCss: 300,
    }
    const withoutOffset = computeClipSampleWindow(base)
    const withZeroOffset = computeClipSampleWindow({ ...base, sourceOffsetSec: 0 })
    expect(withZeroOffset).toEqual(withoutOffset)
  })

  test('sourceOffsetSec shifts start/end by offsetSamples; full clip width reaches endBound = offset + span', () => {
    // 10s buffer, but the clip is a 3s trim starting 2s into the source
    // (non-loop trim mode — loopPhaseSec doubles as this offset). The full
    // clip width must map to exactly [offset, offset + span) of the buffer.
    const totalSamples = 10 * sr
    const offsetSec = 2
    const { startSample, endSample } = computeClipSampleWindow({
      totalSamples,
      duration: 3,
      sampleRate: sr,
      clipWidthCss: 600,
      canvasLeftCss: 0,
      canvasWidthCss: 600,
      sourceOffsetSec: offsetSec,
    })
    const offsetSamples = offsetSec * sr
    expect(startSample).toBe(offsetSamples)
    expect(endSample).toBe(offsetSamples + 3 * sr) // endBound = offset + span
  })

  test('sourceOffsetSec: window clamps at offset + duration when the buffer extends further', () => {
    // Buffer holds far more than the trimmed window (10s), and the canvas
    // window is wider than the clip (mirrors the "full-length PCM + shrunk
    // clip" clamp test above). The trimmed tail beyond offset + duration
    // must never paint, regardless of how much more buffer exists.
    const totalSamples = 10 * sr
    const offsetSec = 2
    const secPerCssPx = 3 / 600 // 3s clip over 600 CSS px
    const { startSample, endSample } = computeClipSampleWindow({
      totalSamples,
      duration: 3,
      sampleRate: sr,
      clipWidthCss: 600,
      canvasLeftCss: 0,
      canvasWidthCss: 610, // extends past the clip edge
      secPerCssPx,
      sourceOffsetSec: offsetSec,
    })
    expect(startSample).toBe(offsetSec * sr)
    expect(endSample).toBe((offsetSec + 3) * sr)
  })

  test('degenerate inputs produce an empty window', () => {
    expect(
      computeClipSampleWindow({
        totalSamples: 0,
        duration: 3,
        sampleRate: sr,
        clipWidthCss: 600,
        canvasLeftCss: 0,
        canvasWidthCss: 600,
      }),
    ).toEqual({ startSample: 0, endSample: 0 })
    expect(
      computeClipSampleWindow({
        totalSamples: 5 * sr,
        duration: 3,
        sampleRate: sr,
        clipWidthCss: 0,
        canvasLeftCss: 0,
        canvasWidthCss: 0,
      }),
    ).toEqual({ startSample: 0, endSample: 0 })
  })
})

describe('computeContentPixelWidth', () => {
  test('content width is UNROUNDED so the time→pixel scale is drag-stable', () => {
    // Simulate a resize drag: duration sweeps continuously. A note at a
    // fixed time inside the clip must land on the same pixel every frame:
    // x = (tSec / duration) * contentW must be exactly tSec * pxPerSec * dpr.
    const parentWidthCss = 8000
    const totalDuration = 60
    const dpr = 2
    const pxPerSec = parentWidthCss / totalDuration
    const tSec = 3.123
    for (let duration = 4; duration < 6; duration += 0.0137) {
      const { contentW } = computeContentPixelWidth({
        duration,
        parentWidthCss,
        totalDuration,
        dpr,
      })
      const x = (tSec / duration) * contentW
      expect(x).toBeCloseTo(tSec * pxPerSec * dpr, 6)
    }
  })

  test('bitmap width is the rounded content width (min 1)', () => {
    const { contentW, bitmapW } = computeContentPixelWidth({
      duration: 4.567,
      parentWidthCss: 1000,
      totalDuration: 60,
      dpr: 2,
    })
    expect(bitmapW).toBe(Math.max(1, Math.round(contentW)))
  })

  test('degenerate total duration falls back to the clip CSS width', () => {
    const { contentW, bitmapW } = computeContentPixelWidth({
      duration: 4,
      parentWidthCss: 1000,
      totalDuration: 0,
      dpr: 2,
      fallbackClipWidthCss: 320,
    })
    expect(contentW).toBe(640)
    expect(bitmapW).toBe(640)
  })
})

describe('wrapTileTime', () => {
  test('wraps into [0, loopLen) for positive, negative, and zero inputs', () => {
    expect(wrapTileTime(0, 2)).toBe(0)
    expect(wrapTileTime(0.5, 2)).toBe(0.5)
    expect(wrapTileTime(3.5, 2)).toBeCloseTo(1.5, 12)
    expect(wrapTileTime(-0.5, 2)).toBeCloseTo(1.5, 12)
    expect(wrapTileTime(-3.5, 2)).toBeCloseTo(0.5, 12)
  })

  test('FP ulp-below-zero input never returns loopLen (tile-walker hang guard)', () => {
    // -1e-17 + 2 rounds to exactly 2.0 in IEEE754 — the naive positive
    // modulo returns loopLen itself, and a tile walker stepping by
    // (loopLen - tileT) makes zero progress forever.
    const t = wrapTileTime(-1e-17, 2)
    expect(t).toBeGreaterThanOrEqual(0)
    expect(t).toBeLessThan(2)
    for (const shifted of [-1e-17, -1e-300, -4.9e-324, 2 - 1e-17, 6 - 1e-16]) {
      const w = wrapTileTime(shifted, 2)
      expect(w).toBeGreaterThanOrEqual(0)
      expect(w).toBeLessThan(2)
    }
  })
})

describe('computeLoopSeamTimes', () => {
  test('phase 0: seams at every loopLen multiple inside the clip', () => {
    expect(computeLoopSeamTimes(5, 2, 0, 0, 5)).toEqual([2, 4])
  })

  test('phase shifts seams left; seams outside (0, duration) excluded', () => {
    expect(computeLoopSeamTimes(5, 2, 0.5, 0, 5)).toEqual([1.5, 3.5])
    // phase ≥ loopLen wraps
    expect(computeLoopSeamTimes(5, 2, 2.5, 0, 5)).toEqual([1.5, 3.5])
    // negative (drag-compensated) phase wraps too
    expect(computeLoopSeamTimes(5, 2, -0.5, 0, 5)[0]).toBeCloseTo(0.5, 9)
  })

  test('window restricts the seam range (viewport-windowed canvases)', () => {
    expect(computeLoopSeamTimes(100, 2, 0, 10, 14)).toEqual([10, 12, 14])
  })

  test('degenerate inputs return no seams', () => {
    expect(computeLoopSeamTimes(5, 0, 0, 0, 5)).toEqual([])
    expect(computeLoopSeamTimes(1.5, 2, 0, 0, 1.5)).toEqual([])
  })
})

describe('snapToGridPoint', () => {
  test('snaps within threshold, in both directions', () => {
    expect(snapToGridPoint(3.93, 2, -0.5, 0.1)).toBeNull()
    expect(snapToGridPoint(3.45, 2, -0.5, 0.1)).toBeCloseTo(3.5, 9)
    expect(snapToGridPoint(3.56, 2, -0.5, 0.1)).toBeCloseTo(3.5, 9)
  })

  test('negative grid indices work (left-extend past the clip start)', () => {
    // grid offset 10 − φ' with step 2: points …, 6, 8, 10
    expect(snapToGridPoint(6.05, 2, 10, 0.1)).toBeCloseTo(6, 9)
  })

  test('degenerate step never snaps', () => {
    expect(snapToGridPoint(1, 0, 0, 0.5)).toBeNull()
  })
})
