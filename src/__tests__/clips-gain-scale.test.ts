/**
 * PIN (wavvy WVY-660): `ClipParams.gainScale` is a DRAW-TIME amplitude
 * multiplier. The three waveform draw primitives scale by it and clip the
 * drawn envelope at the box (±1, Ableton clip-view behavior); no peaks array
 * and no PCM is ever modified. `setGainScale` is the only writer, it nulls the
 * paint-state snapshot (otherwise the short-circuit swallows the repaint) and
 * a repeat call with the same value is a no-op (AudioTrack's sync effect calls
 * every setter on every fingerprint change).
 */
import ClipsPlugin from '../plugins/clips.js'

beforeAll(() => {
  // jsdom has no matchMedia; the resize handles' makeDraggable reads it.
  ;(globalThis as any).matchMedia = () => ({ matches: false })
})

type Call = { op: string; args: number[] }

function recordingCtx() {
  const calls: Call[] = []
  const rec =
    (op: string) =>
    (...args: any[]) =>
      calls.push({ op, args })
  return {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    stroke: rec('stroke'),
    fill: rec('fill'),
    arc: rec('arc'),
    clearRect: rec('clearRect'),
  } as any
}

function makeClip(extra: Record<string, any> = {}) {
  const plugin = ClipsPlugin.create()
  return plugin.addClip({ id: 'c1', startTime: 0, duration: 2, ...extra })
}

/** y offsets from the centerline of every lineTo the peaks primitive emitted. */
function peakOffsets(clip: any, ctx: any, peaks: number[], yCenter: number, yHalf: number) {
  clip.drawChannelPeaks(ctx, peaks, 100, yCenter, yHalf, '#fff')
  return ctx.calls
    .filter((c: Call) => c.op === 'lineTo')
    .map((c: Call) => Math.abs(c.args[1] - yCenter))
}

describe('ClipsPlugin gainScale (WVY-660)', () => {
  it('clips the drawn envelope at the box instead of overflowing it', () => {
    const clip = makeClip({ gainScale: 4 }) as any
    const ctx = recordingCtx()
    const offsets = peakOffsets(clip, ctx, [0.5], 50, 50)
    // 0.5 * 4 = 2.0 → clipped to 1 → exactly yHalfHeight, never 2x it.
    expect(offsets.length).toBeGreaterThan(0)
    for (const off of offsets) expect(off).toBeLessThanOrEqual(50)
    expect(Math.max(...offsets)).toBeCloseTo(50, 9)
  })

  it('scales below the box without clipping', () => {
    const clip = makeClip({ gainScale: 1.5 }) as any
    const ctx = recordingCtx()
    const offsets = peakOffsets(clip, ctx, [0.5], 50, 50)
    expect(Math.max(...offsets)).toBeCloseTo(0.75 * 50, 9)
  })

  it('omitted gainScale is the identity', () => {
    const clip = makeClip() as any
    const ctx = recordingCtx()
    const offsets = peakOffsets(clip, ctx, [0.5], 50, 50)
    expect(Math.max(...offsets)).toBeCloseTo(0.5 * 50, 9)
  })

  it('never mutates the peaks array it was handed', () => {
    const clip = makeClip({ gainScale: 4 }) as any
    const peaks = [0.5, 0.25]
    peakOffsets(clip, recordingCtx(), peaks, 50, 50)
    expect(peaks).toEqual([0.5, 0.25])
  })

  it.each([[NaN], [0], [-2], [Infinity]])('sanitizes gainScale %p to 1', (bad) => {
    const clip = makeClip({ gainScale: bad }) as any
    expect(clip.gainScale).toBe(1)
  })

  it('sample-line primitive clips the signed sample at both rails', () => {
    const clip = makeClip({ gainScale: 4 }) as any
    const ctx = recordingCtx()
    const channel = new Float32Array([0.5, -0.5, 0.1, -0.1])
    const before = Float32Array.from(channel)
    clip.drawChannelSampleLine(ctx, channel, 0, 4, 100, 50, 50)
    const ys = ctx.calls
      .filter((c: Call) => c.op === 'moveTo' || c.op === 'lineTo')
      .map((c: Call) => c.args[1])
    // ±1 clipped → 0 and 100; 0.1*4 = 0.4 → 50 ∓ 20 (Float32 rounding).
    expect(ys).toHaveLength(4)
    ;[0, 100, 30, 70].forEach((want, i) => expect(ys[i]).toBeCloseTo(want, 5))
    // The PCM channel is a live host reference — never written through.
    expect(Array.from(channel)).toEqual(Array.from(before))
  })

  it('setGainScale invalidates the paint state and no-ops on a repeat value', () => {
    const clip = makeClip() as any
    const renders = jest.fn()
    clip.renderWaveform = renders
    clip.lastPaintState = { sentinel: true }

    clip.setGainScale(2)
    expect(clip.gainScale).toBe(2)
    expect(clip.lastPaintState).toBeNull()
    expect(renders).toHaveBeenCalledTimes(1)

    clip.lastPaintState = { sentinel: true }
    clip.setGainScale(2)
    expect(clip.lastPaintState).toEqual({ sentinel: true })
    expect(renders).toHaveBeenCalledTimes(1)
  })

  it('setGainScale sanitizes a bad value back to 1', () => {
    const clip = makeClip({ gainScale: 2 }) as any
    clip.renderWaveform = jest.fn()
    clip.setGainScale(NaN)
    expect(clip.gainScale).toBe(1)
  })
})
