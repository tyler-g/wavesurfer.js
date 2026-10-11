/**
 * TimelinePlugin grid layout reads the wrapper's LAID-OUT width (offsetWidth),
 * never scrollWidth (wavvy WVY-1162). The wrapper does not clip, so the grid
 * canvas's own GRID_PAINT_MARGIN overhang inflates scrollWidth — that fed a
 * stale px/s after a zoom-out while scrolled right and stretched the grid at
 * fit zoom.
 */
import TimelinePlugin from '../plugins/timeline.js'

const DURATION = 60

function setup(widths: { offset: number; scroll: number }, scroll = 0, viewport = 300) {
  const wrapper = document.createElement('div')
  Object.defineProperty(wrapper, 'offsetWidth', { configurable: true, get: () => widths.offset })
  Object.defineProperty(wrapper, 'scrollWidth', { configurable: true, get: () => widths.scroll })
  const handlers: Record<string, ((...args: any[]) => void)[]> = {}
  const fakeWs: any = {
    getWrapper: () => wrapper,
    getEffectiveDuration: () => DURATION,
    getDuration: () => DURATION,
    getScroll: () => scroll,
    getWidth: () => viewport,
    on: (ev: string, cb: (...args: any[]) => void) => {
      ;(handlers[ev] ||= []).push(cb)
      return () => undefined
    },
  }
  const plugin = TimelinePlugin.create({ height: 0, gridLines: true, tempo: 120, gridSubdivision: '1/4' })
  plugin._init(fakeWs)
  const redraw = () => (handlers.redraw || []).forEach((cb) => cb())
  return { plugin: plugin as any, redraw }
}

describe('TimelinePlugin grid layout (WVY-1162)', () => {
  let originalGetContext: any

  beforeAll(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext
    ;(HTMLCanvasElement.prototype as any).getContext = function () {
      return { clearRect() {}, fillRect() {}, globalAlpha: 1, fillStyle: '' }
    }
  })

  afterAll(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
  })

  it('zoom-out while scrolled right lays out from offsetWidth, not the overhang-inflated scrollWidth', () => {
    const widths = { offset: 6000, scroll: 6000 }
    const { plugin, redraw } = setup(widths, 2700, 300)
    // Zoom out: wrapper shrinks to 3000 but the previous canvas still overhangs.
    widths.offset = 3000
    redraw()
    expect(plugin.gridLayout.pxPerSec).toBe(50)
  })

  it('fit zoom lays out from offsetWidth (scrollWidth includes the 200px paint margin)', () => {
    const { plugin, redraw } = setup({ offset: 1280, scroll: 1480 }, 0, 1280)
    redraw()
    expect(plugin.gridLayout.pxPerSec).toBeCloseTo(1280 / DURATION, 10)
  })

  it('the painted canvas never overhangs the laid-out wrapper', () => {
    const widths = { offset: 6000, scroll: 6000 }
    const { plugin, redraw } = setup(widths, 2700, 300)
    widths.offset = 3000
    redraw()
    const canvas: HTMLCanvasElement = plugin.gridCanvas
    const from = parseFloat(/translateX\(([-\d.]+)px\)/.exec(canvas.style.transform)![1])
    expect(from + parseFloat(canvas.style.width)).toBeLessThanOrEqual(3000)
  })

  it('steady state (offsetWidth == scrollWidth) is unchanged', () => {
    const { plugin, redraw } = setup({ offset: 6000, scroll: 6000 }, 0, 300)
    redraw()
    expect(plugin.gridLayout.pxPerSec).toBe(100)
  })
})
