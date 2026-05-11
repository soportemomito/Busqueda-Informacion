import { useEffect, useRef, useState } from 'react';

export const _debugEvents = [];
function logEvent(source, matched, query, detail) {
  _debugEvents.push({ ts: Date.now(), source, matched, query: query || null, detail: String(detail || '').slice(0, 300) });
  if (_debugEvents.length > 40) _debugEvents.shift();
}

function extractConvId(s) {
  if (!s) return null;
  const str = String(s);
  const m = str.match(/\/conversations\/(\d+)/);
  if (m) return Number(m[1]);
  try {
    const url = new URL(str, 'https://x');
    for (const key of ['conversation_id', 'conv_id', 'conversation', 'cw', 'id']) {
      const v = url.searchParams.get(key);
      if (v && /^\d+$/.test(v)) return Number(v);
    }
  } catch { /* ignore */ }
  return null;
}

function pickConvIdFromPayload(p) {
  if (!p || typeof p !== 'object') return null;
  const conv = p.currentConversation ?? p.current_conversation ?? p.conversation ?? null;
  const id = conv?.id ?? p.conversationId ?? p.conversation_id ?? null;
  return id != null ? Number(id) : null;
}

// Enviar 'loaded' al padre — Chatwoot responde con appContext (incluyendo el ID de conversación actual)
function pingParent() {
  try {
    if (typeof window !== 'undefined' && window.self !== window.top) {
      window.parent.postMessage({ event: 'loaded' }, '*');
    }
  } catch { /* cross-origin */ }
}

// Primer ping antes de que React monte
pingParent();

export function useChatwootDashboardContext() {
  const [ctx, setCtx] = useState(null);
  const lastIdRef = useRef(null);

  function applyId(id, source) {
    if (!id || id === lastIdRef.current) return;
    lastIdRef.current = id;
    const query = `cw ${id}`;
    logEvent(source, true, query, `conv id = ${id}`);
    setCtx({ query, receivedAt: Date.now() });
  }

  useEffect(() => {
    // Leer ID desde URL propia (si Chatwoot lo pasa como param)
    const ownId = extractConvId(window.location.href);
    if (ownId) applyId(ownId, 'url-param');

    // Escuchar appContext de Chatwoot
    function onMessage(event) {
      const d = event?.data;
      if (!d || typeof d !== 'object') return;
      if (d.event !== 'appContext' && d.type !== 'appContext') {
        if (d.event || d.type) logEvent('postMessage', false, null, JSON.stringify(d).slice(0, 200));
        return;
      }
      const payload = d.payload ?? d.data ?? d;
      logEvent('postMessage', true, null, JSON.stringify(d).slice(0, 200));
      const convId = pickConvIdFromPayload(payload);
      if (convId) applyId(convId, 'postMessage');
    }
    window.addEventListener('message', onMessage);

    // Ping periódico: cada 2s enviamos 'loaded' y Chatwoot responde con el contexto actual.
    // Así detectamos cambios de conversación aunque el watcher interno de Chatwoot no dispare.
    pingParent();
    const t1 = setTimeout(pingParent, 400);
    const t2 = setTimeout(pingParent, 1000);
    const interval = setInterval(pingParent, 2000);

    // Fallback same-domain: polling de parent URL (falla silenciosamente si cross-origin)
    let pollStopped = false;
    function pollParent() {
      if (pollStopped) return;
      try {
        const id = extractConvId(window.parent.location.pathname + window.parent.location.search);
        if (id) applyId(id, 'parent-url');
        setTimeout(pollParent, 600);
      } catch {
        logEvent('parent-url', false, null, 'cross-origin blocked');
        pollStopped = true;
      }
    }
    setTimeout(pollParent, 300);

    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(t1);
      clearTimeout(t2);
      clearInterval(interval);
      pollStopped = true;
    };
  }, []);

  return ctx;
}

export function isDashboardEmbed() {
  try {
    if (typeof window === 'undefined') return false;
    if (new URLSearchParams(window.location.search).get('embed') === '1') return true;
    return window.self !== window.top;
  } catch {
    return true;
  }
}
