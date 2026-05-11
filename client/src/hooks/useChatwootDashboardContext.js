import { useEffect, useState } from 'react';

// Module-level capture: Chatwoot fires appContext immediately when the iframe
// loads, often before the first React useEffect runs. Storing it here ensures
// we never miss the initial event.
let _earlyPayload = null;
let _earlyReceivedAt = null;

function onRawMessage(event) {
  const d = event?.data;
  if (!d || typeof d !== 'object') return;
  if (d.event !== 'appContext' && d.type !== 'appContext') return;
  const payload = d.payload ?? d.data ?? d;
  if (!payload || typeof payload !== 'object') return;
  _earlyPayload = payload;
  _earlyReceivedAt = Date.now();
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', onRawMessage);
}

/**
 * Extracts the best search query from a Chatwoot appContext payload.
 * Priority: conversation ID → email → phone → name
 */
function pickQueryFromPayload(p) {
  if (!p || typeof p !== 'object') return '';

  // Chatwoot v3+ sends "currentConversation"; older builds use "conversation"
  const conv =
    p.currentConversation ??
    p.current_conversation ??
    p.conversation ??
    null;
  const convId = conv?.id ?? p.conversationId ?? p.conversation_id ?? null;
  if (convId != null) return `cw ${convId}`;

  // Contact fields (different key names across Chatwoot versions)
  const contact =
    p.contact ??
    p.currentContact ??
    p.current_contact ??
    null;
  const src = contact ?? p;

  const email = String(src.email || src.identifier || '').trim();
  if (email && email.includes('@')) return email;

  const phone = String(
    src.phone_number || src.phoneNumber || src.phone || ''
  ).trim();
  if (phone) return phone.replace(/\s+/g, '');

  const name = [
    src.name,
    src.first_name || src.firstName,
    src.last_name || src.lastName,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
  return name;
}

/**
 * Extracts additional contact context (name, email, phone) from the payload
 * so the UI can show it even while the search is running.
 */
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
      if (query) {
        return {
          query,
          raw: _earlyPayload,
          contact: pickContactFromPayload(_earlyPayload),
          receivedAt: _earlyReceivedAt ?? Date.now(),
        };
      }
    }
    return null;
  });

  useEffect(() => {
    // If the early payload was captured before React mounted, apply it now
    if (_earlyPayload && !ctx) {
      const query = pickQueryFromPayload(_earlyPayload);
      if (query) {
        setCtx({
          query,
          raw: _earlyPayload,
          contact: pickContactFromPayload(_earlyPayload),
          receivedAt: _earlyReceivedAt ?? Date.now(),
        });
      }
    }

    function handler(event) {
      const d = event?.data;
      if (!d || typeof d !== 'object') return;
      if (d.event !== 'appContext' && d.type !== 'appContext') return;
      const payload = d.payload ?? d.data ?? d;
      if (!payload || typeof payload !== 'object') return;
      const query = pickQueryFromPayload(payload);
      if (query) {
        setCtx({
          query,
          raw: payload,
          contact: pickContactFromPayload(payload),
          receivedAt: Date.now(),
        });
      }
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
