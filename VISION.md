# SoyMomo ST System — Visión del Producto

> Este documento es la fuente de verdad de qué hace, qué debería hacer y hacia dónde va el proyecto.
> Cualquier agente (Claude, Antigravity u otro) que trabaje en este repo debe leerlo primero.

---

## 1. Propósito

Herramienta de soporte técnico embebida como **Dashboard App dentro de Chatwoot**.  
Cuando el agente abre una conversación en Chatwoot, la app carga automáticamente el perfil consolidado del cliente cruzando datos de **Chatwoot · Shopify · Bsale · Google Sheets (ST) · Google Drive**.

El objetivo es que el agente nunca tenga que abrir otra pestaña para conocer el historial completo del cliente.

---

## 2. Plataformas de atención que manejamos

Los clientes nos contactan por:
- **WhatsApp**
- **Instagram DM**
- **Facebook Messenger**
- **Email**

Todos estos canales llegan a Chatwoot. La búsqueda debe funcionar sin importar el canal de origen.

---

## 3. Flujo principal (estado actual — funcionando)

```
Agente abre conversación en Chatwoot
    ↓
Dashboard App (nuestra web) recibe el ticketID vía Chatwoot Dashboard SDK
    ↓
Busca automáticamente por contacto (nombre / email / teléfono del perfil Chatwoot)
    ↓
Muestra ficha consolidada: identidad + historial + Shopify + Bsale + ST
```

---

## 3b. Flujo deseado (detalle explícito — referencia de implementación)

Este es el flujo que debe ejecutar el sistema en cada apertura de ticket, paso a paso:

### Paso 1 — Captura del ticket
Al abrir una conversación en Chatwoot, el panel captura automáticamente el `conversation_id`.

### Paso 2 — Datos del contacto (Chatwoot)
Leer directamente del perfil del contacto en Chatwoot (no de los mensajes):
- **Nombre** — siempre disponible
- **Correo** — puede estar vacío; ignorar si no existe
- **Teléfono** — puede estar vacío; ignorar si no existe

### Paso 3 — Búsqueda en Shopify
Con el correo **o** el teléfono del paso anterior, buscar en Shopify:
- Búsqueda por `email:correo@ejemplo.com` o `phone:+56XXXXXXXXX`
- Si se encuentran pedidos, extraer de `note_attributes`:
  - `BSALE-FOLIO` → número de boleta
  - `BSALE-FOLIO-ID` → ID interno de Bsale
  - `BSALE-FOLIO-PDF` → URL del PDF de la boleta
- Del objeto `customer` extraer: nombre, correo, teléfono y `shipping_address` (usar solo la **comuna**, nunca la dirección completa)

### Paso 4 — Cruce con Google Sheets ST
Con el correo disponible (de Chatwoot o de Shopify/customer), cruzar contra la planilla "ST":
- Hoja **"entradas"** → registros de ingreso
- Hoja **"entrada recepción"** → registros de recepción
- Hoja **"salida"** → registros de entrega/salida
- El cruce se hace por correo, nombre o número de orden (lo que esté disponible)

### Paso 5 — Construcción y presentación de la Ficha
Con todos los datos recopilados, construir la ficha del cliente con este formato:

```
Nombre:        [nombre del contacto]
Correo:        [correo]
Telefono:      [teléfono]
IMEI/ID:       [IMEI 15 dígitos o ID 10 dígitos extraído de mensajes]
SIM:           [ICCID/SIM SoyMomo extraído de mensajes]
Boletas:       [folios Bsale + enlace PDF si existe]
Pedidos:       [número(s) pedido Shopify + estado pago/envío]
Ingresos ST:   [órdenes de hojas "entradas" y "entrada recepción"]
Salidas ST:    [órdenes de hoja "salida"]
Ticket: #XXXX  "Resumen breve del ticket"  OPEN / CLOSED
Ticket: #XXXX  "Resumen breve del ticket"  OPEN / CLOSED
```

### Paso 6 — Persistencia en Supabase ✅ IMPLEMENTADO
La ficha completa se guarda en `client_profiles` (columnas `bsale_folios`, `tickets`, `ficha_markdown`, `ficha_synced_at` — migración 013) para:
- Evitar búsquedas repetidas en atenciones futuras del mismo cliente
- Acumular historial (identificado por correo > teléfono > IMEI, en orden de prioridad)
- Disponibilizar los datos en consultas futuras sin llamar a APIs externas cada vez

### Paso 7 — Ficha como NOTA DE CONTACTO en Chatwoot ✅ IMPLEMENTADO
La ficha consolidada se sincroniza automáticamente como **nota en el contacto de Chatwoot**
(`server/src/services/ficha.js`), de modo que el equipo la ve directamente en Chatwoot
**sin depender del panel web**:
- Se dispara automáticamente en cada búsqueda del panel (`/api/search`) y en cada mensaje entrante vía webhook
- Deduplicada por el marcador `📋 **Ficha ST**` (regex tolera el formato antiguo `📋 Ficha ST Consolidada`): si ya existe se actualiza (PUT), nunca se duplica
- Si el contenido no cambió, no se llama a la API (`unchanged`)
- Formato compacto: sin título grande, sin footer de sync, sin RUT. Pedidos y tickets llevan enlace directo
- Endpoint manual: `POST /api/chatwoot/contacts/:contactId/ficha` re-sincroniza desde `client_profiles`

Ver **§14 — La web no murió** y **§15 — Cómo se actualizan las notas (y por qué a veces no salen)**.

---

## 4. Identificadores de dispositivos SoyMomo

Los clientes adjuntan estos datos en los mensajes, a veces con nombres distintos al técnico. El sistema debe detectarlos sin importar la etiqueta que use el cliente.

| Tipo | Patrón | Dígitos | Ejemplo |
|------|--------|---------|---------|
| **IMEI** | 15 dígitos, empieza en `8` | 15 | `864995050123456` |
| **SIM / ICCID** | 19-20 dígitos, empieza en `89` | 19-20 | `89560012345678901234` |
| **ID de dispositivo** | 10 dígitos (derivado del IMEI: posiciones 5-14) | 10 | `9950501234` |
| **Orden Shopify** | Prefijo `SM` + 4-8 dígitos | — | `SM12345` |
| **Orden ST (Entrada/Salida)** | Prefijo `E`, `P`, `ST` + 4 dígitos, o 4 dígitos solos | — | `E1234`, `P5678`, `1234` |

**Nota crítica:** Los clientes pueden escribir "mi número es", "el código del equipo es", "ID:", "serie:", etc. El sistema extrae el valor por su formato numérico, no por su etiqueta.

---

## 5. Datos de contacto que extraemos

Del perfil Chatwoot (atributos del contacto):
- **Nombre completo**
- **Correo electrónico**
- **Número de WhatsApp / teléfono**

De los mensajes del chat (vía webhook `message_created`):
- Correo, teléfono, RUT (regex)
- IMEI, SIM, ID de dispositivo
- Modelo del dispositivo
- Color del dispositivo
- Número de orden Shopify, número de orden ST


**No almacenamos ni mostramos direcciones completas** — solo la comuna.

---

## 6. Tipo de dispositivo

Identificar la categoría del dispositivo mencionado en el chat para contextualizar rápido:

| Categoría | Modelos SoyMomo asociados |
|-----------|--------------------------|
| **Reloj / Smartwatch** | SoyMomo Space 1, 2, 3, 4, Lite, Space|
| **Tablet** | SoyMomo Tablet, Tablet Lite 2, Tablet Lite 3, Tablet Pro, Tablet Pro 2 |
| **Monitor / Baby Monitor** | Baby Monitor, Baby Monitor Lite, Baby Monitor Pro, Baby Monitor Pro 2 |
| **Celular** | Momophone Pro, Momophone|

La categoría debe mostrarse como chip visual en la Ficha del Cliente.

---

## 7. Cruce inteligente de tickets

Cuando un cliente contacta, buscar en otros tickets de Chatwoot si existe:
- Mismo email
- Mismo teléfono
- Mismo IMEI
- Mismo SIM
- Mismo nombre exacto (con tolerancia de 1 error tipográfico)

**Objetivo:** Detectar cuando la pareja, familiar u otro representante del mismo cliente ya consultó por el mismo equipo, evitando responder dos veces lo mismo o contradecirse.

El cruce ya está implementado en `SectionSimilarTickets`. Continuar mejorándolo.

---

## 8. Resumen del chat (IA)

### Estrategia (sin costo si no hay API key)

```
1. Si hay GEMINI_API_KEY configurada → llamar Gemini 2.5 Flash (gratuito con límites)
2. Si no → intentar el resumen propio de Chatwoot AI (si está configurado)
3. Si no → generar resumen heurístico local 100% gratuito (ya implementado en generateLocalHeuristicSummary)
```

El resumen se genera **automáticamente por webhook** en cada nuevo mensaje y se guarda en Supabase (`conversation_summaries.ai_summary`).

### Datos que extrae la IA / heurístico

- Resumen ejecutivo del problema
- Sentimiento del cliente (positive / neutral / negative / frustrated)
- Complejidad del caso (low / medium / high)
- Dispositivos mencionados (modelo + IMEI + SIM)
- Órdenes de servicio técnico
- Órdenes Shopify

### Visión futura con IA

Investigar la posibilidad de usar un modelo IA (Claude API, Gemini API u otro) para:
- Contextualizar la conversación completa y extraer datos con mayor precisión
- Sugerir respuestas basadas en el historial del cliente
- Identificar patrones de fallas por modelo de dispositivo

**Restricción importante:** No se quiere depender de una API key obligatoria. Cualquier IA debe ser opcional con fallback local gratuito.

---

## 9. Servicio Técnico (Google Sheets)

Cuando el cliente ingresó su equipo a servicio técnico, el sistema puede identificar su orden a través del email o nombre buscando en:

- **Hoja "Entrada recepción"** — órdenes de ingreso
- **Hoja "Entrada"** — registro de entrada
- **Hoja "Salida"** — informe de salida/reparación

Para cada orden encontrada, mostrar **solo un botón de acceso directo** al informe correspondiente (entrada y/o salida en caso de no estar el de salida, solo el de entrada). No necesitamos mostrar todos los datos inline — el botón es suficiente.

Esto ya está implementado en `SectionServiceOrders` con botones "Ver Informe Entrada ↗" y "Ver Informe Salida ↗".

---

## 10. Gestión de tickets desde la ficha

Acciones disponibles directamente desde nuestra app sin abrir Chatwoot:

| Acción | Estado |
|--------|--------|
| Ver tickets abiertos del contacto | ✅ Implementado |
| Abrir ticket en Chatwoot (link) | ✅ Implementado |
| Marcar ticket como resuelto | ✅ Implementado (`Marcar Resuelta`) |
| Agregar/quitar etiqueta ST | ✅ Implementado |
| Enviar ficha como nota interna (conversación) | ✅ Implementado |
| Ficha como nota de CONTACTO (auto-sync, sin panel) | ✅ Implementado (`services/ficha.js`) |
| Re-sincronizar ficha manualmente | ✅ `POST /api/chatwoot/contacts/:id/ficha` |

---

## 11. Arquitectura técnica

```
client/          → React + Vite + TailwindCSS (Dashboard App Chatwoot)
server/          → Node.js + Express
  routes/        → API endpoints
  services/      → Integraciones externas (Chatwoot, Shopify, Bsale, Drive, Gemini)
  db/            → Acceso a Supabase
  lib/           → Utilitarios (extractor, nameMatch, searchPlan, etc.)
supabase/        → Migraciones y esquema de base de datos
```

### Tablas clave en Supabase (Dash CS)

| Tabla | Contenido |
|-------|-----------|
| `chatwoot_messages` | Todos los mensajes crudos recibidos por webhook |
| `conversation_summaries` | Resumen + entidades extraídas por conversación |
| `client_profiles` | Perfil consolidado por contacto Chatwoot |
| `device_facts` | Índice de búsqueda rápida por IMEI/SIM/email/etc. |
| `sheets_service_orders` | Caché de órdenes ST desde Google Sheets |

---

## 12. Roadmap de mejoras pendientes

### Alta prioridad

- [x] **Clasificación de tipo de dispositivo** — chip en la Ficha del panel (`getDeviceCategory` en SearchPage.jsx) y en la ficha de nota de contacto (`getDeviceCategory` en services/ficha.js)
- [x] **Detección de ID de 10 dígitos libre en mensajes** — implementado en `services/extractor.js` con validación de contexto (palabras: id, reloj, equipo, imei, etc.)
- [x] **Mejor extracción de número de orden Shopify sin prefijo** — implementado en `services/extractor.js` (5-7 dígitos con contexto: pedido, compra, orden, shopify)
- [x] **Persistencia automática de la ficha en `client_profiles`** — en cada búsqueda del panel y cada mensaje del webhook (fix crítico: bug de scope de `aiData` en webhook.js impedía TODO el guardado)

### Media prioridad

- [ ] **Modo solo ficha (CLI / config)** — opción para mostrar solo la Ficha del Cliente y ocultar las secciones colapsables, ideal para pantallas pequeñas o flujos rápidos
- [ ] **Investigar integración IA más profunda** — evaluar Claude API para contextualización completa de la conversación, manteniendo el fallback local gratuito
- [ ] **Mejora del resumen heurístico** — más patrones de fallas y mejor estructura del texto generado

### Baja prioridad / Futuro

- [ ] **Estadísticas por tipo de falla / modelo** — dashboard interno para el equipo ST
- [ ] **Notificaciones push** — alertar cuando se detecta un IMEI con historial de ST reciente

---

## 13. Trabajo con agentes (Claude · Antigravity)

Este proyecto puede ser trabajado simultáneamente por **agentes Claude** y **agentes Antigravity**.

### Reglas de colaboración entre agentes

1. **Leer este archivo primero** antes de hacer cualquier cambio
2. **No romper el webhook** — es el corazón del sistema. Cualquier cambio en `server/src/routes/webhook.js` debe ser cuidadoso
3. **Mantener los fallbacks** — la IA nunca es obligatoria; el heurístico local siempre debe funcionar sin API keys
4. **Supabase**: el proyecto tiene acceso a **Dash CS** en Supabase. Las credenciales están en `server/.env`
5. **No almacenar direcciones completas** — solo la comuna. Esta es una decisión de privacidad deliberada.
6. **Los cambios de frontend** requieren rebuild: `cd client && npm run build`

### Variables de entorno clave

```
CHATWOOT_BASE_URL         — URL base de Chatwoot
CHATWOOT_API_TOKEN        — Token API de Chatwoot
CHATWOOT_ACCOUNT_ID       — ID de la cuenta en Chatwoot
CHATWOOT_WEBHOOK_SECRET   — Secret para verificar firma HMAC del webhook
SUPABASE_URL              — Proyecto Dash CS
SUPABASE_SERVICE_KEY      — Service Role Key de Supabase
SHOPIFY_STORE_DOMAIN      — Dominio de la tienda Shopify
SHOPIFY_ACCESS_TOKEN      — Token de acceso Shopify Admin API
BSALE_ACCESS_TOKEN        — Token API de Bsale
GEMINI_API_KEY            — (Opcional) Gemini 2.5 Flash para resúmenes IA
DRIVE_PARENT_FOLDER_ID    — Carpeta raíz de Drive con informes ST
DRIVE_SERVICE_ACCOUNT_KEY — JSON de cuenta de servicio Google Drive
GOOGLE_SHEETS_ID          — ID de la planilla de Google Sheets con órdenes ST
SHEETS_SYNC_INTERVAL_MIN  — (Opcional) Minutos entre auto-sync de la planilla ST. Default 30. 0 = desactivado
```

---

## 14. ¿La web murió? — NO, pero ya no es obligatoria

**La web/panel sigue 100% viva y funcionando.** Lo que cambió es que **ya no dependes de ella** para ver la información del cliente, porque ahora todo se escribe como **nota de contacto en Chatwoot**.

Hay que pensar en dos canales que hacen lo mismo (sincronizar la ficha) pero se disparan distinto:

| | **Panel web** (`/api/search`) | **Webhook** (`/api/webhook/chatwoot`) |
|---|---|---|
| **Cuándo corre** | Cuando alguien abre el ticket en el panel embebido | Automático, en cada mensaje entrante del cliente |
| **Datos que trae** | Los más completos: Shopify + Bsale **en vivo**, cruce histórico, similar-tickets | Lo extraído del mensaje + ST por email/nombre + Shopify/Bsale en vivo solo si el perfil está vacío o >6 h viejo |
| **Requiere acción humana** | Sí (abrir el panel) | No |

**Conclusión práctica:**
- Para el día a día, **no necesitas abrir la web** — las notas se generan solas con cada mensaje.
- La web sigue siendo el **"refuerzo premium"**: si abres el ticket en el panel, fuerzas la ficha más completa y al instante (útil cuando el cliente recién escribe y aún no hay datos cruzados).
- La web NO se va a borrar. Es complementaria, no legacy.

---

## 15. Cómo se actualizan las notas (y por qué a veces no salen)

### El flujo de una nota

1. Llega un evento a `/api/webhook/chatwoot` (o se abre el panel → `/api/search`).
2. Se arma la ficha en markdown (`buildFichaMarkdown`).
3. Se buscan las notas existentes del contacto. Si ya hay una con el marcador `📋 **Ficha ST**`:
   - **¿Cambió el contenido?** → la actualiza (`updated`).
   - **¿Es idéntica?** → no hace nada (`unchanged`). *Esto es correcto: la nota ya está ahí.*
4. Si no existe ninguna → la crea (`created`).

El resultado (`created` / `updated` / `unchanged` / `skipped`) se ve en los logs del servidor:
`[ficha] Nota de contacto #<id>: <resultado>`

### Por qué a veces NO aparece la nota

En orden de probabilidad:

1. **El webhook de Chatwoot apunta a la ruta equivocada.** La lógica de la ficha vive **solo** en `/api/webhook/chatwoot`. Existe otro webhook, `/webhook` (el del panel, en `webhook_panel.js`), que **NO** genera la nota. → En Chatwoot, el webhook debe ser **`https://<tu-servidor>/api/webhook/chatwoot`**. Si está configurado el otro, las notas no se generan por mensaje (solo al abrir el panel).

2. **El contacto no tiene `id` en el payload.** La nota se escribe contra el contacto (`payload.sender.id` o `conversation.meta.sender.id`). Sin contact_id no hay dónde escribirla.

3. **El evento no es `message_created`.** Otros eventos (conversación actualizada, etc.) no disparan la nota.

4. **El mensaje es saliente del agente.** La sincronización se ata a la extracción de datos del cliente; los mensajes que escribe el agente (type 1) no la disparan. Las notas internas privadas (type 2) sí.

5. **Salió `unchanged` y no te diste cuenta.** Si el contenido es igual al de la última nota, no se reescribe. La nota **ya está** en el contacto — revisa la pestaña de notas del contacto, no de la conversación.

6. **El proceso es best-effort en segundo plano.** El webhook responde `200` de inmediato y procesa la ficha en background. Si Gemini/Shopify/Bsale tardan o fallan en esa pasada, esa nota puntual puede no escribirse, pero **el siguiente mensaje lo reintenta**. No se reintenta automáticamente la misma pasada.

7. **Credenciales de Chatwoot sin resolver.** Si `CHATWOOT_BASE_URL`/`CHATWOOT_API_TOKEN` no están disponibles, la sincronización se salta (`skipped`).

### Cómo forzar la nota manualmente

Si una nota no salió y la necesitas ya:
- **Abre el ticket en el panel** → dispara `/api/search` y regenera la ficha completa, o
- **Llama al endpoint**: `POST /api/chatwoot/contacts/:contactId/ficha` (re-sincroniza desde lo guardado en `client_profiles`).

### Nota importante: notas de **contacto**, no de **conversación**

La ficha se escribe en las **notas del CONTACTO** (perfil del cliente), no como nota privada dentro de la conversación. Si la buscas dentro del hilo del ticket no la verás — está en el panel lateral del contacto.

---

*Última actualización: 2026-06-10*
