# SoyMomo ST System

Búsqueda 360°: Chatwoot, Bsale, Shopify y evidencias en Google Drive (órdenes ST detectadas en conversaciones).

## Requisitos

- Node.js 18+ y npm

## Puesta en marcha

1. Instalar dependencias (raíz del repo):

   ```bash
   npm install
   ```

2. Crear `server/.env` a partir del ejemplo:

   ```bash
   copy .env.example server\.env
   ```

   En macOS/Linux: `cp .env.example server/.env`

3. Completar en `server/.env` al menos:

   - **Chatwoot:** `CHATWOOT_BASE_URL`, `CHATWOOT_API_TOKEN`
   - **Bsale:** `BSALE_ACCESS_TOKEN` (y `BSALE_API_URL` o `BSALE_API_BASE_URL` según tu cuenta)
   - **Shopify:** `SHOPIFY_ACCESS_TOKEN` (si no defines URL ni tienda, por defecto `soymomo-chile.myshopify.com` y API `2024-10`; ver `.env.example`)

   Opcional: Supabase (`SUPABASE_*`) para guardar credenciales desde `/settings`; Drive (`DRIVE_*`) para informes ST.

4. Arrancar API + frontend:

   ```bash
   npm run dev
   ```

   - App: [http://localhost:5173](http://localhost:5173)
   - API: [http://localhost:3001](http://localhost:3001) — comprobar estado: [http://localhost:3001/api/setup](http://localhost:3001/api/setup)

Tras cambiar `server/.env`, reinicia `npm run dev`.

### Búsqueda por nombre (persona)

Con **nombre y apellido**, Chatwoot, Bsale y Shopify aplican un **filtro estricto**: cada palabra significativa que escribes debe aparecer como **palabra completa** en el nombre (así “Mora” no mezcla con “Morales” ni “Moraga”). Se ignoran artículos típicos (`de`, `la`, …) al exigir coincidencias.

### Shopify no responde

- Comprueba el mensaje en la UI o en `GET /api/search` (bloque `shopify.error`). Suele ser token, tienda distinta al token, o versión de API.
- **HTTP 401 “Invalid API key or access token”:** el `shpat_…` no corresponde a la tienda de la URL. El token solo vale para la tienda donde lo generaste: alinea `SHOPIFY_API_URL` o `SHOPIFY_SHOP_HOST` con ese mismo `*.myshopify.com`. Vuelve a copiar el token (sin espacios ni comillas), o créalo de nuevo en **Configuración → Apps and sales channels → Develop apps → tu app → API credentials**.
- Asegura scopes **read_customers** y **read_orders** en la app de Shopify.
- Si usaste `SHOPIFY_API_URL` con una versión muy nueva, prueba `SHOPIFY_API_VERSION=2024-10` o una URL que termine en `/admin/api/2024-10`.
- Si usas Supabase en `/settings`, un `shopify_admin_api_url` guardado con otra tienda **pisa** el `.env`: corrige o borra ese campo en la base.

## Acciones útiles en la UI

- **Chatwoot:** enlace directo a cada ticket; resumen IA desplegable; si hay varias conversaciones abiertas, lista con **Marcar resuelta** (API `POST /api/chatwoot/conversations/resolve`).
- **Shopify:** enlace **Abrir pedido en Shopify** (admin) por cada pedido.
- **Bsale:** enlace **Ver documento** cuando Bsale expone `urlPublicView`.
- **Drive:** abrir archivo o **Descargar PDF** (export) para Google Docs / Hojas cuando aplica.

## Scripts

| Comando        | Descripción                          |
| -------------- | ------------------------------------ |
| `npm run dev`  | Servidor (3001) + Vite (5173)        |
| `npm run build`| Build del cliente                    |
| `npm start`    | Solo API en producción (`node`)      |

## Supabase

Si usas configuración en base de datos, ejecuta en orden los SQL en `supabase/migrations/`.
