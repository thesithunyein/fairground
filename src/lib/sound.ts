// FAIRGROUND — WebAudio sound kit. Zero files; every sound is synthesized.
// Mute state persists in localStorage. Audio context resumes on first gesture.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

const MUTE_KEY = 'fairground.muted';

export function initSound(): void {
  try {
    muted = localStorage.getItem(MUTE_KEY) === '1';
  } catch { /* default unmuted */ }
}

export function isMuted(): boolean {
  return muted;
}

export function toggleMute(): boolean {
  muted = !muted;
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch { /* ignore */ }
  return muted;
}

function ac(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freq: number, dur: number, type: OscillatorType, vol: number, delay = 0, slideTo?: number): void {
  const c = ac();
  if (!c || !master) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(dur: number, vol: number, delay = 0, hp = 800): void {
  const c = ac();
  if (!c || !master) return;
  const t0 = c.currentTime + delay;
  const frames = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, frames, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = hp;
  const gain = c.createGain();
  gain.gain.value = vol;
  src.connect(filter).connect(gain).connect(master);
  src.start(t0);
}

/** One ratchet tick — pitch rises with wheel speed. */
export function tick(speed01: number): void {
  tone(700 + 900 * speed01, 0.03, 'square', 0.05 + 0.05 * speed01);
}

/** Wooden clack when the wheel lands. */
export function land(): void {
  noise(0.09, 0.5, 0, 400);
  tone(180, 0.12, 'triangle', 0.35, 0, 90);
}

/** Result sting — different flavor per tier. */
export function sting(tier: 0 | 1 | 2, won: boolean, big: boolean): void {
  if (!won) {
    tone(220, 0.16, 'sine', 0.18);
    tone(165, 0.22, 'sine', 0.16, 0.12);
    return;
  }
  if (tier === 0) {
    tone(523, 0.12, 'sine', 0.22);
    tone(659, 0.16, 'sine', 0.2, 0.09);
  } else if (tier === 1) {
    tone(523, 0.1, 'square', 0.14);
    tone(659, 0.1, 'square', 0.14, 0.08);
    tone(784, 0.18, 'square', 0.16, 0.16);
  } else {
    tone(523, 0.09, 'square', 0.16);
    tone(659, 0.09, 'square', 0.16, 0.07);
    tone(784, 0.09, 'square', 0.18, 0.14);
    tone(1047, 0.22, 'square', 0.2, 0.21);
    if (big) {
      tone(1319, 0.3, 'triangle', 0.24, 0.32);
      noise(0.25, 0.25, 0.32, 1200);
    }
  }
}

/** Prize drop whoosh + pop. */
export function prize(revealDelay = 0.35): void {
  noise(0.18, 0.2, revealDelay, 900);
  tone(880, 0.09, 'sine', 0.22, revealDelay + 0.16);
  tone(1175, 0.12, 'sine', 0.2, revealDelay + 0.24);
}

/** Set-complete / livery-unlock fanfare. */
export function fanfare(): void {
  const seq = [523, 659, 784, 1047, 1319];
  seq.forEach((f, i) => tone(f, 0.14, 'square', 0.2, i * 0.09));
  tone(1568, 0.34, 'triangle', 0.26, seq.length * 0.09);
}

/** Soft UI click. */
export function click(): void {
  tone(1100, 0.025, 'square', 0.06);
}

/** Near-miss: landed next to a risky wedge — wistful two-note drop. */
export function nearMiss(): void {
  tone(392, 0.12, 'triangle', 0.16);
  tone(311, 0.2, 'triangle', 0.15, 0.12);
}

/** Hot-streak riser: two quick notes pitched up with every consecutive win. */
export function streakRiser(streak: number): void {
  const base = 440 * Math.pow(1.059, Math.min(streak, 8));
  tone(base, 0.06, 'square', 0.09);
  tone(base * 1.26, 0.09, 'square', 0.1, 0.06);
}
