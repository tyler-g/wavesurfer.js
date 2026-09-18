/**
 * PIN (wavvy WVY-644): `flushTake()` finalizes a take SYNCHRONOUSLY with the
 * exact payload the MediaRecorder onstop path would have produced — same chunk
 * set, same head trim, same event order — and stales the pending onstop so the
 * take is never emitted twice. The host calls it when project state is about
 * to be replaced in the same tick (the ordinary onstop is a later task and
 * would reach a listener React has already torn down).
 *
 * The real onstop closure is driven: `startRecording()` runs against a stubbed
 * mic renderer and a fake global MediaRecorder whose `state` flips to
 * 'inactive' synchronously on `stop()` (the spec's behavior — and what makes
 * `stopRecording()` inside `flushTake()` a no-op after the host already
 * stopped).
 */
import RecordPlugin from '../plugins/record.js'

const SR = 1000

function seq(startValue: number, length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => startValue + i)
}

const range = (from: number, to: number, step = 1) => {
  const out: number[] = []
  for (let v = from; v < to; v += step) out.push(v)
  return out
}

const recorders: FakeMediaRecorder[] = []

class FakeMediaRecorder {
  static isTypeSupported = () => true
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  mimeType = 'audio/webm'
  onstop: null | (() => void) = null
  onpause: null | (() => void) = null
  ondataavailable: null | ((e: any) => void) = null
  constructor(
    public stream: any,
    public options: any,
  ) {
    recorders.push(this)
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    // Synchronous per the MediaRecorder spec: `stop()` sets state to inactive
    // at once; the `stop` event is queued as a task.
    this.state = 'inactive'
  }
  pause() {
    this.state = 'paused'
  }
  resume() {
    this.state = 'recording'
  }
}

beforeEach(() => {
  recorders.length = 0
  ;(globalThis as any).MediaRecorder = FakeMediaRecorder
})

afterEach(() => {
  delete (globalThis as any).MediaRecorder
})

/** A plugin mid-take: real startRecording (fake MediaRecorder, stubbed mic
 *  renderer), three 10-frame mono chunks anchored at ctx 0, C = 20 ms — the
 *  same take `record-plugin-compensation.test.ts` finalizes through
 *  processPcmData, whose committed PCM is `range(20, 30)`. */
async function midTake() {
  const plugin = RecordPlugin.create({
    clipMode: true,
    audioContext: { sampleRate: SR, currentTime: 0 } as any,
  })
  ;(plugin as any).stream = {} // skip startMic
  ;(plugin as any).renderMicStream = () => ({ source: null, onDestroy: () => undefined })
  const events: string[] = []
  const payloads: any[] = []
  plugin.on('record-end', () => events.push('record-end'))
  plugin.on('record-pcm-data' as any, (p: any) => {
    events.push('record-pcm-data')
    payloads.push(p)
  })
  await plugin.startRecording()
  plugin.setRecordingChannels(1)
  plugin.pushPcmChunk(seq(0, 10), 0)
  plugin.pushPcmChunk(seq(10, 10), 0.01)
  plugin.pushPcmChunk(seq(20, 10), 0.02)
  plugin.setCaptureAnchor(0)
  plugin.recordingCompensationMs = 20
  return { plugin, events, payloads, recorder: recorders[recorders.length - 1] }
}

describe('RecordPlugin.flushTake', () => {
  it('returns false and emits nothing when no PCM chunk was captured', () => {
    const plugin = RecordPlugin.create({
      clipMode: true,
      audioContext: { sampleRate: SR, currentTime: 0 } as any,
    })
    const events: string[] = []
    plugin.on('record-end', () => events.push('record-end'))
    plugin.on('record-pcm-data' as any, () => events.push('record-pcm-data'))
    expect(plugin.flushTake()).toBe(false)
    expect(events).toEqual([])
  })

  it('emits record-end then record-pcm-data synchronously with the payload processPcmData yields', async () => {
    const { plugin, events, payloads, recorder } = await midTake()
    expect(recorder.state).toBe('recording')
    expect(plugin.isRecording()).toBe(true)

    expect(plugin.flushTake()).toBe(true)

    // Synchronous, in order, exactly once each.
    expect(events).toEqual(['record-end', 'record-pcm-data'])
    // Byte-identical to the ordinary finalize (record-plugin-compensation:
    // mono C=20 ms trims 20 frames of the 30-frame anchored take).
    expect(payloads[0].pcm).toHaveLength(1)
    expect(Array.from(payloads[0].pcm[0])).toEqual(range(20, 30))
    expect(Array.from(payloads[0].recordedPcm[0])).toEqual(range(20, 30))
    expect(payloads[0].startTime).toBe(0)
    expect(payloads[0].endTime).toBeCloseTo(10 / SR, 12)
    // The flush stopped the recorder itself (the host had not).
    expect(recorder.state).toBe('inactive')
    expect(plugin.isRecording()).toBe(false)
  })

  it('a second flushTake emits nothing, and the staled onstop emits nothing either', async () => {
    const { plugin, events, recorder } = await midTake()
    expect(plugin.flushTake()).toBe(true)
    expect(events).toHaveLength(2)

    expect(plugin.flushTake()).toBe(false)
    expect(events).toHaveLength(2)

    // MediaRecorder's queued stop event lands later — the closure sees a
    // stale generation and returns without emitting (no double take).
    expect(typeof recorder.onstop).toBe('function')
    recorder.onstop!()
    expect(events).toHaveLength(2)
  })

  it('works after the host already stopped the recorder (stop-then-flush ordering)', async () => {
    const { plugin, events, payloads, recorder } = await midTake()
    // The host's finalize: stopRecording() first (state flips inactive at
    // once), the onstop is still pending as a task.
    plugin.stopRecording()
    expect(recorder.state).toBe('inactive')
    expect(events).toEqual([])

    expect(plugin.flushTake()).toBe(true)
    expect(events).toEqual(['record-end', 'record-pcm-data'])
    expect(Array.from(payloads[0].pcm[0])).toEqual(range(20, 30))

    recorder.onstop!()
    expect(events).toHaveLength(2)
  })

  it('the ordinary onstop path still finalizes when nothing flushed', async () => {
    const { plugin, events, payloads, recorder } = await midTake()
    plugin.stopRecording()
    recorder.onstop!()
    expect(events).toEqual(['record-end', 'record-pcm-data'])
    expect(Array.from(payloads[0].pcm[0])).toEqual(range(20, 30))
    // Nothing left for a late flush.
    expect(plugin.flushTake()).toBe(false)
    expect(events).toHaveLength(2)
  })
})
