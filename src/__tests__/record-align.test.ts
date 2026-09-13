import { mergeChunksToAnchor, accumulateChunkPeaks, compensationTrimFrames, TimedPcmChunk } from '../record-align.js'

/** Build a mono chunk of sequential values starting at `startValue`. */
function seq(startValue: number, length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => startValue + i)
}

describe('mergeChunksToAnchor', () => {
  const sampleRate = 100 // 1 frame = 10ms — keeps expected indices readable

  it('concatenates as-is when no anchor is set (legacy path)', () => {
    const chunks: TimedPcmChunk[] = [{ data: seq(0, 4) }, { data: seq(4, 4) }]
    const merged = mergeChunksToAnchor(chunks, null, sampleRate, 1)
    expect(Array.from(merged)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('concatenates as-is when chunks are untimed even with an anchor (fallback)', () => {
    const chunks: TimedPcmChunk[] = [{ data: seq(0, 4) }, { data: seq(4, 4) }]
    const merged = mergeChunksToAnchor(chunks, 0.02, sampleRate, 1)
    expect(Array.from(merged)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('drops chunks that end before the anchor and trims the straddling chunk', () => {
    const chunks: TimedPcmChunk[] = [
      { data: seq(0, 10), time: 0 }, // covers [0, 0.1) — fully before anchor
      { data: seq(10, 10), time: 0.1 }, // covers [0.1, 0.2) — anchor lands mid-chunk
      { data: seq(20, 10), time: 0.2 },
    ]
    const merged = mergeChunksToAnchor(chunks, 0.15, sampleRate, 1)
    // First 5 frames of the straddling chunk trimmed: merged starts at sample value 15
    expect(Array.from(merged)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29])
  })

  it('keeps a chunk whole when it starts exactly at the anchor', () => {
    const chunks: TimedPcmChunk[] = [
      { data: seq(0, 10), time: 0 },
      { data: seq(10, 10), time: 0.1 },
    ]
    const merged = mergeChunksToAnchor(chunks, 0.1, sampleRate, 1)
    expect(Array.from(merged)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
  })

  it('trims interleaved stereo chunks in whole frames', () => {
    // 4 frames of stereo: L=frame index, R=frame index + 100
    const stereo = (startFrame: number, frames: number) => {
      const out = new Float32Array(frames * 2)
      for (let i = 0; i < frames; i++) {
        out[i * 2] = startFrame + i
        out[i * 2 + 1] = startFrame + i + 100
      }
      return out
    }
    const chunks: TimedPcmChunk[] = [
      { data: stereo(0, 4), time: 0 }, // [0, 0.04)
      { data: stereo(4, 4), time: 0.04 },
    ]
    const merged = mergeChunksToAnchor(chunks, 0.02, sampleRate, 2)
    // Anchor at frame 2 — L/R pairs stay together from frame 2 on
    expect(Array.from(merged)).toEqual([2, 102, 3, 103, 4, 104, 5, 105, 6, 106, 7, 107])
  })

  it('zero-pads the head when the first chunk starts after the anchor', () => {
    const chunks: TimedPcmChunk[] = [{ data: seq(1, 5), time: 0.05 }]
    const merged = mergeChunksToAnchor(chunks, 0, sampleRate, 1)
    expect(Array.from(merged)).toEqual([0, 0, 0, 0, 0, 1, 2, 3, 4, 5])
  })

  it('returns empty when every chunk ends before the anchor', () => {
    const chunks: TimedPcmChunk[] = [{ data: seq(0, 10), time: 0 }]
    const merged = mergeChunksToAnchor(chunks, 0.5, sampleRate, 1)
    expect(merged.length).toBe(0)
  })
})

describe('accumulateChunkPeaks', () => {
  // sampleRate 100, fps 10 → 10 frames per peak cell — readable indices
  const base = { anchorSec: 1, baseIdx: 5, sampleRate: 100, channels: 1, fps: 10 }

  it('writes per-cell max amplitudes starting at baseIdx for a chunk at the anchor', () => {
    // 20 frames: first 10 peak at 0.5, next 10 peak at 0.9
    const data = new Float32Array(20)
    data[3] = 0.5
    data[14] = -0.75
    const res = accumulateChunkPeaks({
      dataWindow: new Float32Array(10),
      chunks: [{ data, time: 1 }],
      fromChunk: 0,
      ...base,
    })
    expect(res.nextChunk).toBe(1)
    expect(res.maxCellWritten).toBe(6)
    expect(Array.from(res.dataWindow.slice(4, 8))).toEqual([0, 0.5, 0.75, 0])
  })

  it('skips frames before the anchor and starts a straddling chunk at baseIdx', () => {
    // Chunk starts 0.05s (5 frames) before the anchor: frames 0-4 pre-anchor
    const data = new Float32Array(15)
    data[2] = 0.75 // pre-anchor — must not land anywhere
    data[7] = 0.5 // 2 frames after anchor → cell baseIdx
    const res = accumulateChunkPeaks({
      dataWindow: new Float32Array(10),
      chunks: [{ data, time: 0.95 }],
      fromChunk: 0,
      ...base,
    })
    expect(res.dataWindow[4]).toBe(0)
    expect(res.dataWindow[5]).toBe(0.5)
  })

  it('takes the max across interleaved channels', () => {
    const data = new Float32Array([0.125, -0.75, 0.25, 0.375]) // 2 frames of stereo
    const res = accumulateChunkPeaks({
      dataWindow: new Float32Array(10),
      chunks: [{ data, time: 1 }],
      fromChunk: 0,
      ...base,
      channels: 2,
    })
    expect(res.dataWindow[5]).toBe(0.75)
  })

  it('grows the window when cells land beyond its length', () => {
    const data = new Float32Array(10)
    data[0] = 0.25
    const res = accumulateChunkPeaks({
      dataWindow: new Float32Array(8),
      chunks: [{ data, time: 2 }], // 1s after anchor → cell baseIdx + 10 = 15
      fromChunk: 0,
      ...base,
    })
    expect(res.dataWindow.length).toBeGreaterThanOrEqual(16)
    expect(res.dataWindow[15]).toBe(0.25)
  })

  it('resumes from fromChunk and merges maxima into existing cells', () => {
    const c1 = new Float32Array(10)
    c1[0] = 0.5
    const c2 = new Float32Array(10)
    c2[0] = 0.25
    const win = new Float32Array(10)
    const r1 = accumulateChunkPeaks({ dataWindow: win, chunks: [{ data: c1, time: 1 }], fromChunk: 0, ...base })
    const r2 = accumulateChunkPeaks({
      dataWindow: r1.dataWindow,
      chunks: [{ data: c1, time: 1 }, { data: c2, time: 1.05 }], // second half of cell 5
      fromChunk: r1.nextChunk,
      ...base,
    })
    expect(r2.nextChunk).toBe(2)
    expect(r2.dataWindow[5]).toBe(0.5) // max(0.5, 0.3), not overwritten
  })
})

describe('compensated preview placement (WVY-590)', () => {
  // sr 1000, fps 100 → 10 frames per cell; mono 100-frame chunks
  const SR = 1000
  const FPS = 100

  /** Mono 100-frame chunks at the given stamps, with one amplitude-1 impulse
   *  at ctx-clock stamp `impulseSec`. */
  function stream(times: number[], impulseSec: number, frames = 100, sr = SR): TimedPcmChunk[] {
    return times.map((time) => {
      const data = new Float32Array(frames)
      const f = Math.round((impulseSec - time) * sr)
      if (f >= 0 && f < frames) data[f] = 1
      return { data, time }
    })
  }

  function committedCell(chunks: TimedPcmChunk[], anchorSec: number, ms: number, baseIdx = 0, sr = SR, fps = FPS) {
    const merged = mergeChunksToAnchor(chunks, anchorSec, sr, 1)
    const trimmed = merged.slice(compensationTrimFrames(ms, sr, merged.length))
    const j = trimmed.indexOf(1)
    return j < 0 ? -1 : baseIdx + Math.floor((j * fps) / sr)
  }

  function previewPeaks(chunks: TimedPcmChunk[], anchorSec: number, ms: number, baseIdx = 0, sr = SR, fps = FPS) {
    return accumulateChunkPeaks({
      dataWindow: new Float32Array(baseIdx + 64),
      chunks,
      fromChunk: 0,
      anchorSec,
      baseIdx,
      sampleRate: sr,
      channels: 1,
      fps,
      trimFrames: compensationTrimFrames(ms, sr),
    }).dataWindow
  }

  function previewCell(chunks: TimedPcmChunk[], anchorSec: number, ms: number, baseIdx = 0, sr = SR, fps = FPS) {
    return Array.from(previewPeaks(chunks, anchorSec, ms, baseIdx, sr, fps)).indexOf(1)
  }

  it('preview placement equals committed placement for a non-zero trim', () => {
    const chunks = stream([0, 0.1, 0.2], 0.135)
    expect(committedCell(chunks, 0, 20)).toBe(11)
    expect(previewCell(chunks, 0, 20)).toBe(11)
  })

  it('count-in on: anchor before the first chunk (zero-padded head)', () => {
    const chunks = stream([0.004, 0.104, 0.204], 0.134)
    expect(committedCell(chunks, 0, 20)).toBe(11)
    expect(previewCell(chunks, 0, 20)).toBe(11)
  })

  it('count-in off: anchor straddles a chunk', () => {
    const chunks = stream([0, 0.1, 0.2], 0.185)
    expect(committedCell(chunks, 0.05, 20)).toBe(11)
    expect(previewCell(chunks, 0.05, 20)).toBe(11)
  })

  it('punch-in at a non-zero position', () => {
    const chunks = stream([0, 0.1, 0.2], 0.135)
    expect(committedCell(chunks, 0, 20, 500)).toBe(511)
    expect(previewCell(chunks, 0, 20, 500)).toBe(511)
  })

  it('frames inside the trimmed head are not drawn', () => {
    const chunks = stream([0, 0.1, 0.2], 0.01)
    expect(committedCell(chunks, 0, 20)).toBe(-1)
    expect(previewCell(chunks, 0, 20)).toBe(-1)
  })

  it('compensationTrimFrames matches the legacy guard', () => {
    expect(compensationTrimFrames(0, SR)).toBe(0)
    expect(compensationTrimFrames(-5, SR)).toBe(0)
    expect(compensationTrimFrames(20, 1000, 1)).toBe(0)
    expect(compensationTrimFrames(20, 1000, 10)).toBe(9)
    expect(compensationTrimFrames(20, 48000)).toBe(960)
  })

  it('half-sample anchor rounds like mergeChunksToAnchor', () => {
    // fps === sr → one frame per cell, so the cell IS the committed index
    const straddle = stream([0, 0.1], 0.01)
    expect(committedCell(straddle, 0.0005, 0, 0, SR, SR)).toBe(9)
    expect(previewCell(straddle, 0.0005, 0, 0, SR, SR)).toBe(9)
    const later = stream([0, 0.1], 0.11)
    expect(committedCell(later, 0.0005, 0, 0, SR, SR)).toBe(109)
    expect(previewCell(later, 0.0005, 0, 0, SR, SR)).toBe(109)
  })
})
