import { useEffect, useState } from 'react';

// ── debug log (exported for the debug panel) ──────────────────────────────────
export const _debugEvents = [];

function logEvent(raw, matched, query) {
  _debugEvents.push({
    ts: Date.now(),
    matched,
    query: query || null,
    eventName: raw?.event || raw?.type || '(sin nombre)',
    keys: raw && typeof raw === 'object' ? Object.keys(raw) : [],
    preview: JSON.stringify(raw || {}).slice(0, 200),
  });
  if (_debugEvents.length > 40) _debugEvents.shift();
}

// ── payload parsing ───────────────────────────────────────────────────────────

function pickQueryFromPayload(p) {
  if (!p || typeof p !== 'object') return '';
  const conv =
    p.currentConversation ?? p.current_conversation ?? p.conversation ?? null;
  const convId = conv?.id ?? p.conversationId ?? p.conversation_id ?? null;
  if (convId != null) return `cw ${convId}`;

  const contact = p.contact ?? p.currentContact ?? p.current_contact ?? null;
  const src = contact ?? p;
  const email = String(src.email || src.identifier || '').trim();
  if (email && email.includes('@')) return email;
  const phone = String(src.phone_number || src.phoneNumber || src.phone || '').trim();
  if (phone) return phone.replace(/\s+/g, '');
  const name = [src.name, src.first_name || src.firstName, src.last_name || src.lastName]
    .filter(Boolean).join(' ').trim();
  return name;
}

export function pickContactFromPayload(p) {
  if (!p || typeof p !== 'object') return null;
  const contact = p.contact ?? p.currentContact ?? p.current_contact ?? null;
  const src = contact ?? p;
  const name = String(src.name || [src.first_name || src.firstName, src.last_name || src.lastName].filter(Boolean).join(' ') || '').trim();
  const email = String(src.email || src.identifier || '').trim();
  const phone = String(src.phone_number || src.phoneNumber || src.phone || '').trim();
  if (!name && !email && !phone) return null;
  return { name: name || null, email: email || null, phone: phone || null };
}

// ── module-level: capture events before React mounts ─────────────────────────
let _earlyPayload = null;
let _earlyReceivedAt = null;

function isAppContext(d) {
  if (!d || typeof d !== 'object') return false;
  return d.event === 'appContext' || d.type === 'appContext';
}

function onRawMessage(event) {
  const d = event?.data;
  // Log ALL events so the debug panel shows everything
  if (d !== null && d !== undefined) {
    const matched = isAppContext(d);
    const payload = matched ? (d.payload ?? d.data ?? d) : null;
    const query = payload ? pickQueryFromPayload(payload) : null;
    logEvent(d, matched, query);

    if (matched && payload && typeof payload === 'object') {
      _earlyPayload = payload;
      _earlyReceivedAt = Date.now();
    }
  }
}

if (typeof window !== 'undefined') {
  // Register before anything else so we never miss an early event
  window.addEventListener('message', onRawMessage);

  // Signal Chatwoot that the Dashboard App is ready.
  // Chatwoot listens for { event: 'loaded' } from the iframe and
  // responds with { event: 'appContext', data: { contact, currentConversation } }.
  // We send multiple variants because different Chatwoot versions use different names.
  try {
    if (window.self !== window.top) {
      window.parent.postMessage({ event: 'loaded' }, '*');
      window.parent.postMessage({ event: 'ready' }, '*');
    }
  } catch { /* cross-origin, ignore */ }
}

// ── hook ──────────────────────────────────────────────────────────────────────

export function useChatwootDashboardContext() {
  const [ctx, setCtx] = useState(() => {
    if (_earlyPayload) {
      const query = pickQueryFromPayload(_earlyPayload);
      if (query) return { query, raw: _earlyPayload, contact: pickContactFromPayload(_earlyPayload), receivedAt: _earlyReceivedAt ?? Date.now() };
    }
    return null;
  });

  useEffect(() => {
    // Apply payload captured before React mounted
    if (_earlyPayload && !ctx) {
      const query = pickQueryFromPayload(_earlyPayload);
      if (query) setCtx({ query, raw: _earlyPayload, contact: pickContactFromPayload(_earlyPayload), receivedAt: _earlyReceivedAt ?? Date.now() });
    }

    // Re-send ready signals now that React is mounted (covers slow networks)
    try {
      if (window.self !== window.top) {
        window.parent.postMessage({ event: 'loaded' }, '*');
        window.parent.postMessage({ event: 'ready' }, '*');
        window.parent.postMessage({ event: 'request-context' }, '*');
      }
    } catch { /* cross-origin, ignore */ }

    function handler(event) {
      const d = event?.data;
      if (!d || typeof d !== 'object') return;
      if (!isAppContext(d)) return;
      const payload = d.payload ?? d.data ?? d;
      if (!payload || typeof payload !== 'object') return;
      const query = pickQueryFromPayload(payload);
      if (query) setCtx({ query, raw: payload, contact: pickContactFromPayload(payload), receivedAt: Date.now() });
    }
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
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
