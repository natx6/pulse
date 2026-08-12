let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** Short two-tone success beep, or low buzz for errors. No audio assets needed. */
export function beep(ok = true) {
  try {
    const c = getCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.connect(gain);
    gain.connect(c.destination);
    const t = c.currentTime;
    if (ok) {
      osc.frequency.setValueAtTime(1046, t);
      osc.frequency.setValueAtTime(1568, t + 0.07);
      gain.gain.setValueAtTime(0.22, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      osc.start(t);
      osc.stop(t + 0.18);
    } else {
      osc.frequency.setValueAtTime(196, t);
      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      osc.start(t);
      osc.stop(t + 0.24);
    }
  } catch {
    // audio unavailable — ignore
  }
}
