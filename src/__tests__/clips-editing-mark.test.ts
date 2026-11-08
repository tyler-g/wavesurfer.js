/**
 * PIN (wavvy WVY-1666): `setEditingPeers` draws one SOLID dot per remote
 * peer editing the clip right now, in the label row between the hollow
 * origin disc and the name (so the name's ellipsis never eats it). It is
 * idempotent, `[]` / `null` removes it, and `setName` keeps it. (The clip
 * element is built once in the constructor, so there is no rebuild path.)
 */
import ClipsPlugin from '../plugins/clips.js'

beforeAll(() => {
  // jsdom has no matchMedia; the resize handles' makeDraggable reads it.
  ;(globalThis as any).matchMedia = () => ({ matches: false })
})

const origin = { color: '#f00', label: 'TG', name: 'Tyler G' }
const alice = { color: '#00ff00', name: 'Alice' }
const bob = { color: '#0000ff', name: 'Bob' }

function makeClip() {
  const plugin = ClipsPlugin.create()
  const clip = plugin.addClip({ id: 'c1', startTime: 0, duration: 2, name: 'Take', origin })
  const label = () => (clip.element as HTMLElement).querySelector<HTMLElement>('.ws-clip-label')!
  return { clip, label }
}

describe('ClipsPlugin editing mark (WVY-1666)', () => {
  it('renders solid dots between the origin disc and the name', () => {
    const { clip, label } = makeClip()
    clip.setEditingPeers([alice, bob])
    const kids = Array.from(label().children).map((c) => c.className)
    expect(kids.slice(0, 3)).toEqual(['ws-clip-origin', 'ws-clip-editing', 'ws-clip-name'])
    const mark = label().querySelector<HTMLElement>('.ws-clip-editing')!
    expect(mark.getAttribute('aria-label')).toBe('Alice, Bob editing')
    expect(mark.getAttribute('data-help-title')).toBe('Collaborator editing')
    const dots = mark.querySelectorAll<HTMLElement>('.ws-clip-editing-dot')
    expect(dots).toHaveLength(2)
    expect(dots[0].style.background).toContain('0, 255, 0')
  })

  it('is idempotent, survives setName, and clears on [] / null', () => {
    const { clip, label } = makeClip()
    clip.setEditingPeers([alice])
    const mark = label().querySelector('.ws-clip-editing')
    clip.setEditingPeers([{ ...alice }])
    expect(label().querySelector('.ws-clip-editing')).toBe(mark)
    clip.setName('Renamed')
    expect(label().querySelector('.ws-clip-editing')).not.toBeNull()
    expect(label().querySelector('.ws-clip-name')!.textContent).toBe('Renamed')
    clip.setEditingPeers([])
    expect(label().querySelector('.ws-clip-editing')).toBeNull()
    clip.setEditingPeers([bob])
    clip.setEditingPeers(null)
    expect(label().querySelector('.ws-clip-editing')).toBeNull()
  })
})
