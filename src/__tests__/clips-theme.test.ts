/**
 * PIN (wavvy WVY-1777, light mode): every colour the clips plugin hardcoded
 * for a dark background is a `--ws-clip-*` custom property whose fallback is
 * EXACTLY the old literal (a host that sets nothing renders as before); canvas
 * colours are resolved from the clips overlay's computed style, cached per
 * plugin, and refreshed only by `invalidatePaint()`, which repaints without
 * touching clip data. Also pins `TimelinePlugin.setGridLinesColor`.
 *
 * jsdom limits: it does not inherit custom properties (tests set them on the
 * overlay itself — real inheritance through the shadow host is plain CSS),
 * and its CSSStyleDeclaration drops `var()` in `color` / `border-*` (those
 * are pinned via the CLIP_DOM_STYLE strings instead of the element).
 */
import ClipsPlugin from '../plugins/clips.js'
import TimelinePlugin from '../plugins/timeline.js'
import {
  CLIP_DOM_STYLE,
  CLIP_THEME_FALLBACKS,
  DEFAULT_CLIP_CANVAS_COLORS,
  resolveClipCanvasColors,
} from '../clip-theme.js'

type Call = { op: string; args: any[]; fillStyle: string; strokeStyle: string }

function recordingCtx() {
  const calls: Call[] = []
  const ctx: any = {
    calls,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineJoin: 'miter',
    globalAlpha: 1,
  }
  for (const op of ['beginPath', 'closePath', 'moveTo', 'lineTo', 'stroke', 'fill', 'arc', 'clearRect', 'fillRect']) {
    ctx[op] = (...args: any[]) => calls.push({ op, args, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle })
  }
  return ctx
}

let originalGetContext: any
let originalRaf: any
let ctxs: any[] = []

beforeAll(() => {
  // jsdom has no matchMedia; the resize handles' makeDraggable reads it.
  ;(globalThis as any).matchMedia = () => ({ matches: false })
  originalGetContext = HTMLCanvasElement.prototype.getContext
  ;(HTMLCanvasElement.prototype as any).getContext = function () {
    if (!this.__ctx) {
      this.__ctx = recordingCtx()
      ctxs.push(this.__ctx)
    }
    return this.__ctx
  }
  originalRaf = globalThis.requestAnimationFrame
  // Paint synchronously so assertions see the frame.
  ;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  }
})

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext
  ;(globalThis as any).requestAnimationFrame = originalRaf
})

beforeEach(() => {
  ctxs = []
  document.body.innerHTML = ''
})

/** A plugin whose overlay is in the document (as under a real wavesurfer). */
function connectedPlugin() {
  const plugin = ClipsPlugin.create() as any
  const overlay = document.createElement('div')
  document.body.appendChild(overlay)
  plugin.container = overlay
  return { plugin, overlay: overlay as HTMLElement }
}

const fills = (ctx: any) => ctx.calls.filter((c: Call) => c.op === 'fill').map((c: Call) => c.fillStyle)

describe('clip theme fallbacks (WVY-1777)', () => {
  it('fallbacks are exactly the pre-theme literals', () => {
    expect(CLIP_DOM_STYLE).toEqual({
      outline: '2px solid var(--ws-clip-outline-color, rgba(255,255,255,0.18))',
      selectedOutline: '2px solid var(--ws-clip-selected-outline-color, #fff)',
      labelColor: 'var(--ws-clip-label-color, #fff)',
      labelShadow: 'var(--ws-clip-label-shadow, 0 1px 2px rgba(0,0,0,0.5))',
      handleBorder: '2px solid var(--ws-clip-handle-color, rgba(255,255,255,0.5))',
    })
    expect(DEFAULT_CLIP_CANVAS_COLORS).toEqual({
      wave: 'rgba(255,255,255,0.4)',
      sampleLine: 'rgba(255,255,255,0.85)',
      sampleDot: 'rgba(255,255,255,0.9)',
    })
  })

  it('the clip DOM uses the variables (outline follows selection, label shadow)', () => {
    const plugin = ClipsPlugin.create()
    const clip = plugin.addClip({ id: 'c1', startTime: 0, duration: 2, name: 'Take' })
    const el = clip.element as HTMLElement
    expect(el.style.outline).toBe(CLIP_DOM_STYLE.outline)
    clip.setSelected(true)
    expect(el.style.outline).toBe(CLIP_DOM_STYLE.selectedOutline)
    clip.setSelected(false)
    expect(el.style.outline).toBe(CLIP_DOM_STYLE.outline)
    const label = el.querySelector<HTMLElement>('.ws-clip-label')!
    expect(label.style.textShadow).toBe(CLIP_DOM_STYLE.labelShadow)
  })

  it('a clip with no themed host paints with the old literals', () => {
    const plugin = ClipsPlugin.create() // overlay never attached → detached
    const clip = plugin.addClip({
      id: 'c1',
      startTime: 0,
      duration: 1,
      pcm: [new Float32Array(4000).fill(0.5)],
      sampleRate: 4000,
    })
    expect(fills((clip.canvas as any).getContext('2d'))).toEqual([CLIP_THEME_FALLBACKS.wave])
  })
})

describe('resolveClipCanvasColors (WVY-1777)', () => {
  it('returns null for a detached element (callers must not cache)', () => {
    expect(resolveClipCanvasColors(document.createElement('div'))).toBeNull()
    expect(resolveClipCanvasColors(null)).toBeNull()
  })

  it('falls back to the literals when no variable is set', () => {
    const { overlay } = connectedPlugin()
    expect(resolveClipCanvasColors(overlay)).toEqual(DEFAULT_CLIP_CANVAS_COLORS)
  })

  it('honours set variables (one sample variable drives line + dots)', () => {
    const { overlay } = connectedPlugin()
    overlay.style.setProperty('--ws-clip-wave-color', ' rgba(0,0,0,0.5) ')
    overlay.style.setProperty('--ws-clip-sample-color', '#123456')
    expect(resolveClipCanvasColors(overlay)).toEqual({
      wave: 'rgba(0,0,0,0.5)',
      sampleLine: '#123456',
      sampleDot: '#123456',
    })
  })

  it('rejects a non-colour value when CSS.supports is available', () => {
    const { overlay } = connectedPlugin()
    overlay.style.setProperty('--ws-clip-wave-color', 'not-a-colour')
    const prev = (globalThis as any).CSS
    ;(globalThis as any).CSS = { supports: (_p: string, val: string) => val !== 'not-a-colour' }
    try {
      expect(resolveClipCanvasColors(overlay)!.wave).toBe(CLIP_THEME_FALLBACKS.wave)
    } finally {
      ;(globalThis as any).CSS = prev
    }
  })

  it('never throws — a failing getComputedStyle yields null', () => {
    const { overlay } = connectedPlugin()
    const spy = jest.spyOn(window, 'getComputedStyle').mockImplementation(() => {
      throw new Error('boom')
    })
    try {
      expect(resolveClipCanvasColors(overlay)).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('canvas colours in the draw primitives (WVY-1777)', () => {
  it('sample line + dots use the resolved sample colour, literals by default', () => {
    const { plugin, overlay } = connectedPlugin()
    const clip = plugin.addClip({ id: 'c1', startTime: 0, duration: 1 }) as any
    const ch = new Float32Array([0, 0.5, -0.5, 0.25])
    let ctx = recordingCtx()
    // 4 samples over 100 px = 25 px/sample → dots drawn too.
    clip.drawChannelSampleLine(ctx, ch, 0, 4, 100, 50, 50)
    expect(ctx.calls.find((c: Call) => c.op === 'stroke').strokeStyle).toBe('rgba(255,255,255,0.85)')
    expect(ctx.calls.find((c: Call) => c.op === 'fill').fillStyle).toBe('rgba(255,255,255,0.9)')

    overlay.style.setProperty('--ws-clip-sample-color', 'rgb(10, 20, 30)')
    plugin.invalidatePaint()
    ctx = recordingCtx()
    clip.drawChannelSampleLine(ctx, ch, 0, 4, 100, 50, 50)
    expect(ctx.calls.find((c: Call) => c.op === 'stroke').strokeStyle).toBe('rgb(10, 20, 30)')
    expect(ctx.calls.find((c: Call) => c.op === 'fill').fillStyle).toBe('rgb(10, 20, 30)')
  })

  it('the colour lookup is cached until invalidatePaint', () => {
    const { plugin, overlay } = connectedPlugin()
    const spy = jest.spyOn(window, 'getComputedStyle')
    try {
      plugin.getCanvasColors()
      plugin.getCanvasColors()
      plugin.getCanvasColors()
      expect(spy).toHaveBeenCalledTimes(1)
      overlay.style.setProperty('--ws-clip-wave-color', '#abcdef')
      expect(plugin.getCanvasColors().wave).toBe(CLIP_THEME_FALLBACKS.wave) // still cached
      plugin.invalidatePaint()
      expect(plugin.getCanvasColors().wave).toBe('#abcdef')
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('ClipsPlugin.invalidatePaint (WVY-1777)', () => {
  it('repaints with the new colours and leaves clip data alone', () => {
    const { plugin, overlay } = connectedPlugin()
    const pcm = [new Float32Array(4000).fill(0.5)]
    const peaks = [0.1, 0.2]
    const clip = plugin.addClip({
      id: 'c1',
      startTime: 1.5,
      duration: 1,
      pcm,
      sampleRate: 4000,
      peaks,
      selected: true,
      name: 'Take',
    })
    overlay.appendChild(clip.element)
    const ctx = (clip.canvas as any).getContext('2d')
    expect(fills(ctx)).toEqual([CLIP_THEME_FALLBACKS.wave])

    // Theme flip: the variable alone changes nothing — the paint short-circuits.
    overlay.style.setProperty('--ws-clip-wave-color', 'rgba(0, 0, 0, 0.5)')
    clip.renderWaveform()
    expect(fills(ctx)).toEqual([CLIP_THEME_FALLBACKS.wave])

    plugin.invalidatePaint()
    expect(fills(ctx)).toEqual([CLIP_THEME_FALLBACKS.wave, 'rgba(0, 0, 0, 0.5)'])

    // Data, position and selection untouched.
    expect(clip.startTime).toBe(1.5)
    expect(clip.duration).toBe(1)
    expect(clip.selected).toBe(true)
    expect(clip.peaks).toBe(peaks)
    expect((clip as any).pcm).toBe(pcm)
    expect(pcm[0].every((s) => s === 0.5)).toBe(true)
    expect((clip.element as HTMLElement).style.outline).toBe(CLIP_DOM_STYLE.selectedOutline)

    // Steady state again: the next unchanged render short-circuits.
    clip.renderWaveform()
    expect(fills(ctx)).toHaveLength(2)
  })

  it('repaints custom-content (MIDI) clips too', () => {
    const { plugin } = connectedPlugin()
    const renderContent = jest.fn()
    const clip = plugin.addClip({ id: 'm1', startTime: 0, duration: 1, renderContent, contentWindowed: true, data: [] })
    const before = renderContent.mock.calls.length
    expect(before).toBe(1)
    clip.renderWaveform() // unchanged → short-circuited
    expect(renderContent.mock.calls.length).toBe(before)
    plugin.invalidatePaint()
    expect(renderContent.mock.calls.length).toBe(before + 1)
  })
})

describe('TimelinePlugin.setGridLinesColor (WVY-1777)', () => {
  function setup(options: Record<string, any> = {}) {
    const wrapper = document.createElement('div')
    Object.defineProperty(wrapper, 'offsetWidth', { configurable: true, get: () => 6000 })
    const fakeWs: any = {
      getWrapper: () => wrapper,
      getEffectiveDuration: () => 60,
      getDuration: () => 60,
      getScroll: () => 0,
      getWidth: () => 300,
      on: () => () => undefined,
    }
    const plugin = TimelinePlugin.create({ height: 0, gridLines: true, tempo: 120, ...options }) as any
    plugin._init(fakeWs)
    return plugin
  }
  const lastFill = (plugin: any) => {
    const ctx = plugin.gridCanvas.getContext('2d')
    const rects = ctx.calls.filter((c: Call) => c.op === 'fillRect')
    return rects[rects.length - 1].fillStyle
  }

  it('defaults to the old literal and repaints with a new colour', () => {
    const plugin = setup()
    expect(lastFill(plugin)).toBe('rgba(255, 255, 255, 0.12)')
    plugin.setGridLinesColor('rgba(0, 0, 0, 0.2)')
    expect(lastFill(plugin)).toBe('rgba(0, 0, 0, 0.2)')
  })

  it('null / empty restores the default; a repeat value is a no-op', () => {
    const plugin = setup({ gridLinesColor: '#111' })
    expect(lastFill(plugin)).toBe('#111')
    const ctx = plugin.gridCanvas.getContext('2d')
    const n = ctx.calls.length
    plugin.setGridLinesColor('#111')
    expect(ctx.calls.length).toBe(n)
    plugin.setGridLinesColor(null)
    expect(lastFill(plugin)).toBe('rgba(255, 255, 255, 0.12)')
    plugin.setGridLinesColor('#222')
    plugin.setGridLinesColor('  ')
    expect(lastFill(plugin)).toBe('rgba(255, 255, 255, 0.12)')
  })
})
