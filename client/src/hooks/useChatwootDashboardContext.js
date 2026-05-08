import { useEffect, useState } from 'react';

function pickQueryFromPayload(p) {
  if (!p || typeof p !== 'object') return '';

  // Prioridad: ID de conversación → búsqueda más completa (mensajes, IMEI, cruce histórico)
  const convId = p.conversation?.id ?? p.conversationId;
  if (convId != null) return `cw ${convId}`;

  // Fallback: email → teléfono → nombre del contacto
  const contact = p.contact || p.currentContact || p;
  const email = (contact.email || contact.identifier || '').trim();
  if (email && email.includes('@')) return email;
  const phone = (contact.phone_number || contact.phoneNumber || contact.phone || '').trim();
  if (phone) return phone.replace(/\s+/g, '');
  const name = [contact.name, contact.last_name || contact.lastName].filter(Boolean).join(' ').trim();
  return name || '';
}

/**
 * Dashboard App de Chatwoot: evento appContext por postMessage.
 */
export function useChatwootDashboardContext() {
  const [ctx, setCtx] = useState(null);

  useEffect(() => {
    const handler = (event) => {
      const d = event.data;
      if (d == null || typeof d !== 'object') return;
      if (d.event !== 'appContext' && d.type !== 'appContext') return;
      const payload = d.payload ?? d.data ?? d;
      const query = pickQueryFromPayload(payload);
      if (query) setCtx({ query, raw: payload, receivedAt: Date.now() });
    };
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
    return false;
  }
}
