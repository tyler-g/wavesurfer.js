import { computeClipSampleWindow } from '../clip-render-math.js'

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
