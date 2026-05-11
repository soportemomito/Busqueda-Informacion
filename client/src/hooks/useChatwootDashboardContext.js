import { useEffect, useRef, useState } from 'react';

export const _debugEvents = [];
function logEvent(source, matched, query, detail) {
  _debugEvents.push({ ts: Date.now(), source, matched, query: query || null, detail: String(detail || '').slice(0, 300) });
  if (_debugEvents.length > 60) _debugEvents.shift();
}

function extractConvId(s) {
  if (!s) return null;
  const str = String(s);
  const m = str.match(/\/conversations\/(\d+)/);
  if (m) return Number(m[1]);
  try {
    const url = new URL(str, 'https://x');
    for (const key of ['conversation_id', 'conv_id', 'conversation', 'cw', 'cid', 'id']) {
      const v = url.searchParams.get(key);
      if (v && /^\d+$/.test(v)) return Number(v);
    }
  } catch { /* ignore */ }
  return null;
}

function pickContextFromPayload(p) {
  if (!p || typeof p !== 'object') return null;
  const conv = p.currentConversation ?? p.current_conversation ?? p.conversation ?? null;
  const id = conv?.id ?? p.conversationId ?? p.conversation_id ?? null;
  if (id == null || !Number.isFinite(Number(id)) || Number(id) <= 0) return null;
  const contact = p.contact ?? conv?.meta?.sender ?? null;
  return {
    conversationId: Number(id),
    contact: {
      name: contact?.name ?? contact?.display_name ?? null,
      email: contact?.email ?? contact?.additional_attributes?.email ?? null,
      phone: contact?.phone_number ?? contact?.phone ?? null,
    },
  };
}

function pingParent() {
  try {
    if (typeof window !== 'undefined' && window.self !== window.top) {
      window.parent.postMessage({ event: 'loaded' }, '*');
    }
  } catch { /* cross-origin */ }
}

pingParent();

export function useChatwootDashboardContext() {
  const [ctx, setCtx] = useState(null);
  const lastIdRef = useRef(null);

  function applyCtx(ctxData, source) {
    const { conversationId: id, contact } = ctxData;
    if (!id || id === lastIdRef.current) return;
    lastIdRef.current = id;
    const query = `cw ${id}`;
    logEvent(source, true, query, `conv id = ${id}`);
    setCtx({ query, conversationId: id, contact: contact || null, receivedAt: Date.now() });
  }

  useEffect(() => {
    // Leer ID desde params de la URL propia (cid={{conversation.id}} si Chatwoot lo soporta)
    const ownId = extractConvId(window.location.href);
    if (ownId) applyCtx({ conversationId: ownId, contact: null }, 'url-param');

    // Escuchar TODOS los mensajes — logear todo lo que venga del frame padre
    function onMessage(event) {
      const d = event?.data;

      // Detectar si el mensaje viene del padre (funciona cross-origin)
      let fromParent = false;
      try { fromParent = event.source === window.parent; } catch {}

      if (fromParent) {
        // Logear todo lo que Chatwoot envíe, sea el formato que sea
        const detail = d == null
          ? '(null)'
          : typeof d === 'string'
            ? d.slice(0, 300)
            : JSON.stringify(d).slice(0, 300);

        const isObj = d && typeof d === 'object';
        const isAppCtx = isObj && (d.event === 'appContext' || d.type === 'appContext');
        logEvent('chatwoot', isAppCtx, null, detail);

        if (isAppCtx) {
          const payload = d.payload ?? d.data ?? d;
          const ctxData = pickContextFromPayload(payload);
          if (ctxData) applyCtx(ctxData, 'appContext');
        }
        return;
      }

      // Mensajes de otras fuentes — solo procesar appContext
      if (!d || typeof d !== 'object') return;
      if (d.event !== 'appContext' && d.type !== 'appContext') return;
      const payload = d.payload ?? d.data ?? d;
      const ctxData = pickContextFromPayload(payload);
      if (ctxData) applyCtx(ctxData, 'appContext-other');
    }
    window.addEventListener('message', onMessage);

    // Ping periódico: Chatwoot responde con appContext cuando recibe 'loaded'
    pingParent();
    const t1 = setTimeout(pingParent, 400);
    const t2 = setTimeout(pingParent, 1000);
    const interval = setInterval(pingParent, 2000);

    // Fallback same-domain
    let pollStopped = false;
    function pollParent() {
      if (pollStopped) return;
      try {
        const id = extractConvId(window.parent.location.pathname + window.parent.location.search);
        if (id) applyCtx({ conversationId: id, contact: null }, 'parent-url');
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
