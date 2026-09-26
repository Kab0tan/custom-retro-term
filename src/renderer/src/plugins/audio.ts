import type { AudioPayload } from '@shared/data'

/**
 * System audio for plugins (spectrum): Windows loopback capture analysed with WebAudio,
 * in this renderer. Runs only while a plugin is subscribed *and* the user has allowed it; nothing
 * is recorded or stored. Frames are pushed ~30×/s.
 */
type Listener = (p: AudioPayload) => void

const FPS = 30
const WAVE_POINTS = 512

const listeners = new Set<Listener>()
let allowed = false
let stream: MediaStream | null = null
let audioCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let timer: number | null = null
let starting: Promise<void> | null = null
let lastError: AudioPayload | null = null

const emit = (p: AudioPayload): void => listeners.forEach((l) => l(p))

/**
 * Loopback capture, two ways:
 * 1. Electron's documented desktop capture (screen source id from main + 'desktop' audio), which
 *    needs no user gesture, so it also works when restoring consent at startup.
 * 2. getDisplayMedia, answered by main's display-media handler (src/main/audio.ts).
 */
async function openLoopback(): Promise<MediaStream> {
  const errors: string[] = []
  const src = await window.crt.plugins.audioSource()
  if (!src.supported) throw new Error('system audio capture is only available on Windows for now.')
  try {
    const sourceId = src.id
    if (sourceId) {
      return await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: 16, maxHeight: 16, maxFrameRate: 1 } }
      } as unknown as MediaStreamConstraints)
    }
    errors.push('no screen source')
  } catch (err) {
    errors.push(`desktop capture: ${(err as Error).message}`)
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  } catch (err) {
    errors.push(`display media: ${(err as Error).message}`)
  }
  throw new Error(errors.join('; '))
}

async function start(): Promise<void> {
  try {
    const s = await openLoopback()
    // Only the audio is wanted, but stopping the (tiny, 1 fps) video track can end the whole
    // loopback session on Windows; disable it instead and stop it together with the audio.
    s.getVideoTracks().forEach((t) => (t.enabled = false))
    if (!s.getAudioTracks().length) throw new Error('No system audio track was provided.')
    if (!listeners.size || !allowed) {
      s.getTracks().forEach((t) => t.stop())
      return
    }
    stream = s
    audioCtx = new AudioContext()
    await audioCtx.resume() // created without a gesture; don't stay suspended (= silence)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.55
    audioCtx.createMediaStreamSource(s).connect(analyser) // not connected to the speakers: no echo
    lastError = null
    timer = window.setInterval(sample, 1000 / FPS)
  } catch (err) {
    console.warn('[audio] capture failed:', err)
    lastError = { available: false, reason: 'unavailable', message: `System audio could not be captured: ${(err as Error).message}` }
    emit(lastError)
  }
}

const waveBuf = new Float32Array(2048)
function sample(): void {
  if (!analyser || document.visibilityState === 'hidden') return
  analyser.getFloatTimeDomainData(waveBuf)
  const wave = new Float32Array(WAVE_POINTS)
  const step = waveBuf.length / WAVE_POINTS
  for (let i = 0; i < WAVE_POINTS; i++) wave[i] = waveBuf[Math.floor(i * step)]
  const spectrum = new Float32Array(analyser.frequencyBinCount)
  analyser.getFloatFrequencyData(spectrum)
  emit({ available: true, sampleRate: audioCtx!.sampleRate, wave, spectrum, minDb: analyser.minDecibels, maxDb: analyser.maxDecibels })
}

function stop(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  void audioCtx?.close()
  audioCtx = null
  analyser = null
}

function reconcile(): void {
  if (listeners.size && allowed) {
    if (!stream && !starting) starting = start().finally(() => (starting = null))
  } else {
    stop()
    if (listeners.size && !allowed) {
      emit({ available: false, reason: 'not-allowed', message: 'System audio analysis is off.' })
    }
  }
}

/** Follow the user's consent (settings.audioCapture). */
export function setAudioAllowed(v: boolean): void {
  if (allowed === v) return
  allowed = v
  reconcile()
}

export function subscribeAudio(cb: Listener): () => void {
  listeners.add(cb)
  if (!allowed) cb({ available: false, reason: 'not-allowed', message: 'System audio analysis is off.' })
  else if (lastError && !stream) cb(lastError)
  reconcile()
  return () => {
    listeners.delete(cb)
    reconcile()
  }
}
