/**
 * PIN (wavvy WVY-1136): `ClipParams.freeRightEdge` lifts ONLY the trim-mode
 * right-edge clamp (offset + duration <= source extent), so a host can let a
 * clip's right edge extend past its content (wavvy arrangement MIDI clips,
 * Ableton parity). Default off: every existing behaviour is identical. The
 * left-edge offset-0 stop, grid snapping, the 0.01 s minimum width and loop
 * tiling are unchanged with the flag on.
 */
import ClipsPlugin from '../plugins/clips.js'

beforeAll(() => {
  // jsdom has no matchMedia; the resize handles' makeDraggable reads it.
  ;(globalThis as any).matchMedia = () => ({ matches: false })
})

/** 10 s timeline in a 1000 px parent: 100 px = 1 s. */
function setup(params: Record<string, any>, snap?: { gridSeconds: number; enabled: boolean }) {
  const plugin = ClipsPlugin.create()
  plugin.setTotalDuration(10)
  if (snap) plugin.setSnapConfig(snap.gridSeconds, snap.enabled)
  const clip: any = plugin.addClip({
    id: 'c1',
    startTime: 0,
    duration: 2,
    originalDuration: 2,
    ...params,
  })
  const parent = document.createElement('div')
  parent.getBoundingClientRect = () =>
    ({ width: 1000, left: 0, right: 1000, top: 0, bottom: 50, height: 50, x: 0, y: 0 }) as DOMRect
  parent.appendChild(clip.element)
  const resizeEnds: Array<{ side: string; startTime: number; duration: number }> = []
  plugin.on('clip-resize-end', (block: any, side: string) => {
    resizeEnds.push({ side, startTime: block.startTime, duration: block.duration })
  })
  const updateEnds: Array<string | undefined> = []
  clip.on('update-end', (side: string | undefined) => updateEnds.push(side))
  return { plugin, clip, resizeEnds, updateEnds }
}

function drag(clip: any, dx: number, side: 'start' | 'end') {
  clip.onResize(dx, side)
  clip.onEndResizing(side)
}

describe('ClipsPlugin freeRightEdge (wavvy WVY-1136)', () => {
  it('flag absent: the trim-mode right-edge clamp holds (default off)', () => {
    const { clip } = setup({})
    expect(clip.freeRightEdge).toBe(false)
    drag(clip, 100, 'end')
    expect(clip.duration).toBe(2)
  })

  it('freeRightEdge: the right edge extends past the source extent', () => {
    const { clip, updateEnds, resizeEnds } = setup({ freeRightEdge: true })
    expect(clip.freeRightEdge).toBe(true)
    drag(clip, 100, 'end')
    expect(clip.duration).toBeCloseTo(3, 9)
    expect(updateEnds).toEqual(['end'])
    expect(resizeEnds).toHaveLength(1)
    expect(resizeEnds[0].side).toBe('end')
    expect(resizeEnds[0].duration).toBeCloseTo(3, 9)
    expect(resizeEnds[0].startTime).toBe(0)
  })

  it('freeRightEdge: host grid snap still applies to the dragged end', () => {
    const { clip } = setup({ freeRightEdge: true }, { gridSeconds: 0.5, enabled: true })
    drag(clip, 130, 'end') // 2 + 1.3 = 3.3 → end snaps to 3.5
    expect(clip.duration).toBeCloseTo(3.5, 9)
  })

  it('freeRightEdge: the left edge still stops at source offset 0', () => {
    const { clip } = setup({ freeRightEdge: true, startTime: 4, loopPhaseSec: 0 })
    drag(clip, -100, 'start')
    expect(clip.startTime).toBe(4)
    expect(clip.duration).toBe(2)
  })

  it('freeRightEdge: shrinking and the 0.01 s minimum width are unchanged', () => {
    const { clip } = setup({ freeRightEdge: true })
    drag(clip, -199.5, 'end') // would leave 0.005 s: under the floor, rejected
    expect(clip.duration).toBe(2)
    const shrink = setup({ freeRightEdge: true })
    drag(shrink.clip, -100, 'end')
    expect(shrink.clip.duration).toBeCloseTo(1, 9)
  })

  it('loop-tiled clips are unaffected by the flag', () => {
    for (const freeRightEdge of [false, true]) {
      const { clip } = setup({
        loopEnabled: true,
        loopStartSec: 0,
        loopEndSec: 1,
        originalDuration: 1,
        freeRightEdge,
      })
      drag(clip, 300, 'end')
      expect(clip.duration).toBeCloseTo(5, 9)
    }
  })
})
