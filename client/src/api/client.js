export async function fetchSearch(q) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  const res = await fetch(`/api/search?${params.toString()}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function fetchConfig() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('No se pudo cargar la configuración');
  return res.json();
}

export async function fetchSetup() {
  const res = await fetch('/api/setup');
  if (!res.ok) throw new Error('No se pudo cargar el estado del servidor');
  return res.json();
}

export async function saveConfig(body) {
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error al guardar');
  return data;
}

export async function fetchContactPreview(convId) {
  const res = await fetch(`/api/search/contact-preview?convId=${convId}`);
  if (!res.ok) return { name: null, email: null, phone: null };
  return res.json();
}

export async function resolveChatwootConversation(conversationId) {
  const res = await fetch('/api/chatwoot/conversations/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'No se pudo resolver la conversación');
  return data;
}

export async function fetchConversationSummary(conversationId) {
  const res = await fetch(`/api/conversations/${conversationId}/summary`);
  if (!res.ok) return null;
  return res.json();
}
