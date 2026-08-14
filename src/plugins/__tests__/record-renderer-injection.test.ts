import RecordPlugin from '../record.js'

/**
 * Regression tests for the app-injected async effective-audio renderer seam
 * (RecordPlugin.setEffectiveAudioRenderer). When wavvy injects its
 * worker-backed Signalsmith renderer at boot, recomputeAndReload and
 * previewEffectOnRegion must await it instead of running the internal
 * synchronous computeEffectiveAudio pipeline.
 */
describe('RecordPlugin effective-audio renderer injection', () => {
  const createWsStub = () => ({
    getCurrentTime: () => 0,
    getScroll: () => 0,
    options: { minPxPerSec: 0 },
    loadPcm: jest.fn().mockResolvedValue(undefined),
    zoom: jest.fn(),
    setTime: jest.fn(),
    setScroll: jest.fn(),
    empty: jest.fn(),
  })

  const createPlugin = () => {
    const plugin = RecordPlugin.create({ audioContext: { sampleRate: 44100 } as any })
    const ws = createWsStub()
    plugin._init(ws as any)
    ;(plugin as any).originalPcm = [new Float32Array([0.1, 0.2, 0.3])]
    ;(plugin as any).pcmSampleRate = 44100
    ;(plugin as any).edits = [
      { id: 'e1', type: 'delete', startSample: 0, endSample: 1, startTime: 0, endTime: 0.001 },
    ]
    return { plugin, ws }
  }

  afterEach(() => {
    RecordPlugin.setEffectiveAudioRenderer(null)
  })

  it('recomputeAndReload awaits an injected renderer', async () => {
    const { plugin, ws } = createPlugin()
    const rendered = [new Float32Array([0.5, 0.5])]
    const renderer = jest.fn().mockResolvedValue(rendered)
    RecordPlugin.setEffectiveAudioRenderer(renderer)

    plugin.recomputeAndReload()
    await Promise.resolve() // let the async path run
    await Promise.resolve()

    expect(renderer).toHaveBeenCalledWith(
      plugin['originalPcm'],
      plugin['edits'],
      expect.any(Number),
    )
    expect(ws.loadPcm).toHaveBeenCalledWith(rendered, 44100)

    RecordPlugin.setEffectiveAudioRenderer(null)
  })

  it('falls back to the synchronous pipeline when no renderer is injected', async () => {
    const { plugin, ws } = createPlugin()

    await plugin.recomputeAndReload()

    expect(ws.loadPcm).toHaveBeenCalled()
    const [calledPcm] = ws.loadPcm.mock.calls[0]
    // computeEffectiveAudio applies the 'delete' edit (samples [0,1)) to the
    // 3-sample originalPcm, leaving 2 samples.
    expect(calledPcm[0].length).toBe(2)
  })

  it('falls back to the synchronous pipeline when the injected renderer rejects', async () => {
    const { plugin, ws } = createPlugin()
    const renderer = jest.fn().mockRejectedValue(new Error('worker crashed'))
    RecordPlugin.setEffectiveAudioRenderer(renderer)

    await plugin.recomputeAndReload()

    expect(renderer).toHaveBeenCalled()
    expect(ws.loadPcm).toHaveBeenCalled()
    const [calledPcm] = ws.loadPcm.mock.calls[0]
    expect(calledPcm[0].length).toBe(2)
  })

  it('previewEffectOnRegion awaits an injected renderer without touching this.edits', async () => {
    const { plugin } = createPlugin()
    const savedEdits = [...(plugin as any).edits]
    const rendered = [new Float32Array([0.25, 0.25, 0.25])]
    const renderer = jest.fn().mockResolvedValue(rendered)
    RecordPlugin.setEffectiveAudioRenderer(renderer)

    const result = await plugin.previewEffectOnRegion(0, 0.00002, { type: 'amplify', gain: 3 })

    expect(renderer).toHaveBeenCalled()
    // The preview edit must be visible to the renderer call...
    const editsArgAtCallTime = renderer.mock.calls[0][1]
    expect(editsArgAtCallTime.some((e: any) => e.id === 'preview')).toBe(true)
    // ...but must never have been written into the plugin's own edit list.
    expect((plugin as any).edits).toEqual(savedEdits)
    expect((plugin as any).edits.some((e: any) => e.id === 'preview')).toBe(false)
    expect(result).not.toBeNull()
  })

  it('overlapping previews never leak a phantom preview edit into this.edits', async () => {
    const { plugin } = createPlugin()
    const savedEdits = [...(plugin as any).edits]
    const rendered = [new Float32Array([0.25, 0.25, 0.25])]

    // Renderer that only settles when we say so, so the two previews overlap.
    const resolvers: Array<() => void> = []
    const renderer = jest.fn(
      (_pcm: Float32Array[], _edits: any[], _sampleRate: number) =>
        new Promise<Float32Array[]>((resolve) => {
          resolvers.push(() => resolve(rendered))
        }),
    )
    RecordPlugin.setEffectiveAudioRenderer(renderer)

    const first = plugin.previewEffectOnRegion(0, 0.00002, { type: 'amplify', gain: 3 })
    const second = plugin.previewEffectOnRegion(0, 0.00002, { type: 'amplify', gain: 6 })

    // Both are in flight — the plugin's edit list is untouched meanwhile.
    expect(renderer).toHaveBeenCalledTimes(2)
    expect((plugin as any).edits).toEqual(savedEdits)

    // Each call saw its own preview edit, exactly one.
    for (const call of renderer.mock.calls) {
      const editsArg = call[1] as any[]
      expect(editsArg.filter((e) => e.id === 'preview').length).toBe(1)
    }

    // Settle out of order (the pre-fix save/restore leaked on this ordering).
    resolvers[0]()
    resolvers[1]()
    await first
    await second

    expect((plugin as any).edits).toEqual(savedEdits)
    expect((plugin as any).edits.some((e: any) => e.id === 'preview')).toBe(false)
    expect(plugin.getEdits().some((e: any) => e.id === 'preview')).toBe(false)
  })
})
