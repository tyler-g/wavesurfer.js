/**
 * PIN (WVY-590): the committed clip-mode PCM head trim must stay byte-identical
 * to the legacy inline computation in processPcmData. The live preview now
 * shares that trim via compensationTrimFrames — this suite guarantees the
 * refactor changed nothing the user hears.
 */
import RecordPlugin from '../plugins/record.js'

const SR = 1000

function seq(startValue: number, length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => startValue + i)
}

/** Record three 10-frame chunks (mono) or 10-frame interleaved stereo chunks
 *  anchored at ctx 0, finalize, and return the emitted record-pcm-data payload. */
function finalize(opts: { compensationMs: number; channels: 1 | 2; punchInSec?: number }) {
  const plugin = RecordPlugin.create({
    clipMode: true,
    audioContext: { sampleRate: SR, currentTime: 0 } as any,
  })
  plugin.setRecordingChannels(opts.channels)
  if (opts.punchInSec !== undefined) plugin.setPunchInPosition(opts.punchInSec)
  const n = 10 * opts.channels
  plugin.pushPcmChunk(seq(0, n), 0)
  plugin.pushPcmChunk(seq(n, n), 0.01)
  plugin.pushPcmChunk(seq(2 * n, n), 0.02)
  plugin.setCaptureAnchor(0)
  plugin.recordingCompensationMs = opts.compensationMs
  let payload: any = null
  plugin.on('record-pcm-data' as any, (p: any) => {
    payload = p
  })
  ;(plugin as any).processPcmData()
  return payload
}

const range = (from: number, to: number, step = 1) => {
  const out: number[] = []
  for (let v = from; v < to; v += step) out.push(v)
  return out
}

describe('committed clip PCM is byte-identical to the legacy head trim', () => {
  it('mono C=20 ms trims 20 frames', () => {
    const p = finalize({ compensationMs: 20, channels: 1 })
    expect(p.pcm).toHaveLength(1)
    expect(Array.from(p.pcm[0])).toEqual(range(20, 30))
  })

  it('stereo (interleaved) C=20 ms trims 20 frames per channel', () => {
    const p = finalize({ compensationMs: 20, channels: 2 })
    expect(p.pcm).toHaveLength(2)
    expect(Array.from(p.pcm[0])).toEqual(range(40, 60, 2))
    expect(Array.from(p.pcm[1])).toEqual(range(41, 60, 2))
  })

  it('C=0 does not trim', () => {
    const p = finalize({ compensationMs: 0, channels: 1 })
    expect(Array.from(p.pcm[0])).toEqual(range(0, 30))
  })

  it('negative C (manual override) does not trim', () => {
    const p = finalize({ compensationMs: -5, channels: 1 })
    expect(Array.from(p.pcm[0])).toEqual(range(0, 30))
  })

  it('C longer than the take keeps exactly one sample', () => {
    const p = finalize({ compensationMs: 100, channels: 1 })
    expect(Array.from(p.pcm[0])).toEqual([29])
    const s = finalize({ compensationMs: 100, channels: 2 })
    expect(Array.from(s.pcm[0])).toEqual([58])
    expect(Array.from(s.pcm[1])).toEqual([59])
  })

  it('startTime stays at punchInTimeSec (trim alone is the compensation)', () => {
    const p = finalize({ compensationMs: 20, channels: 1, punchInSec: 5 })
    expect(p.startTime).toBe(5)
    expect(p.endTime).toBeCloseTo(5 + 10 / SR, 12)
    expect(Array.from(p.pcm[0])).toEqual(range(20, 30))
  })
})
