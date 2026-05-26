import axios from 'axios';

/**
 * Servicio de integración con la API de Google Gemini.
 * Genera resúmenes estructurados y extrae identidades críticas (IMEI, SIM, RUT, etc.).
 */
export async function generateGeminiSummaryAndFacts(messages, contactName, config) {
  const apiKey = config?.geminiApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta GEMINI_API_KEY en las variables de entorno o la configuración de Supabase.');
  }

  if (!messages || messages.length === 0) {
    return {
      ai_summary: 'Sin mensajes en la conversación para resumir.',
      contact_name: contactName || null,
      contact_email: null,
      contact_phone: null,
      extracted_imei: [],
      extracted_sim: [],
      extracted_shopify_orders: [],
      extracted_st_tickets: []
    };
  }

  // 1. Formatear la conversación como una transcripción limpia.
  // Solo se incluyen mensajes del cliente (entrantes) y notas internas del equipo.
  // Los mensajes salientes del agente se excluyen del transcript para evitar que
  // datos de soporte (RUTs de transferencia, etc.) se extraigan como datos del cliente.
  const transcript = messages
    .filter((m) => {
      const type = m.message_type;
      const isCustomer = type === 0 || type === '0' || type === 'incoming';
      const isInternalNote = m.private === true || type === 2 || type === '2' || type === 'activity';
      return isCustomer || isInternalNote;
    })
    .map((m) => {
      const type = m.message_type;
      const isInternalNote = m.private === true || type === 2 || type === '2' || type === 'activity';
      const role = isInternalNote ? 'Nota Interna' : 'Cliente';
      const content = m.content || '';
      return `${role}: ${content}`;
    })
    .join('\n');

  // 2. Definir el prompt del sistema y la tarea
  const prompt = `Analiza la siguiente transcripción de soporte técnico de SoyMomo.
SoyMomo vende productos tecnológicos infantiles como relojes inteligentes con GPS (SoyMomo Original, Space, Space Lite, H2O), tablets para niños (Momo Tablet) y cámaras de bebé.

La transcripción contiene líneas de "Cliente:" (mensajes del cliente) y "Nota Interna:" (anotaciones del equipo de soporte sobre el caso).

Tu tarea es:
1. Generar un resumen breve y conciso de la conversación (máximo 2-3 oraciones), en español, que describa el problema reportado por el cliente y el estado/solución alcanzado.
2. Identificar el nombre del contacto CLIENTE (si lo mencionan en el chat de forma diferente a "${contactName || 'desconocido'}"). Solo extrae nombres de líneas "Cliente:" o "Nota Interna:" que se refieran al cliente.
3. Identificar el correo electrónico DEL CLIENTE mencionado en líneas "Cliente:" o en "Nota Interna:" que hablen del cliente.
4. Identificar el teléfono o número de WhatsApp DEL CLIENTE mencionado.
5. Extraer cualquier IMEI (número de 15 dígitos) o ID del equipo DEL CLIENTE mencionado.
6. Extraer cualquier número de SIM / ICCID mencionado (números largos de 19 o 20 dígitos).
7. Extraer cualquier número de pedido de Shopify del cliente (usualmente empieza con letras y número, ej: SM#12345 o SM12345).
8. Extraer cualquier folio de servicio técnico / orden de servicio ST del cliente (ej: formato P-1234, P1234, E1234 o similar).

IMPORTANTE: Extrae únicamente datos que pertenezcan al CLIENTE, no datos internos del equipo de soporte.

Transcripción del Chat:
"""
${transcript}
"""`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          ai_summary: { type: 'STRING', description: 'Resumen en español del chat' },
          contact_name: { type: 'STRING', description: 'Nombre completo extraído del cliente' },
          contact_email: { type: 'STRING', description: 'Email del cliente mencionado' },
          contact_phone: { type: 'STRING', description: 'Teléfono mencionado' },
          extracted_imei: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Arreglo de IMEIs de 15 dígitos extraídos'
          },
          extracted_sim: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Arreglo de números de tarjeta SIM / ICCID extraídos'
          },
          extracted_shopify_orders: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Arreglo de números de pedidos de Shopify (ej: SM#12345) extraídos'
          },
          extracted_st_tickets: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Arreglo de números de orden de servicio técnico extraídos'
          }
        },
        required: ['ai_summary']
      }
    }
  };

  try {
    const { data } = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000
    });

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('La API de Gemini retornó una respuesta vacía o con formato inesperado.');
    }

    const parsed = JSON.parse(text);
    return parsed;

  } catch (error) {
    console.error('Error al invocar Gemini API:', error.response?.data || error.message);
    throw new Error(`Gemini: ${error.response?.data?.error?.message || error.message}`);
  }
}
