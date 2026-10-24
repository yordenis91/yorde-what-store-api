# PayPal y productos digitales

Cómo funcionan, cómo se configuran y cómo se prueban el cobro con **PayPal** y la venta de **productos digitales con
entrega automática por correo** (primer uso: el libro *Los Códigos de Lola*). Complementa a [`DEPLOY.md`](DEPLOY.md) y
a [`PRODUCTION_CHECKLIST.md`](PRODUCTION_CHECKLIST.md).

---

## 1. Qué hay

| Pieza | Dónde |
| --- | --- |
| PayPal Orders v2 (adaptador) | `src/modules/payments/adapters/paypal.adapter.ts` |
| Liquidación, webhook y reembolsos de PayPal | `src/modules/payments/payments.service.ts` |
| Productos digitales: archivos, entrega, enlaces, compradores, precios programados | `src/modules/digital/` |
| Envío del correo con reintentos | `src/queue/processors/digital-delivery.processor.ts` |
| Plantilla del correo | clave `digital-delivery` (editable por tienda en *Plantillas de correo*) |

**Una tienda vende un solo tipo de producto** (`Tenant.catalogType`): `PHYSICAL` (por defecto) o `DIGITAL`. Solo se puede
cambiar mientras la tienda no tenga productos. Una tienda digital no tiene envío ni inventario, vende **una copia por
pedido**, exige el **correo** del comprador y no admite WhatsApp/Telegram (no habría nada que dispare la entrega).

## 2. Variables de entorno

PayPal (cuenta **de la plataforma**, igual que MercadoPago; el secreto nunca llega al navegador):

| Variable | Valor |
| --- | --- |
| `PAYPAL_MODE` | `sandbox` (por defecto) o `live` |
| `PAYPAL_CLIENT_ID` | de la app en <https://developer.paypal.com> |
| `PAYPAL_CLIENT_SECRET` | ídem |
| `PAYPAL_WEBHOOK_ID` | el id que PayPal muestra al crear el webhook (apartado 4). **Sin él se rechazan todos los webhooks.** |

Almacenamiento privado de los archivos (cualquier S3 compatible; aquí, el MinIO de Easypanel):

| Variable | Valor |
| --- | --- |
| `DIGITAL_S3_ENDPOINT` | URL del MinIO |
| `DIGITAL_S3_BUCKET` | p. ej. `yws-digital` — **bucket privado, nunca público** |
| `DIGITAL_S3_REGION` | `us-east-1` |
| `DIGITAL_S3_ACCESS_KEY_ID` / `DIGITAL_S3_SECRET_ACCESS_KEY` | credenciales con acceso solo a ese bucket |
| `DIGITAL_LINK_TTL_DAYS` | caducidad de los enlaces (7) |
| `DIGITAL_MAX_DOWNLOADS` | descargas por enlace (5) |
| `DIGITAL_MAX_FILE_MB` | tamaño máximo por archivo (50) |

Además: `PUBLIC_WEB_URL` (los enlaces del correo salen de ahí: `https://<dominio>/api/v1/downloads/<token>`) y el SMTP de la
plataforma o el de la tienda — **sin SMTP la entrega queda "pagada, entrega pendiente"** (ver apartado 8).

## 3. Migraciones

Dos, solo hacia delante. Haz un backup antes (`POST /api/v1/platform/backups/run`).

1. `20261024120000_paypal_digital_products`: valores `PAYPAL` (método y proveedor) y `DISPUTED` (estado de pago);
   `tenants.catalog_type`; `orders.paypal_order_id` y `orders.paypal_capture_id` (**únicos**); tablas `digital_assets`,
   `digital_deliveries` (única por pedido), `download_grants`, `product_price_schedules` — las cuatro con RLS; y la plantilla
   global del correo de entrega (es/en).
2. `20261024120100_paypal_plan_entitlements`: añade PayPal a los planes que ya incluyen Stripe. Va aparte porque Postgres
   no deja usar un valor de enum añadido en la misma transacción.

No toca pedidos ni productos existentes.

## 4. Configurar PayPal

1. En <https://developer.paypal.com/dashboard/applications> crea (o abre) la app, en **Sandbox** para probar y en **Live**
   para cobrar. Copia *Client ID* y *Secret* a las variables.
2. En la app → **Webhooks → Add webhook**:
   - **URL:** `https://<tu-dominio>/api/v1/payments/paypal/webhook`
   - **Eventos a suscribir:**
     - `CHECKOUT.ORDER.APPROVED` — cobra aunque el comprador cierre la pestaña antes de volver
     - `PAYMENT.CAPTURE.COMPLETED`
     - `PAYMENT.CAPTURE.DENIED`
     - `PAYMENT.CAPTURE.REFUNDED` — reembolsos hechos desde el panel de PayPal
     - `PAYMENT.CAPTURE.REVERSED` — contracargo
     - `CUSTOMER.DISPUTE.CREATED`
     - `CUSTOMER.DISPUTE.RESOLVED`
3. Copia el **Webhook ID** a `PAYPAL_WEBHOOK_ID` y reinicia la API.
4. Sandbox y Live tienen webhooks e IDs distintos: al pasar a producción repite los pasos con las credenciales *Live*.

## 5. Preparar el almacenamiento

Crea el bucket **privado** (p. ej. `yws-digital`) en MinIO, sin política pública ni acceso anónimo, con una clave que solo
llegue a ese bucket. Los archivos se guardan con una clave aleatoria (`<tienda>/<producto>/<uuid>`); su URL nunca se
muestra: el comprador entra por `GET /api/v1/downloads/<token>`, que valida, cuenta la descarga y lo redirige a una URL
firmada de **60 segundos**.

## 6. Montar la tienda "Lola y su Pandilla"

1. **Crear la tienda** y entrar a su panel (Ajustes → General):
   - *¿Qué vende esta tienda?* → **Productos digitales**. (Hazlo antes de crear productos.)
   - *Idioma de los correos a clientes* → **Español**. (Decide el idioma del correo de entrega y de la confirmación.)
   - Moneda **USD** (es la moneda por defecto).
2. **Plan/canales:** una tienda en el plan Free solo ofrece WhatsApp. Como SUPER_ADMIN, en *Plataforma → Tiendas →* esa tienda,
   asigna un plan que incluya PayPal o fija `fulfillmentMethods` en el override de límites (`PAYPAL`, y los demás que quieras).
3. **Ajustes → Pagos → PayPal** → activar. (Solo se puede activar si la plataforma tiene `PAYPAL_CLIENT_ID/SECRET`.)
4. **Producto:** *Productos → Nuevo*, nombre *Los Códigos de Lola*, precio **9.99**. Guarda; ya en edición:
   - **Archivos para el comprador:** sube el PDF del libro (nombre *Los Códigos de Lola*) y el del bono (nombre *Código 13*).
     Se aceptan PDF, EPUB y ZIP; se comprueban los bytes, no solo la extensión.
   - **Cambios de precio programados:** precio **12.99**, fecha **4/11/2026 00:00** (el formulario muestra la zona
     horaria de tu navegador; así el 3/11 entero cuesta 9.99).
5. **Correo (opcional):** *Plantillas de correo →* `digital-delivery` para ajustar el texto. Variables: `{customer_name}`,
   `{store_name}`, `{order_no}`, `{download_links}`, `{expiry_days}`, `{max_downloads}`.

## 7. Cambiar el precio sin tocar código

- **Hasta/desde una fecha:** *Producto → Cambios de precio programados* (apartado 6). Un job revisa cada minuto y copia el
  precio vigente a `Product.price`; por eso la tienda, las cotizaciones y los pedidos siempre leen una sola columna.
- **De inmediato:** editar el precio del producto.
- Cada pedido se cobra al precio vigente **cuando se crea**. Un comprador que abrió PayPal antes del cambio paga el precio
  con el que empezó.
- Una fila ya aplicada no se puede borrar; una pendiente sí.

## 8. Cómo funciona (y qué lo hace seguro)

**Cobro**
1. El comprador crea el pedido; el total sale de la base de datos (`Order.grandTotal`), nunca del navegador.
2. `POST /storefront/payments/paypal/checkout` crea la orden en PayPal con ese total y devuelve el enlace de aprobación.
3. Al volver, la página llama a `POST /storefront/payments/paypal/capture`: el servidor captura y confirma **solo si PayPal
   dice que la captura se completó**. Volver a la página no basta.
4. El webhook hace lo mismo por su lado (`CHECKOUT.ORDER.APPROVED` captura; `PAYMENT.CAPTURE.COMPLETED` confirma). Su firma se
   verifica con el endpoint `verify-webhook-signature` de PayPal; sin `PAYPAL_WEBHOOK_ID`, o ante cualquier fallo, se rechaza.
5. Antes de confirmar se compara **monto y moneda** con lo que debe el pedido. Si no cuadran, no se entrega y se reembolsa.
6. Un pago que llega a un pedido ya pagado con *otra* captura se reembolsa. Un evento de una orden de PayPal que la
   plataforma no creó se ignora.

**Una sola entrega aunque lleguen a la vez el retorno y el webhook:** `paypal_capture_id` es único, la confirmación es un
`UPDATE` condicional (el perdedor no cambia nada) y `digital_deliveries.order_id` es único (`ON CONFLICT DO NOTHING`).
La entrega se crea en la misma transacción que marca el pedido como pagado, y el correo se encola solo tras el commit.

**Enlaces:** 256 bits aleatorios; en la base solo se guarda su hash SHA-256. Caducan (7 días) y tienen límite de descargas (5);
el contador es un `UPDATE` condicional, así que dos clics simultáneos no se llevan la última descarga. Cada intento de envío
genera enlaces nuevos. Un reembolso, cancelación o disputa los desactiva en el acto.

**Estados:** `PENDING → PAID → REFUNDED`, `FAILED`, `DISPUTED` (disputa/contracargo: enlaces desactivados). Una disputa
resuelta a tu favor **no** reactiva los enlaces: lo decides tú (la entrega queda `REVOKED`; ver Riesgos).

**Si el correo falla** la compra no se pierde: la entrega queda `PENDING` ("pagada, entrega pendiente") con el error, se
reintenta 5 veces con espera creciente y, si aún no salió, un barrido cada 5 minutos la vuelve a encolar (hasta 12 intentos).
*Compradores → Reenviar correo* genera enlaces nuevos en cualquier momento. "Sin SMTP configurado" cuenta como fallo, nunca
como enviado.

**Límites de frecuencia:** checkout y captura, 20/min por IP; descargas, 20/min por IP. Pedidos: 20/min por IP (ya existía).

**Conexiones:** checkout y captura no retienen una conexión de base de datos mientras esperan a PayPal
(`@SkipTenantScope`), para que una ráfaga de compras no agote el pool.

## 9. Operación

- **Compradores** (*Admin → Compradores*, solo tiendas digitales): nombre, correo, producto, monto, fecha, estado de pago,
  proveedor, estado de entrega, intentos/errores y descargas; filtros; exportar CSV (solo OWNER); **Reenviar correo**;
  **Reembolsar** (solo OWNER).
- **Reembolso:** *Reembolsar* llama a la API de PayPal (con `PayPal-Request-Id`: repetirlo no devuelve dos veces), marca el
  pedido `REFUNDED` y desactiva los enlaces. Si PayPal falla, no cambia nada y verás el error. PayPal suele conservar su comisión fija.
- **Vigilar en los logs:** `failed; refund manually` (dinero cobrado sin devolver), `paid twice; refunding`,
  `does not match order`, `Digital delivery … email failed`, `Re-queued N digital deliveries`.
- Auditoría: subida/borrado de archivos, cambios de precio, reenvíos y exportaciones quedan en `/platform/audit-logs`.

## 10. Prueba en Sandbox

Con la API desplegada, `PAYPAL_MODE=sandbox`, credenciales Sandbox y el webhook Sandbox creado:

1. En <https://developer.paypal.com/dashboard/accounts> usa (o crea) una cuenta **Personal** de Sandbox para pagar.
2. En la tienda, compra *Los Códigos de Lola* con un correo tuyo → PayPal → inicia sesión con la cuenta personal → aprueba.
3. Debes volver a *Pago confirmado* y recibir el correo con **dos enlaces** (libro y bono). Descarga ambos.
4. *Admin → Compradores*: el pedido aparece `Pagado` / `Entregado por correo` y con 1 descarga por enlace.
5. *Reembolsar*: el pedido pasa a `Reembolsado`, los enlaces responden 410 y en la cuenta Sandbox aparece el reembolso.
6. Repite cerrando la pestaña de PayPal justo después de aprobar: el webhook `CHECKOUT.ORDER.APPROVED` debe confirmar igual.
7. Comprueba también un pago con Stripe/MercadoPago y un pedido físico en otra tienda, para confirmar que no cambiaron.

Las pruebas automáticas (`npx jest` y `npm run test:e2e:local`, ver README) cubren firma válida/inválida, webhook duplicado,
monto/moneda distintos, pago no completado, reembolso, enlace caducado y agotado, y 50 compras simultáneas.

## 11. Prueba en vivo: 1 USD con reembolso

> PayPal **no deja pagarse a uno mismo**: paga con una cuenta de PayPal distinta de la que recibe.

1. `PAYPAL_MODE=live`, credenciales *Live* y el webhook *Live* creado y verificado (apartado 4).
2. En la tienda crea el producto **"Prueba 1 USD"**, precio **1.00**, **Activo**; sube un PDF pequeño con nombre *Prueba*.
3. Abre la tienda en una ventana privada y compra *Prueba 1 USD* con un correo al que tengas acceso.
4. Aprueba en PayPal con la otra cuenta. Debes volver a *Pago confirmado*.
5. Comprueba que llega el correo, que el enlace descarga el PDF y que *Admin → Compradores* muestra `Pagado / Entregado`.
6. En PayPal (cuenta vendedora) comprueba el cobro de 1.00 USD.
7. *Compradores → Reembolsar* sobre ese pedido. Comprueba: estado `Reembolsado`, el enlace del correo responde 410, y el
   reembolso en PayPal (cuenta vendedora y cuenta compradora).
8. **Limpieza:** desactiva *Prueba 1 USD* (casilla *Activo*) para que nadie la compre.
9. Antes del 30/10 comprueba además: SMTP real (`npm run smoke:smtp`), que el bucket sea privado (abre una URL del objeto sin firma:
   debe dar 403) y que el precio hoy sea 9.99 y cambie solo el 4/11.

## 12. Riesgos y límites conocidos

- **Correo masivo:** el día del lanzamiento saldrán muchos correos seguidos por el SMTP de la tienda/plataforma. Comprueba el
  límite de envío de tu proveedor (y SPF/DKIM del dominio del remitente); si es bajo, usa un servicio transaccional.
  Mientras tanto la entrega queda `PENDING` y se reintenta sola; *Compradores* muestra cuántas están pendientes.
- **Barrido vs. reintentos:** el barrido de cada 5 minutos solo puede re-encolar una entrega cuando su job anterior ya agotó
  sus 5 intentos (≈ 7 min); antes de eso reintenta el propio job.
- **Disputas ganadas:** los enlaces no se reactivan solos. Habría que reenviar tras revisar el caso (hoy `Reenviar` rechaza una
  entrega `REVOKED`; pasa a ser decisión manual en la base de datos).
- **Pagos pendientes (eCheck):** una captura `PENDING` no entrega; la confirmación llega por `PAYMENT.CAPTURE.COMPLETED`.
- **Una copia por pedido:** un comprador que quiera dos copias hace dos pedidos.
- **Archivos hasta 50 MB** por defecto, subidos a través de la API (no directo al bucket).
- **Apps móviles:** no tienen PayPal ni productos digitales; la tienda digital se vende por la web.
- Los enlaces contienen el token en la URL: quien reciba el correo puede descargar hasta agotar el límite.
