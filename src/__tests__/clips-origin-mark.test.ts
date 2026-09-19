/**
 * PIN (wavvy WVY-652): the clip label is a structured `.ws-clip-label` row —
 * an optional hollow peer disc (`.ws-clip-origin`) BEFORE the name span
 * (`.ws-clip-name`) plus a hidden-by-default " · initials" tail
 * (`.ws-clip-origin-text`, revealed by the renderer's container query at
 * >= 160px). `setName` must write the NAME SPAN only — the old
 * `label.textContent = name` write would delete the disc — and
 * `setOrigin(null)` must remove both origin spans and restore the plain
 * accessible name.
 */
import ClipsPlugin from '../plugins/clips.js'

beforeAll(() => {
  // jsdom has no matchMedia; the resize handles' makeDraggable reads it.
  ;(globalThis as any).matchMedia = () => ({ matches: false })
})

const origin = { color: '#f00', label: 'TG', name: 'Tyler G' }

function makeClip(withOrigin = true) {
  const plugin = ClipsPlugin.create()
  const clip = plugin.addClip({
    id: 'c1',
    startTime: 0,
    duration: 2,
    name: 'Take',
    ...(withOrigin ? { origin } : {}),
  })
  const el = clip.element as HTMLElement
  const label = el.querySelector<HTMLElement>('.ws-clip-label')!
  return { plugin, clip, el, label }
}

describe('ClipsPlugin origin mark (WVY-652)', () => {
  it('setName keeps the disc and only rewrites the name span', () => {
    const { clip, el, label } = makeClip()
    expect(label.querySelector('.ws-clip-origin')).not.toBeNull()
    clip.setName('X')
    expect(label.querySelector('.ws-clip-origin')).not.toBeNull()
    expect(label.querySelector('.ws-clip-name')!.textContent).toBe('X')
    expect(el.getAttribute('aria-label')).toBe('X (by Tyler G)')
  })

  it('renders disc (initials, hover sentence, color, help attrs), name and hidden tail', () => {
    const { el, label } = makeClip()
    const disc = label.querySelector<HTMLElement>('.ws-clip-origin')!
    expect(disc.textContent).toBe('TG')
    expect(disc.getAttribute('title')).toBe('by Tyler G')
    expect(disc.getAttribute('aria-label')).toBe('by Tyler G')
    expect(disc.getAttribute('role')).toBe('img')
    expect(disc.style.border).toContain('#f00')
    expect(disc.getAttribute('data-help-title')).toBe('Clip origin')
    expect(disc.getAttribute('data-help-desc')).toBeTruthy()
    // Disc precedes the name so an ellipsis can never eat it.
    expect(label.children[0]).toBe(disc)
    expect(label.querySelector('.ws-clip-name')!.textContent).toBe('Take')
    const tail = label.querySelector<HTMLElement>('.ws-clip-origin-text')!
    expect(tail.textContent).toBe(' · TG')
    expect(tail.style.display).toBe('none')
    expect(el.getAttribute('aria-label')).toBe('Take (by Tyler G)')
  })

  it('setOrigin(null) removes both origin spans and restores the plain aria-label', () => {
    const { clip, el, label } = makeClip()
    clip.setOrigin(null)
    expect(label.querySelector('.ws-clip-origin')).toBeNull()
    expect(label.querySelector('.ws-clip-origin-text')).toBeNull()
    expect(label.querySelector('.ws-clip-name')!.textContent).toBe('Take')
    expect(el.getAttribute('aria-label')).toBe('Take')
  })

  it('setOrigin is idempotent and updates an existing disc in place', () => {
    const { clip, label } = makeClip(false)
    expect(label.querySelector('.ws-clip-origin')).toBeNull()
    clip.setOrigin(origin)
    clip.setOrigin({ color: '#0f0', label: 'B', name: 'Ben' })
    const discs = label.querySelectorAll('.ws-clip-origin')
    expect(discs.length).toBe(1)
    expect(discs[0].textContent).toBe('B')
    expect((discs[0] as HTMLElement).getAttribute('title')).toBe('by Ben')
    expect(label.querySelectorAll('.ws-clip-origin-text').length).toBe(1)
    expect(label.querySelector('.ws-clip-origin-text')!.textContent).toBe(' · B')
  })

  it('no origin → plain label with just the name span', () => {
    const { el, label } = makeClip(false)
    expect(label.children.length).toBe(1)
    expect(label.querySelector('.ws-clip-name')!.textContent).toBe('Take')
    expect(el.getAttribute('aria-label')).toBe('Take')
  })

  it('getLabelElement() returns the OUTER .ws-clip-label div (host inline rename relies on it)', () => {
    const { clip, label } = makeClip()
    expect(clip.getLabelElement()).toBe(label)
    expect(label.tagName).toBe('DIV')
  })
})
