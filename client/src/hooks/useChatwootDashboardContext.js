import { useEffect, useState } from 'react';

// Module-level: capture events before React mounts, and keep a debug log
let _earlyPayload = null;
let _earlyReceivedAt = null;
export const _debugEvents = []; // exported for debug panel

function logDebug(raw, matched, query) {
  _debugEvents.push({ ts: Date.now(), matched, query: query || null, keys: Object.keys(raw || {}) });
  if (_debugEvents.length > 30) _debugEvents.shift();
}

function onRawMessage(event) {
  const d = event?.data;
  if (!d || typeof d !== 'object') return;
  const matched = d.event === 'appContext' || d.type === 'appContext';
  if (!matched) {
    // Log non-matching events too (helps debug wrong event names)
    if (d.event || d.type) logDebug(d, false, null);
    return;
  }
  const payload = d.payload ?? d.data ?? d;
  const query = pickQueryFromPayload(payload);
  logDebug(d, true, query);
  if (!payload || typeof payload !== 'object') return;
  _earlyPayload = payload;
  _earlyReceivedAt = Date.now();
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', onRawMessage);
}

function pickQueryFromPayload(p) {
  if (!p || typeof p !== 'object') return '';
  // Chatwoot v3 uses "currentConversation"; older builds use "conversation"
  const conv =
    p.currentConversation ??
    p.current_conversation ??
    p.conversation ??
    null;
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

export function useChatwootDashboardContext() {
  const [ctx, setCtx] = useState(() => {
    if (_earlyPayload) {
      const query = pickQueryFromPayload(_earlyPayload);
      if (query) return { query, raw: _earlyPayload, contact: pickContactFromPayload(_earlyPayload), receivedAt: _earlyReceivedAt ?? Date.now() };
    }
    return null;
  });

  useEffect(() => {
    // Apply early payload if it was missed in the initializer
    if (_earlyPayload && !ctx) {
      const query = pickQueryFromPayload(_earlyPayload);
      if (query) setCtx({ query, raw: _earlyPayload, contact: pickContactFromPayload(_earlyPayload), receivedAt: _earlyReceivedAt ?? Date.now() });
    }

    // Proactively ask the parent frame to re-send the context.
    // Some Chatwoot builds respond to this; others ignore it (harmless).
    try {
      if (window.self !== window.top) {
        window.parent.postMessage({ event: 'request-context' }, '*');
      }
    } catch { /* cross-origin, ignore */ }

    function handler(event) {
      const d = event?.data;
      if (!d || typeof d !== 'object') return;
      if (d.event !== 'appContext' && d.type !== 'appContext') return;
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
