# SoyMomo ST System — Visión del Producto

> Este documento es la fuente de verdad de qué hace, qué debería hacer y hacia dónde va el proyecto.
> Cualquier agente (Claude, Antigravity u otro) que trabaje en este repo debe leerlo primero.

---

## 1. Propósito

Servicio de soporte técnico **solo-backend** conectado a Chatwoot por webhook.
Cuando un cliente escribe, el sistema consolida automáticamente su perfil cruzando datos de
**Chatwoot · Shopify · Bsale · Google Sheets (ST) · Google Drive** y lo escribe como
**nota en el contacto de Chatwoot** (la "Ficha ST").

El objetivo es que el agente vea el historial completo del cliente directamente en Chatwoot,
sin abrir ninguna otra pestaña ni herramienta. **Ya no hay web/panel** (ver §14).

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
Cliente escribe en Chatwoot (WhatsApp / IG / Messenger / Email)
    ↓
Webhook /api/webhook/chatwoot recibe el message_created
    ↓
Extrae identificadores + cruza Shopify / Bsale / Google Sheets (ST)
    ↓
Escribe/actualiza la "Ficha ST" como NOTA del contacto en Chatwoot
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
Con todos los datos recopilados, construir la ficha del cliente con este formato
(compacto, sin resumen de ticket, sin RUT/comuna/modelo):

```
📋 Ficha ST
Nombre:        [nombre del contacto]
Correo:        [correo]
Telefono:      [teléfono]
IMEI/ID:       [IMEI 15 dígitos o ID 10 dígitos extraído de mensajes]
SIM:           [ICCID/SIM SoyMomo extraído de mensajes]
Boletas:       [folios Bsale + enlace PDF si existe]
Pedidos:       [número(s) pedido Shopify + estado pago/envío + enlace al pedido]
Ingresos ST:   [órdenes de hojas "entradas" y "entrada recepción" + enlace al informe]
Salidas ST:    [órdenes de hoja "salida" + enlace al informe]
Tickets:
  - #XXXX  (OPEN/CLOSED)   ← enlace directo a la conversación
  - #XXXX  (OPEN/CLOSED)
```

La ficha se entrega **como nota del CONTACTO en Chatwoot** (`server/src/services/ficha.js`).
Ya no hay web/panel: ver §14.

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

## 6. Tipo de dispositivo — ❌ ya no se muestra en la ficha

La clasificación (Reloj / Tablet / Monitor / Celular) se quitó de la ficha junto con
el campo Modelo. La función `getDeviceCategory` sigue en `services/ficha.js` por si se
reincorpora, pero **no se renderiza**.

---

## 7. Cruce inteligente de tickets

Cuando un cliente contacta, buscar en otros tickets de Chatwoot si existe:
- Mismo email
- Mismo teléfono
- Mismo IMEI
- Mismo SIM
- Mismo nombre exacto (con tolerancia de 1 error tipográfico)

**Objetivo:** Detectar cuando la pareja, familiar u otro representante del mismo cliente ya consultó por el mismo equipo, evitando responder dos veces lo mismo o contradecirse.

Los identificadores se siguen acumulando en `device_facts` para este cruce. Como ya no
hay web, la **ficha-nota agrupa todos los tickets del contacto** (`🎫 Tickets`), que es
la forma en que hoy el equipo ve el historial relacionado.

---

## 8. Resumen del chat (IA) — ❌ DESCARTADO

**Este apartado ya no se utiliza.** La ficha no muestra resumen del ticket; los tickets
aparecen solo como `#XXXX (OPEN/CLOSED)` con enlace directo a la conversación.

> Nota técnica: internamente todavía se extraen identificadores de los mensajes
> (IMEI, SIM, teléfono, email, números de orden) para alimentar la ficha y el
> cruce de tickets. Esa extracción puede usar Gemini si hay `GEMINI_API_KEY`, o
> el fallback regex local si no la hay — pero **el texto de resumen ya no se
> genera ni se muestra**.

---

## 9. Servicio Técnico (Google Sheets)

Cuando el cliente ingresó su equipo a servicio técnico, el sistema puede identificar su orden a través del email o nombre buscando en:

- **Hoja "Entrada recepción"** — órdenes de ingreso
- **Hoja "Entrada"** — registro de entrada
- **Hoja "Salida"** — informe de salida/reparación

Para cada orden encontrada, la ficha muestra el número, la fecha y un **enlace
directo al informe** (entrada y/o salida) alojado en Google Drive. La planilla se
sincroniza a Supabase (`service_orders`) automáticamente (ver §16).

---

## 10. Acciones sobre el ticket (endpoints backend)

Ya no hay UI; estas acciones quedan como endpoints del backend que pueden invocarse
desde Chatwoot (automatizaciones) o manualmente:

| Acción | Cómo |
|--------|------|
| Ficha como nota de CONTACTO (auto, sin web) | Automático vía webhook (`services/ficha.js`) |
| Re-sincronizar ficha manualmente | `POST /api/chatwoot/contacts/:id/ficha` |
| Marcar conversación resuelta | `POST /api/chatwoot/conversations/resolve` |
| Agregar/quitar etiqueta | `POST /api/chatwoot/conversations/:id/labels` |
| Nota interna en la conversación | `POST /api/chatwoot/conversations/:id/notes` |

---

## 11. Arquitectura técnica (solo backend — sin web)

```
server/          → Node.js + Express (ÚNICO componente; ya no hay client/)
  routes/        → API endpoints + webhook
  services/      → Integraciones externas (Chatwoot, Shopify, Bsale, Drive, Sheets) + ficha
  db/ · lib/     → Acceso a Supabase y utilitarios
supabase/        → Migraciones y esquema de base de datos
```

El **webhook de Chatwoot** (`/api/webhook/chatwoot`) es el corazón: recibe cada mensaje,
extrae datos, cruza fuentes y escribe la ficha como nota de contacto. No hay frontend.

### Tablas clave en Supabase (Dash CS)

| Tabla | Contenido |
|-------|-----------|
| `chatwoot_messages` | Todos los mensajes crudos recibidos por webhook |
| `conversation_summaries` | Entidades extraídas por conversación (IMEI/SIM/órdenes) |
| `client_profiles` | Ficha consolidada por contacto (slim — migración 014) |
| `device_facts` | Índice de búsqueda rápida por IMEI/SIM/email/etc. |
| `service_orders` | Órdenes ST sincronizadas desde Google Sheets |

---

## 12. Roadmap de mejoras pendientes

### Alta prioridad

- [x] **Clasificación de tipo de dispositivo** — chip en la Ficha del panel (`getDeviceCategory` en SearchPage.jsx) y en la ficha de nota de contacto (`getDeviceCategory` en services/ficha.js)
- [x] **Detección de ID de 10 dígitos libre en mensajes** — implementado en `services/extractor.js` con validación de contexto (palabras: id, reloj, equipo, imei, etc.)
- [x] **Mejor extracción de número de orden Shopify sin prefijo** — implementado en `services/extractor.js` (5-7 dígitos con contexto: pedido, compra, orden, shopify)
- [x] **Persistencia automática de la ficha en `client_profiles`** — en cada búsqueda del panel y cada mensaje del webhook (fix crítico: bug de scope de `aiData` en webhook.js impedía TODO el guardado)

### Completado en esta etapa
- [x] **Auto-sync de la planilla ST** — `index.js` cada 30 min + al arranque (`SHEETS_SYNC_INTERVAL_MIN`)
- [x] **Matching ST por nombre** — fallback cuando el email no coincide (caso OS 5283 / ticket 14890)
- [x] **Eliminación de la web** — solo-backend, ficha como nota de contacto
- [x] **Ficha slim** — sin RUT/comuna/modelo/resumen; pedidos y tickets con enlace

### Pendiente / Futuro
- [ ] **Estadísticas por tipo de falla** — reporte interno para el equipo ST
- [ ] **Notificaciones push** — alertar cuando se detecta un IMEI con historial de ST reciente

---

## 13. Trabajo con agentes (Claude · Antigravity)

Este proyecto puede ser trabajado simultáneamente por **agentes Claude** y **agentes Antigravity**.

### Reglas de colaboración entre agentes

1. **Leer este archivo primero** antes de hacer cualquier cambio
2. **No romper el webhook** — es el corazón del sistema. Cualquier cambio en `server/src/routes/webhook.js` debe ser cuidadoso
3. **Supabase**: el proyecto tiene acceso a **Dash CS** en Supabase. Las credenciales están en `server/.env`
4. **Ya no hay frontend** — el proyecto es solo-backend. No existe `client/` ni build de web.
5. **La ficha es la fuente de verdad visible** — cualquier dato nuevo debe llegar a la nota de contacto (`services/ficha.js`).

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
GEMINI_API_KEY            — (Opcional) Gemini 2.5 Flash para extraer identificadores de mensajes (fallback: regex local)
DRIVE_PARENT_FOLDER_ID    — Carpeta raíz de Drive con informes ST
DRIVE_SERVICE_ACCOUNT_KEY — JSON de cuenta de servicio Google Drive
GOOGLE_SHEETS_ID          — ID de la planilla de Google Sheets con órdenes ST
SHEETS_SYNC_INTERVAL_MIN  — (Opcional) Minutos entre auto-sync de la planilla ST. Default 30. 0 = desactivado
```

---

## 14. La web fue eliminada (solo-backend)

A partir de 2026-06-10 **el proyecto ya no tiene web**. Se eliminaron:
- La carpeta `client/` (panel React embebido) y el build estático `server/public/`
- El endpoint `/api/search` (búsqueda manual) y `/search`, `/panel`

El backend (`server/`) **se queda**, porque ahí viven el webhook y la generación de notas.
El único flujo es ahora:

```
Cliente escribe en Chatwoot → webhook /api/webhook/chatwoot → ficha como nota de contacto
```

**En Chatwoot debes quitar el Dashboard App "search info"** (Configuración → Integraciones →
Dashboard Apps): ya no apunta a nada. La información del cliente se ve directamente en la
**pestaña de notas del contacto**.

---

## 15. Cómo se actualizan las notas (y por qué a veces no salen)

### El flujo de una nota

1. Llega un `message_created` a `/api/webhook/chatwoot`.
2. Se arma la ficha en markdown (`buildFichaMarkdown`).
3. Se buscan las notas existentes del contacto. Si ya hay una con el marcador `📋 **Ficha ST**`:
   - **¿Cambió el contenido?** → la actualiza (`updated`).
   - **¿Es idéntica?** → no hace nada (`unchanged`). *Esto es correcto: la nota ya está ahí.*
4. Si no existe ninguna → la crea (`created`).

El resultado (`created` / `updated` / `unchanged` / `skipped`) se ve en los logs del servidor:
`[ficha] Nota de contacto #<id>: <resultado>`

### Por qué a veces NO aparece la nota

En orden de probabilidad:

1. **El webhook de Chatwoot apunta a la ruta equivocada.** La lógica de la ficha vive **solo** en `/api/webhook/chatwoot`. Existe otro webhook, `/webhook` (`webhook_panel.js`), que **NO** genera la nota. → En Chatwoot, el webhook debe ser **`https://<tu-servidor>/api/webhook/chatwoot`**.

2. **El contacto no tiene `id` en el payload.** La nota se escribe contra el contacto (`payload.sender.id` o `conversation.meta.sender.id`). Sin contact_id no hay dónde escribirla.

3. **El evento no es `message_created`.** Otros eventos no disparan la nota.

4. **El mensaje es saliente del agente.** La sincronización se ata a la extracción de datos del cliente; los mensajes que escribe el agente (type 1) no la disparan. Las notas internas privadas (type 2) sí.

5. **Salió `unchanged` y no te diste cuenta.** Si el contenido es igual al de la última nota, no se reescribe. La nota **ya está** en el contacto — revisa la pestaña de notas del contacto, no de la conversación.

6. **El proceso es best-effort en segundo plano.** El webhook responde `200` de inmediato y procesa la ficha en background. Si Shopify/Bsale tardan o fallan en esa pasada, esa nota puntual puede no escribirse, pero **el siguiente mensaje lo reintenta**.

7. **Credenciales de Chatwoot sin resolver.** Si `CHATWOOT_BASE_URL`/`CHATWOOT_API_TOKEN` no están disponibles, la sincronización se salta (`skipped`).

### Cómo forzar la nota manualmente

`POST /api/chatwoot/contacts/:contactId/ficha` re-sincroniza desde lo guardado en `client_profiles`.

### Nota importante: notas de **contacto**, no de **conversación**

La ficha se escribe en las **notas del CONTACTO** (perfil del cliente), no como nota privada dentro de la conversación. Si la buscas dentro del hilo del ticket no la verás — está en el panel lateral del contacto.

---

## 16. Integraciones que debes tener en Chatwoot

Para que todo funcione, en Chatwoot necesitas **exactamente dos cosas** (y quitar una tercera):

### 1. Webhook (OBLIGATORIO) — el motor de las notas
- **Dónde:** Configuración → Integraciones → **Webhooks** → Agregar
- **URL:** `https://<tu-servidor>/api/webhook/chatwoot`
- **Evento:** `Mensaje creado` (`message_created`). Es el único imprescindible.
  - Opcional: `Conversación actualizada` (`conversation_updated`) si quieres que al editar
    atributos también se refresque el perfil.
- **Firma:** si defines `CHATWOOT_WEBHOOK_SECRET` en el server, Chatwoot firma el payload
  (HMAC-SHA256) y el server lo valida. Si lo dejas vacío, acepta sin firma (modo dev).

### 2. Token de API / Bot (OBLIGATORIO) — para escribir las notas
- El server necesita un **Access Token** de Chatwoot para crear notas de contacto, etiquetas
  y resolver conversaciones.
- **Dónde sacarlo:** Perfil → Configuración del perfil → **Access Token**, o crea un
  **Agent Bot** y usa su token.
- **Dónde ponerlo:** `CHATWOOT_API_TOKEN` (+ `CHATWOOT_BASE_URL` y `CHATWOOT_ACCOUNT_ID`) en el server.

### 3. Dashboard App "search info" (ELIMINAR) ❌
- Era el panel web embebido. **Ya no apunta a nada** → bórralo en
  Configuración → Integraciones → **Dashboard Apps**.

> Resumen: **Webhook + Access Token = todo lo que Chatwoot necesita.** El equipo ve la ficha
> en la pestaña de **Notas** del contacto.

---

*Última actualización: 2026-06-10*
