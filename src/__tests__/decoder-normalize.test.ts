import Decoder from '../decoder.js'

// jsdom has no AudioBuffer; createBuffer's fake buffer borrows its prototype methods
beforeAll(() => {
  ;(globalThis as any).AudioBuffer ??= class {
    copyFromChannel() {}
    copyToChannel() {}
  }
})

describe('Decoder.createBuffer normalization', () => {
  it('normalizes >1 peaks in place by default (legacy behavior)', () => {
    const data = new Float32Array([0.5, 2, -4])
    Decoder.createBuffer([data], 1)
    expect(Array.from(data)).toEqual([0.125, 0.5, -1])
  })

  it('skipNormalization leaves the caller array untouched', () => {
    // The record plugin re-wraps its LIVE dataWindow on every update tick;
    // in-place normalization would re-divide the same array each tick a peak
    // exceeds 1 (e.g. summed capture sources), eroding previously drawn
    // peaks by a different factor per tick phase — simultaneously recorded
    // tracks then render DIFFERENT waveforms from identical data.
    const data = new Float32Array([0.5, 2, -4])
    const buf = Decoder.createBuffer([data], 1, true)
    expect(Array.from(data)).toEqual([0.5, 2, -4])
    expect(buf.getChannelData(0)).toBe(data)
  })
})
