// Isolated-world content script. Owns the AudioContext, the one-shot
// MediaElementSource, the worklet node, video discovery / SPA re-hook,
// settings, and the fail-safe. Toggle-off is alpha=0 in-graph (the DSP is a
// bit-exact delay line at alpha 0); the graph is never disconnected and the
// context is never closed, because both can permanently silence the element.

(() => {
  if (globalThis.__staticRemover) return;
  globalThis.__staticRemover = true;

  const DEFAULTS = { alpha: 1.0, maxSuppressionDb: 12, noiseBiasDb: 3 };
  const FRAME = 2048;

  let settings = { ...DEFAULTS };
  let enabled = false;
  let ctx = null;
  let node = null;
  let safety = null;
  let modulePromise = null;
  let currentVideo = null;
  let currentSource = null;

  const sources = new WeakMap(); // element -> source (one-shot, forever)
  const blocked = new WeakSet(); // elements that must never be touched again
  let gestureArmed = false;
  let busy = false;

  function findVideo() {
    return (
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('ytd-player video.video-stream.html5-main-video') ||
      document.querySelector('video.html5-main-video')
    );
  }

  function sendState() {
    chrome.runtime.sendMessage({ type: 'state', enabled }).catch(() => {});
  }

  chrome.storage.sync.get(DEFAULTS, (v) => {
    settings = { ...DEFAULTS, ...v };
    sendState();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, c] of Object.entries(changes)) {
      if (k in DEFAULTS) settings[k] = c.newValue;
    }
    node?.port.postMessage({ type: 'config', ...settings });
  });

  async function ensureContext() {
    if (ctx?.state === 'closed') return false; // unrecoverable; never close it yourself
    if (!ctx) {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      ctx.onstatechange = () => {
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      };
    }
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    return ctx.state === 'running';
  }

  async function ensureWorklet() {
    if (node) return true;
    if (!modulePromise) {
      modulePromise = ctx.audioWorklet
        .addModule(chrome.runtime.getURL('src/audio/worklet.js'))
        .catch((e) => {
          modulePromise = null;
          throw e;
        });
    }
    await modulePromise;

    node = new AudioWorkletNode(ctx, 'static-remover', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { frameSize: FRAME, ...settings },
    });
    node.port.onmessage = (e) => {
      if (e.data?.type === 'error') console.error('[static-remover]', e.data.message);
    };
    node.onprocessorerror = () => {
      // The node outputs silence for the rest of its life; restore audio.
      safety?.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
    };
    node.connect(ctx.destination);

    safety = ctx.createGain();
    safety.gain.value = 0;
    safety.connect(ctx.destination);
    return true;
  }

  function hookVideo() {
    const v = findVideo();
    if (!v || blocked.has(v)) return false;
    if (v === currentVideo && currentSource) return true;

    let s = sources.get(v);
    if (!s) {
      try {
        s = ctx.createMediaElementSource(v); // one-shot per element, forever
      } catch (e) {
        blocked.add(v);
        console.warn('[static-remover] cannot hook video:', e);
        return false;
      }
      sources.set(v, s);
    }

    try {
      s.connect(node);
    } catch {
      // Never leave the source unconnected: that would silence the element.
      try {
        s.connect(ctx.destination);
      } catch {}
      return false;
    }
    currentVideo = v;
    currentSource = s;
    return true;
  }

  async function enable() {
    if (busy) return false;
    busy = true;
    try {
      if (!(await ensureContext())) {
        armGesture();
        return false;
      }
      await ensureWorklet();
      if (!hookVideo()) return false;
      node.port.postMessage({ type: 'enabled', value: true, ...settings });
      enabled = true;
      sendState();
      return true;
    } catch (e) {
      console.warn('[static-remover] enable failed:', e);
      return false;
    } finally {
      busy = false;
    }
  }

  function disable() {
    if (node) node.port.postMessage({ type: 'enabled', value: false });
    enabled = false;
    sendState();
    return true;
  }

  function armGesture() {
    if (gestureArmed) return;
    gestureArmed = true;
    const once = async () => {
      cleanup();
      if (!enabled) await enable();
    };
    const cleanup = () => {
      gestureArmed = false;
      for (const t of ['pointerdown', 'keydown', 'touchstart']) {
        document.removeEventListener(t, once, true);
      }
    };
    for (const t of ['pointerdown', 'keydown', 'touchstart']) {
      document.addEventListener(t, once, true);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== 'toggle') return;
    (enabled ? Promise.resolve(disable()) : enable())
      .then((ok) => reply({ enabled, ok }))
      .catch((e) => reply({ enabled, ok: false, error: String(e) }));
    return true; // async reply
  });

  // SPA + element replacement: re-hook only; never rebuild the context.
  let scheduled = false;
  function scheduleHook() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!enabled || !ctx || !node) return;
      if (currentVideo && !currentVideo.isConnected) {
        currentVideo = null;
        currentSource = null;
      }
      hookVideo();
    });
  }

  const mo = new MutationObserver(scheduleHook);
  function observePlayer() {
    const root = document.querySelector('#movie_player, ytd-player, #player') || document.body;
    mo.disconnect();
    if (root) mo.observe(root, { childList: true, subtree: true });
  }

  document.addEventListener('yt-navigate-finish', () => {
    // Also fires for quality/ads/theater; scheduleHook is idempotent.
    observePlayer();
    scheduleHook();
  });
  window.addEventListener('popstate', scheduleHook);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observePlayer, { once: true });
  } else {
    observePlayer();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ctx?.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  });
})();
