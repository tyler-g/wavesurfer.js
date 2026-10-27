import WebAudioPlayer from '../webaudio.js'

/**
 * Regression tests for the project-duration lift (the "1-minute wall").
 *
 * Each Wavvy track's WebAudioPlayer holds a silent placeholder buffer sized to
 * the projectDuration at track creation. When the timeline later grows, the
 * player's buffer is NOT regrown — so its logical duration must be liftable
 * past the physical buffer length, or the player self-pauses at the old end,
 * freezes currentTime (which the master transport reads), and clamps
 * play-from-position back to 0.
 */

const createMockAudioContext = () => {
  let now = 0
  const createdSources: any[] = []
  const ctx = {
    get currentTime() {
      return now
    },
    advance(seconds: number) {
      now += seconds
    },
    destination: {},
    createGain: () => ({
      gain: { value: 1 },
      connect: jest.fn(),
      disconnect: jest.fn(),
    }),
    createBufferSource: () => {
      const node = {
        buffer: null as AudioBuffer | null,
        playbackRate: { value: 1 },
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        onended: null as (() => void) | null,
        connect: jest.fn(),
        disconnect: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
        addEventListener: jest.fn(),
      }
      createdSources.push(node)
      return node
    },
    createdSources,
  }
  return ctx
}

const createPlayer = (bufferDuration: number) => {
  const ctx = createMockAudioContext()
  const player = new WebAudioPlayer(ctx as unknown as AudioContext)
  player.setAudioBuffer({ duration: bufferDuration, numberOfChannels: 1 } as AudioBuffer)
  return { player, ctx }
}

describe('WebAudioPlayer projectDuration lift', () => {
  test('duration is the max of buffer duration and project duration', () => {
    const { player } = createPlayer(60)
    expect(player.duration).toBe(60)
    player.setProjectDuration(92)
    expect(player.duration).toBe(92)
    // Shrinking below the buffer never truncates the real audio
    player.setProjectDuration(30)
    expect(player.duration).toBe(60)
  })

  test('does not self-pause when the buffer ends before the project end', () => {
    const { player, ctx } = createPlayer(60)
    player.setProjectDuration(92)
    const onEnded = jest.fn()
    player.on('ended', onEnded)

    player.play()
    ctx.advance(60)
    // The placeholder buffer's source node ends at 60s
    ctx.createdSources[0].onended?.()

    expect(player.paused).toBe(false)
    expect(onEnded).not.toHaveBeenCalled()
    // currentTime keeps advancing off the clock past the buffer end
    ctx.advance(10)
    expect(player.currentTime).toBeCloseTo(70)
  })

  test('still self-pauses at the true end when project matches the buffer', () => {
    const { player, ctx } = createPlayer(60)
    player.setProjectDuration(60)
    const onEnded = jest.fn()
    player.on('ended', onEnded)

    player.play()
    ctx.advance(60)
    ctx.createdSources[0].onended?.()

    expect(player.paused).toBe(true)
    expect(onEnded).toHaveBeenCalled()
  })

  test('play from a position past the buffer end does not reset to 0', () => {
    const { player, ctx } = createPlayer(60)
    player.setProjectDuration(92)

    player.currentTime = 70
    player.play()

    expect(player.currentTime).toBeCloseTo(70)
    ctx.advance(5)
    expect(player.currentTime).toBeCloseTo(75)
  })

  test('playAt from a position past the buffer end does not reset to 0', () => {
    const { player, ctx } = createPlayer(60)
    player.setProjectDuration(92)

    player.currentTime = 70
    player.playAt(ctx.currentTime)

    expect(player.currentTime).toBeCloseTo(70)
    ctx.advance(5)
    expect(player.currentTime).toBeCloseTo(75)
  })

  test('play from a position past the project end still resets to 0', () => {
    const { player } = createPlayer(60)
    player.setProjectDuration(92)

    player.currentTime = 100
    player.play()

    expect(player.currentTime).toBeCloseTo(0)
  })
})

/**
 * wavvy WVY-1506: a scheduled start (`playAt(when)` with `when` in the future)
 * reads as its start position until the audio clock reaches `when`. Before
 * this, `currentTime` ran from `start − remaining lead` up to the start, so
 * every host track cursor was drawn BEFORE the play point through the
 * transport start lead while the host ruler held on it (cardinal rule 10).
 */
describe('scheduled start holds the position (wavvy WVY-1506)', () => {
  test('currentTime holds the start position until the scheduled when', () => {
    const { player, ctx } = createPlayer(60)
    player.currentTime = 8
    const t0 = ctx.currentTime
    player.playAt(t0 + 0.09)

    expect(player.currentTime).toBe(8)
    ctx.advance(0.05)
    expect(player.currentTime).toBe(8)
    ctx.advance(0.0399)
    expect(player.currentTime).toBe(8)
    ctx.advance(0.0101) // t0 + 0.1
    expect(player.currentTime).toBeCloseTo(8.01, 9)
  })

  test('pauseAt inside the lead never moves the position backwards', () => {
    const { player, ctx } = createPlayer(60)
    player.currentTime = 8
    player.playAt(ctx.currentTime + 0.09)
    ctx.advance(0.03)
    player.pauseAt(ctx.currentTime)
    expect(player.currentTime).toBe(8)
  })

  test('pauseAt after the scheduled when is unchanged', () => {
    const { player, ctx } = createPlayer(60)
    player.currentTime = 8
    player.playAt(ctx.currentTime + 0.09)
    ctx.advance(0.09 + 1)
    player.pauseAt(ctx.currentTime)
    expect(player.currentTime).toBeCloseTo(9, 9)
  })

  test('pause() inside the lead never moves the position backwards', () => {
    const { player, ctx } = createPlayer(60)
    player.currentTime = 8
    player.playAt(ctx.currentTime + 0.09)
    ctx.advance(0.03)
    player.pause()
    expect(player.currentTime).toBe(8)
  })

  test('loop region: holds through the lead, then wraps exactly as before', () => {
    const { player, ctx } = createPlayer(60)
    player.setLoopRegion(1, 3)
    player.currentTime = 2.5
    player.playAt(ctx.currentTime + 0.09)

    expect(player.currentTime).toBe(2.5)
    ctx.advance(0.05)
    expect(player.currentTime).toBe(2.5)
    ctx.advance(0.04 + 0.7)
    expect(player.currentTime).toBeCloseTo(1.2, 9)
  })

  test('a late start (when in the past) still reads ahead immediately', () => {
    const { player, ctx } = createPlayer(60)
    ctx.advance(10)
    player.currentTime = 8
    player.playAt(ctx.currentTime - 0.5)
    expect(player.currentTime).toBeCloseTo(8.5, 9)
  })
})
