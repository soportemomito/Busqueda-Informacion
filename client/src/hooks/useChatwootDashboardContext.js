import { useEffect, useRef, useState } from 'react';

// ── debug log ─────────────────────────────────────────────────────────────────
export const _debugEvents = [];
function logEvent(source, matched, query, detail) {
  _debugEvents.push({ ts: Date.now(), source, matched, query: query || null, detail: String(detail || '').slice(0, 300) });
  if (_debugEvents.length > 40) _debugEvents.shift();
}

// ── extract conversation ID from any URL-like string ──────────────────────────
function extractConvId(s) {
  if (!s) return null;
  const str = String(s);
  // /conversations/12345  ← Chatwoot path
  const m = str.match(/\/conversations\/(\d+)/);
  if (m) return Number(m[1]);
  // ?conversation_id=X / ?id=X / ?cw=X
  try {
    const url = new URL(str, 'https://x');
    for (const key of ['conversation_id', 'conv_id', 'conversation', 'cw', 'id']) {
      const v = url.searchParams.get(key);
      if (v && /^\d+$/.test(v)) return Number(v);
    }
    const hash = url.hash.replace('#', '');
    if (/^\d{3,}$/.test(hash)) return Number(hash);
  } catch { /* ignore */ }
  return null;
}

// ── postMessage payload parser ────────────────────────────────────────────────
function pickQueryFromPayload(p) {
  if (!p || typeof p !== 'object') return '';
  const conv = p.currentConversation ?? p.current_conversation ?? p.conversation ?? null;
  const convId = conv?.id ?? p.conversationId ?? p.conversation_id ?? null;
  if (convId != null) return `cw ${convId}`;
  const contact = p.contact ?? p.currentContact ?? p.current_contact ?? null;
  const src = contact ?? p;
  const email = String(src.email || src.identifier || '').trim();
  if (email && email.includes('@')) return email;
  const phone = String(src.phone_number || src.phoneNumber || src.phone || '').trim();
  if (phone) return phone.replace(/\s+/g, '');
  return [src.name, src.first_name || src.firstName, src.last_name || src.lastName]
    .filter(Boolean).join(' ').trim();
}

// ── module-level: capture before React mounts ─────────────────────────────────
let _earlyQuery = null;

// 1. referrer (set at page load, gives the Chatwoot URL that opened this iframe)
try {
  if (document.referrer) {
    const id = extractConvId(document.referrer);
    if (id) {
      _earlyQuery = `cw ${id}`;
      logEvent('referrer', true, _earlyQuery, document.referrer);
    }
  }
} catch { /* ignore */ }

// 2. own URL params (?conversation_id=X)
try {
  const id = extractConvId(window.location.href);
  if (id && !_earlyQuery) {
    _earlyQuery = `cw ${id}`;
    logEvent('url-param', true, _earlyQuery, window.location.href);
  }
} catch { /* ignore */ }

// 3. parent URL (same-domain only — throws if cross-origin, caught below)
try {
  const id = extractConvId(window.parent.location.pathname + window.parent.location.search);
  if (id && !_earlyQuery) {
    _earlyQuery = `cw ${id}`;
    logEvent('parent-url', true, _earlyQuery, window.parent.location.href);
  }
} catch { /* cross-origin — silently ignore */ }

// 4. postMessage (fired before React mounts on some Chatwoot versions)
if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    const d = event?.data;
    if (!d || typeof d !== 'object') return;
    const matched = d.event === 'appContext' || d.type === 'appContext';
    if (!matched) {
      if (d.event || d.type) logEvent('postMessage', false, null, JSON.stringify(d).slice(0, 200));
      return;
    }
    const payload = d.payload ?? d.data ?? d;
    const query = pickQueryFromPayload(payload);
    logEvent('postMessage', true, query, JSON.stringify(d).slice(0, 200));
    if (query && !_earlyQuery) _earlyQuery = query;
  });

  // Tell Chatwoot the app is ready (triggers appContext in some versions)
  try {
    if (window.self !== window.top) {
      window.parent.postMessage({ event: 'loaded' }, '*');
      window.parent.postMessage({ event: 'ready' }, '*');
    }
  } catch { /* cross-origin */ }
}

// ── hook ──────────────────────────────────────────────────────────────────────
export function useChatwootDashboardContext() {
  const [ctx, setCtx] = useState(() =>
    _earlyQuery ? { query: _earlyQuery, receivedAt: Date.now() } : null
  );
  const lastIdRef = useRef(null);

  function applyId(id, source) {
    if (!id || id === lastIdRef.current) return;
    lastIdRef.current = id;
    const query = `cw ${id}`;
    logEvent(source, true, query, `conv id = ${id}`);
    setCtx({ query, receivedAt: Date.now() });
  }

  useEffect(() => {
    // Apply early result captured before React mounted
    if (_earlyQuery && !ctx) {
      const id = extractConvId(_earlyQuery);
      if (id) lastIdRef.current = id;
      setCtx({ query: _earlyQuery, receivedAt: Date.now() });
    }

    // ── POLLING: read parent URL every 600 ms ─────────────────────────────
    // Works when Chatwoot and this app share the same domain/subdomain.
    // Cross-origin access throws → we catch it and stop polling (harmless).
    let pollStopped = false;
    function poll() {
      if (pollStopped) return;
      try {
        const parentPath = window.parent.location.pathname + window.parent.location.search;
        const id = extractConvId(parentPath);
        if (id) applyId(id, 'parent-url-poll');
        setTimeout(poll, 600);
      } catch {
        // Cross-origin — stop trying
        logEvent('parent-url-poll', false, null, 'cross-origin blocked');
        pollStopped = true;
      }
    }
    const pollTimer = setTimeout(poll, 300);

    // ── hashchange / popstate (if Chatwoot updates our iframe URL) ────────
    function handleUrlChange() {
      const id = extractConvId(window.location.href);
      if (id) applyId(id, 'url-change');
    }
    window.addEventListener('hashchange', handleUrlChange);
    window.addEventListener('popstate', handleUrlChange);

    // ── postMessage fallback ──────────────────────────────────────────────
    function msgHandler(event) {
      const d = event?.data;
      if (!d || typeof d !== 'object') return;
      if (d.event !== 'appContext' && d.type !== 'appContext') return;
      const payload = d.payload ?? d.data ?? d;
      const query = pickQueryFromPayload(payload);
      if (!query) return;
      logEvent('postMessage', true, query, '');
      const id = extractConvId(query);
      if (id) applyId(id, 'postMessage');
      else setCtx({ query, receivedAt: Date.now() });
    }
    window.addEventListener('message', msgHandler);

    // Re-send ready signals
    try {
      if (window.self !== window.top) {
        window.parent.postMessage({ event: 'loaded' }, '*');
        window.parent.postMessage({ event: 'ready' }, '*');
      }
    } catch { /* cross-origin */ }

    return () => {
      pollStopped = true;
      clearTimeout(pollTimer);
      window.removeEventListener('hashchange', handleUrlChange);
      window.removeEventListener('popstate', handleUrlChange);
      window.removeEventListener('message', msgHandler);
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
