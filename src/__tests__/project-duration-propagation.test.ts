jest.mock('../renderer.js', () => {
  let lastInstance: any
  class Renderer {
    options: any
    wrapper = document.createElement('div')
    renderProgress = jest.fn()
    on = jest.fn(() => () => undefined)
    setOptions = jest.fn()
    getWrapper = jest.fn(() => this.wrapper)
    getWidth = jest.fn(() => 100)
    getScroll = jest.fn(() => 0)
    setScroll = jest.fn()
    setScrollPercentage = jest.fn()
    render = jest.fn()
    zoom = jest.fn()
    exportImage = jest.fn(() => [])
    destroy = jest.fn()
    constructor(options: any) {
      this.options = options
      lastInstance = this
    }
  }
  return { __esModule: true, default: Renderer, getLastInstance: () => lastInstance }
})

jest.mock('../timer.js', () => {
  let lastInstance: any
  class Timer {
    on = jest.fn(() => () => undefined)
    start = jest.fn()
    stop = jest.fn()
    destroy = jest.fn()
  }
  const ctor = jest.fn(() => {
    lastInstance = new Timer()
    return lastInstance
  })
  return { __esModule: true, default: ctor, getLastInstance: () => lastInstance }
})

import WaveSurfer from '../wavesurfer.js'
import * as RendererModule from '../renderer.js'

const getRenderer = (RendererModule as any).getLastInstance as () => any

const createMockAudioContext = () =>
  ({
    currentTime: 0,
    destination: {},
    createGain: () => ({
      gain: { value: 1 },
      connect: jest.fn(),
      disconnect: jest.fn(),
    }),
    createBufferSource: () => ({
      buffer: null,
      playbackRate: { value: 1 },
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      onended: null,
      connect: jest.fn(),
      disconnect: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      addEventListener: jest.fn(),
    }),
  }) as unknown as AudioContext

afterEach(() => {
  jest.clearAllMocks()
})

/**
 * Regression test for stale gridline scale after projectDuration shrink.
 *
 * renderer.setOptions() re-renders and synchronously emits 'render', which
 * WaveSurfer re-emits as 'redraw' — and the TimelinePlugin lays out its
 * gridlines inside that event using getEffectiveDuration(). If the player's
 * lifted duration is only propagated AFTER the renderer re-render, a SHRINK
 * (e.g. post-recording shrink-back from 90s to 62s) makes getEffectiveDuration
 * return max(stale 90, new 62) = 90 while the wrapper is already sized for
 * 62 — gridlines land compressed and stay wrong until the next redraw (zoom).
 */
describe('setOptions projectDuration propagation order', () => {
  test('redraw-time consumers see the new effective duration on shrink', () => {
    const container = document.createElement('div')
    const ws = WaveSurfer.create({
      container,
      backend: 'WebAudio',
      audioContext: createMockAudioContext(),
    })
    const player = ws.getMediaElement() as any
    // Silent placeholder buffer, as in a Wavvy track
    player.setAudioBuffer({ duration: 60, numberOfChannels: 1 } as AudioBuffer)

    // Timeline was extended during a record pass
    ws.setOptions({ projectDuration: 90 })
    expect(ws.getEffectiveDuration()).toBe(90)

    // Capture what a 'redraw' listener (TimelinePlugin gridlines) would see:
    // the redraw fires synchronously inside renderer.setOptions()
    let effectiveDurationAtRedraw = -1
    getRenderer().setOptions.mockImplementation(() => {
      effectiveDurationAtRedraw = ws.getEffectiveDuration()
    })

    // Take landed; timeline shrinks back to content + padding
    ws.setOptions({ projectDuration: 62 })

    expect(effectiveDurationAtRedraw).toBe(62)
    expect(ws.getEffectiveDuration()).toBe(62)
  })
})
