import { createHmac, timingSafeEqual } from 'crypto';
import { Router } from 'express';
import { getSupabase, upsertDeviceFacts } from '../lib/supabase.js';
import { extractDeviceFactsFromText } from '../lib/extractDeviceFacts.js';
import { generateLocalHeuristicSummary } from '../services/gemini.js';
import { resolveCredentials } from '../lib/resolveCredentials.js';
import { writeAttributesToChatwoot } from '../services/chatwoot_writeback.js';

export const webhookRouter = Router();

const ST_CONTEXT_RE = /ST|servicio\s*t[eé]cnico/i;
const ORDER_TOKEN_RE = /[PES]-?\d+/gi;
const SHOPIFY_ORDER_IN_MSG_RE = /\b[A-Za-z]{1,4}#\d{3,8}\b/g;

function extractStOrdersFromText(text) {
  if (!text || typeof text !== 'string') return [];
  if (!ST_CONTEXT_RE.test(text)) return [];
  const raw = text.match(new RegExp(ORDER_TOKEN_RE.source, 'gi')) || [];
  return [...new Set(raw.map((x) => x.toUpperCase().replace(/\s/g, '')))];
}

function extractAiSummary(customAttributes) {
  if (!customAttributes || typeof customAttributes !== 'object') return null;
  const keys = [
    'gemini_summary',
    'geminiSummary',
    'ai_summary',
    'summary',
    'resumen_gemini',
    'conversation_summary',
    'ai_conversation_summary',
    'copilot_summary',
    'resumen',
    'resumen_ia',
    'resumen_chat',
    'chat_summary',
    'descripcion',
    'description',
    'nota_st',
    'st_resumen',
  ];
  for (const k of keys) {
    const v = customAttributes[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function extractSummaryFromMessageContent(content) {
  if (!content || typeof content !== 'string') return null;
  const clean = content.replace(/<[^>]+>/g, ' ').trim();
  
  const prefixes = [
    /^(?:resumen\s*(?:ia|gemini|openai|gpt)?\s*[:\-–—]|\bresumen\s+de\s+(?:la\s+)?conversaci[oó]n\s*[:\-–—])/i,
    /^(?:summary\s*(?:ia|ai|gemini|openai|gpt)?\s*[:\-–—]|\bsummary\s+of\s+(?:the\s+)?conversation\s*[:\-–—])/i,
    /^(?:resumen\s+st\s*[:\-–—]|\bdiagn[oó]stico\s*[:\-–—])/i
  ];
  
  for (const prefix of prefixes) {
    if (prefix.test(clean)) {
      return clean.replace(prefix, '').trim();
    }
  }
  return null;
}

function verifySignature(secret, rawBody, header) {
  if (!secret) return true; // sin secret configurado, aceptar todo (modo dev)
  if (!header || !rawBody) return false;
  // Chatwoot envía el digest como hex plano o como "sha256=<hex>"
  const sig = header.replace(/^sha256=/i, '');
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

webhookRouter.post('/chatwoot', async (req, res) => {
  const secret = process.env.CHATWOOT_WEBHOOK_SECRET || '';
  const sigHeader = req.headers['x-chatwoot-signature'] || '';

  if (!verifySignature(secret, req.rawBody, sigHeader)) {
    console.warn('Webhook rechazado: firma inválida');
    return res.status(401).json({ error: 'Firma inválida' });
  }

  const payload = req.body;
  if (!payload || !payload.event) {
    return res.status(400).json({ error: 'Payload inválido' });
  }

  // Responder rápido para no bloquear el webhook de Chatwoot
  res.json({ ok: true });

  // Procesamiento asíncrono
  (async () => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        console.error('Supabase no configurado, omitiendo webhook');
        return;
      }

      const creds = await resolveCredentials(supabase).catch(() => null);

      const event = payload.event;
      
      // Manejar message_created
      if (event === 'message_created') {
        const messageId = payload.id;
        const conversationId = payload.conversation?.id;
        const contactId = payload.sender?.id;
        const content = payload.content || '';
        const messageType = payload.message_type != null ? String(payload.message_type) : null;
        const senderType = payload.sender?.type;

        if (!conversationId) return;

        // 1. Guardar mensaje en crudo
        await supabase.from('chatwoot_messages').upsert({
          message_id: messageId,
          conversation_id: conversationId,
          contact_id: contactId,
          content: content,
          message_type: messageType,
          sender_type: senderType,
          raw_payload: payload,
        }, { onConflict: 'message_id' });

        // 2. Extraer datos y actualizar resumen
        const conversation = payload.conversation || {};
        const contact = payload.sender?.type === 'Contact' ? payload.sender : (conversation.meta?.sender || {});
        
        const contactName = contact.name || null;
        const contactEmail = contact.email || null;
        const contactPhone = contact.phone_number || null;
        
        let aiSummary = extractAiSummary(conversation.custom_attributes);
        if (!aiSummary && content) {
          aiSummary = extractSummaryFromMessageContent(content);
        }

        // Si sigue vacío, generamos un resumen heurístico local a partir del historial del ticket
        if (!aiSummary) {
          const { data: convMessages } = await supabase
            .from('chatwoot_messages')
            .select('content, message_type, sender_type')
            .eq('conversation_id', conversationId)
            .order('created_at', { ascending: true });

          const messagesForSummary = convMessages && convMessages.length > 0 
            ? convMessages 
            : [{ content, message_type: messageType, sender_type: senderType }];
          
          aiSummary = generateLocalHeuristicSummary(messagesForSummary);
        }
        
        // Obtener historial previo para no perder arrays ni el resumen si ya existen
        const { data: existing } = await supabase
          .from('conversation_summaries')
          .select('ai_summary, extracted_imei, extracted_sim, extracted_st_tickets, extracted_shopify_orders, extracted_device_models, extracted_address')
          .eq('conversation_id', conversationId)
          .single();

        const currentImeis   = new Set(existing?.extracted_imei || []);
        const currentSims    = new Set(existing?.extracted_sim || []);
        const currentSt      = new Set(existing?.extracted_st_tickets || []);
        const currentShopify = new Set(existing?.extracted_shopify_orders || []);
        const currentModels  = new Set(existing?.extracted_device_models || []);
        const currentRuts    = new Set();
        const currentComunas = new Set();
        const currentFallas  = new Set();
        let currentAddress   = existing?.extracted_address || null;

        // 1. Extraer desde atributos personalizados de Chatwoot (donde la IA de Chatwoot o el agente escribe información)
        const customAttrs = {
          ...(conversation.custom_attributes || {}),
          ...(contact.custom_attributes || {})
        };

        const cleanRut = (val) => {
          if (!val) return null;
          const clean = String(val).replace(/[\s.-]/g, '').toUpperCase();
          if (clean.length < 8) return null;
          const num = clean.slice(0, -1);
          const dv = clean.slice(-1);
          return `${num}-${dv}`;
        };

        const parsedImei = (val) => {
          if (!val) return null;
          const clean = String(val).replace(/\D/g, '');
          return clean.length === 15 && clean.startsWith('8') ? clean : null;
        };

        const parsedSim = (val) => {
          if (!val) return null;
          const clean = String(val).replace(/\D/g, '');
          return clean.length >= 19 ? clean : null;
        };

        const rVal = cleanRut(customAttrs.rut);
        if (rVal) currentRuts.add(rVal);

        if (customAttrs.comuna) {
          currentComunas.add(String(customAttrs.comuna).trim());
        }

        const fVal = customAttrs.falla || customAttrs.tipo_falla;
        if (fVal) {
          currentFallas.add(String(fVal).trim());
        }

        const iVal = parsedImei(customAttrs.imei || customAttrs.extracted_imei);
        if (iVal) currentImeis.add(iVal);

        const sVal = parsedSim(customAttrs.sim || customAttrs.extracted_sim);
        if (sVal) currentSims.add(sVal);

        const mVal = customAttrs.modelo || customAttrs.modelo_dispositivo;
        if (mVal) currentModels.add(String(mVal).trim());

        const addrVal = customAttrs.direccion || customAttrs.address;
        if (addrVal) currentAddress = String(addrVal).trim();

        // 2. Extraer nuevos de este mensaje (solo si no es un mensaje saliente escrito por el soporte)
        const isOutgoing = messageType === '1' || messageType === 'outgoing';
        if (!isOutgoing) {
          const facts = extractDeviceFactsFromText(content);
          for (const f of facts) {
            if (f.label === 'ID / IMEI') currentImeis.add(f.value);
            if (f.label === 'ICCID / SIM') currentSims.add(f.value);
            if (f.label === 'Modelo') currentModels.add(f.value);
            if (f.label === 'RUT') currentRuts.add(f.value);
            if (f.label === 'Comuna') currentComunas.add(f.value);
            if (f.label === 'Dirección') currentAddress = f.value;
            if (f.label === 'Falla') currentFallas.add(f.value);
          }

          const newSt = extractStOrdersFromText(content);
          for (const st of newSt) currentSt.add(st);

          const newShopify = (content.match(SHOPIFY_ORDER_IN_MSG_RE) || []).map(o => o.toUpperCase());
          for (const sm of newShopify) currentShopify.add(sm);
        }

        // Guardar resumen consolidado
        await supabase.from('conversation_summaries').upsert({
          conversation_id: conversationId,
          contact_id: contact.id || null,
          contact_name: contactName,
          contact_email: contactEmail,
          contact_phone: contactPhone,
          ai_summary: aiSummary || existing?.ai_summary || null,
          extracted_imei: [...currentImeis],
          extracted_sim: [...currentSims],
          extracted_st_tickets: [...currentSt],
          extracted_shopify_orders: [...currentShopify],
          extracted_device_models: [...currentModels],
          extracted_address: currentAddress,
          last_message_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

        // Guardar en la tabla device_facts para búsquedas y cruce inteligente de similitud inmediato
        const allIdentifiers = [];
        for (const imei of currentImeis) {
          allIdentifiers.push({ label: 'ID / IMEI', value: imei, conversationId, contactId: contact.id });
        }
        for (const sim of currentSims) {
          allIdentifiers.push({ label: 'ICCID / SIM', value: sim, conversationId, contactId: contact.id });
        }
        for (const st of currentSt) {
          allIdentifiers.push({ label: 'Servicio Técnico', value: st, conversationId, contactId: contact.id });
        }
        for (const sm of currentShopify) {
          allIdentifiers.push({ label: 'Pedido Shopify', value: sm, conversationId, contactId: contact.id });
        }
        for (const rut of currentRuts) {
          allIdentifiers.push({ label: 'RUT', value: rut, conversationId, contactId: contact.id });
        }
        for (const comuna of currentComunas) {
          allIdentifiers.push({ label: 'Comuna', value: comuna, conversationId, contactId: contact.id });
        }
        if (currentAddress) {
          allIdentifiers.push({ label: 'Dirección', value: currentAddress, conversationId, contactId: contact.id });
        }
        for (const falla of currentFallas) {
          allIdentifiers.push({ label: 'Falla', value: falla, conversationId, contactId: contact.id });
        }
        if (contactEmail) {
          allIdentifiers.push({ label: 'Email', value: contactEmail, conversationId, contactId: contact.id });
        }
        if (contactPhone) {
          allIdentifiers.push({ label: 'Teléfono', value: contactPhone, conversationId, contactId: contact.id });
        }
        if (contactName) {
          allIdentifiers.push({ label: 'Nombre', value: contactName, conversationId, contactId: contact.id });
        }

        if (allIdentifiers.length > 0) {
          await upsertDeviceFacts(supabase, allIdentifiers);
        }

        // Sincronizar de vuelta a Chatwoot (Write-Back) de forma gratuita en segundo plano
        if (creds) {
          const cwAccountId = payload.account?.id || payload.conversation?.account_id || 1;
          const cwContactId = payload.sender?.id || payload.conversation?.meta?.sender?.id;
          
          writeAttributesToChatwoot(creds, cwAccountId, cwContactId, conversationId, {
            rut: [...currentRuts][0] || null,
            comuna: [...currentComunas][0] || null,
            falla: [...currentFallas].join(', ') || null,
            resumen: aiSummary || null,
            direccion: currentAddress || null,
          }).catch((err) => console.error('[chatwoot_writeback] Error en segundo plano:', err.message));
        }
      }

      // Sincronizar cambios cuando Chatwoot AI o el agente editen atributos de conversación o contacto
      if (event === 'conversation_updated') {
        const conversationId = payload.id;
        const customAttributes = payload.custom_attributes || {};
        const aiSummary = extractAiSummary(customAttributes);

        const updates = {};
        if (aiSummary) {
          updates.ai_summary = aiSummary;
        }

        const cleanRut = (val) => {
          if (!val) return null;
          const clean = String(val).replace(/[\s.-]/g, '').toUpperCase();
          if (clean.length < 8) return null;
          const num = clean.slice(0, -1);
          const dv = clean.slice(-1);
          return `${num}-${dv}`;
        };

        const parsedImei = (val) => {
          if (!val) return null;
          const clean = String(val).replace(/\D/g, '');
          return clean.length === 15 && clean.startsWith('8') ? clean : null;
        };

        const parsedSim = (val) => {
          if (!val) return null;
          const clean = String(val).replace(/\D/g, '');
          return clean.length >= 19 ? clean : null;
        };

        // Obtener historial previo para no perder arrays ni el resumen
        const { data: existing } = await supabase
          .from('conversation_summaries')
          .select('extracted_imei, extracted_sim, extracted_device_models, extracted_address, contact_name, contact_email, contact_phone')
          .eq('conversation_id', conversationId)
          .single();

        const currentImeis = new Set(existing?.extracted_imei || []);
        const currentSims = new Set(existing?.extracted_sim || []);
        const currentModels = new Set(existing?.extracted_device_models || []);
        let currentAddress = existing?.extracted_address || null;

        const rVal = cleanRut(customAttributes.rut);
        const cVal = customAttributes.comuna ? String(customAttributes.comuna).trim() : null;
        const fVal = customAttributes.falla || customAttributes.tipo_falla ? String(customAttributes.falla || customAttributes.tipo_falla).trim() : null;
        const iVal = parsedImei(customAttributes.imei || customAttributes.extracted_imei);
        const sVal = parsedSim(customAttributes.sim || customAttributes.extracted_sim);
        const mVal = customAttributes.modelo || customAttributes.modelo_dispositivo ? String(customAttributes.modelo || customAttributes.modelo_dispositivo).trim() : null;
        const addrVal = customAttributes.direccion || customAttributes.address ? String(customAttributes.direccion || customAttributes.address).trim() : null;

        if (iVal) currentImeis.add(iVal);
        if (sVal) currentSims.add(sVal);
        if (mVal) currentModels.add(mVal);
        if (addrVal) currentAddress = addrVal;

        if (aiSummary || rVal || cVal || fVal || iVal || sVal || mVal || addrVal) {
          updates.extracted_imei = [...currentImeis];
          updates.extracted_sim = [...currentSims];
          updates.extracted_device_models = [...currentModels];
          updates.extracted_address = currentAddress;
          updates.updated_at = new Date().toISOString();

          await supabase.from('conversation_summaries')
            .update(updates)
            .eq('conversation_id', conversationId);

          // También registrar nuevos hechos en la base de datos para cruce rápido
          const allIdentifiers = [];
          if (iVal) allIdentifiers.push({ label: 'ID / IMEI', value: iVal, conversationId });
          if (sVal) allIdentifiers.push({ label: 'ICCID / SIM', value: sVal, conversationId });
          if (mVal) allIdentifiers.push({ label: 'Modelo', value: mVal, conversationId });
          if (rVal) allIdentifiers.push({ label: 'RUT', value: rVal, conversationId });
          if (cVal) allIdentifiers.push({ label: 'Comuna', value: cVal, conversationId });
          if (addrVal) allIdentifiers.push({ label: 'Dirección', value: addrVal, conversationId });
          if (fVal) allIdentifiers.push({ label: 'Falla', value: fVal, conversationId });

          const contactName = payload.meta?.sender?.name || existing?.contact_name || null;
          const contactEmail = payload.meta?.sender?.email || existing?.contact_email || null;
          const contactPhone = payload.meta?.sender?.phone_number || existing?.contact_phone || null;

          if (contactEmail) allIdentifiers.push({ label: 'Email', value: contactEmail, conversationId });
          if (contactPhone) allIdentifiers.push({ label: 'Teléfono', value: contactPhone, conversationId });
          if (contactName) allIdentifiers.push({ label: 'Nombre', value: contactName, conversationId });

          if (allIdentifiers.length > 0) {
            await upsertDeviceFacts(supabase, allIdentifiers);
          }
        }
      }

    } catch (error) {
      console.error('Error procesando webhook Chatwoot:', error);
    }
  })();
});
