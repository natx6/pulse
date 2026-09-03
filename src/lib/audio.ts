// Audio beeps disabled: WebKitGTK's AudioContext.resume() deadlocks the
// main thread in GStreamer (gst_bus_timed_pop_filtered → ppoll forever),
// freezing sign-in with inputs dead. Every beep call hit this path, so even
// correct logins froze. Keep beep as a no-op until we ship a safe backend
// beep or HTMLAudio alternative. The app stays silent but never freezes.
export function beep(_ok = true) {
  // no-op — see bug report above
}
