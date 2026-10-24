# Checklist de salida a producción

Para el primer despliegue con clientes de pago. Complementa a [`DEPLOY.md`](DEPLOY.md) (cómo se despliega la
imagen) con lo que cambió tras la auditoría previa a producción y con lo que hay que **comprobar** antes de cobrar.

Marca cada casilla cuando esté hecha **y verificada**, no solo configurada. Los bloques están en orden: no pases al
siguiente si falla uno.

---

## 1. Base de datos

La separación entre tiendas depende de Row Level Security. Un rol con superusuario o `BYPASSRLS` la ignora por
completo, y todas las consultas ven los datos de todas las tiendas.

- [ ] `DATABASE_URL` usa un rol **sin** `SUPERUSER` y **sin** `BYPASSRLS`. Los Postgres gestionados suelen entregar el
      usuario administrador por defecto: crea uno aparte.

  ```sql
  CREATE ROLE yws_app LOGIN PASSWORD '<contraseña larga>' NOSUPERUSER NOBYPASSRLS;
  CREATE DATABASE yws OWNER yws_app;
  ```

- [ ] Compruébalo con ese mismo usuario (debe devolver `f` y `f`):

  ```sql
  SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
  ```

  La API **no arranca** en producción si el rol es privilegiado. No pongas `ALLOW_PRIVILEGED_DB_ROLE=true`: existe
  solo como salida de emergencia y desactiva la protección.
- [ ] `BACKUP_DATABASE_URL` apunta a un rol **distinto**, con `BYPASSRLS` (sin él, `pg_dump` falla contra las tablas
      con RLS forzado). Ese atributo nunca va en el rol de la aplicación. SQL exacto en `DEPLOY.md`.
- [ ] La base tiene copia de seguridad automática del proveedor además del backup propio.
- [ ] Redis alcanzable (`REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`). Sirve a las colas y a los límites de peticiones:
      si cae, la API se queda sin límites y deja de procesar trabajos.

## 2. Secretos

Con `NODE_ENV=production` la API **se niega a arrancar** si un secreto es de ejemplo, mide menos de 32 caracteres o se
repite. Genera cada uno por separado:

```bash
openssl rand -hex 32
```

- [ ] `JWT_SECRET`
- [ ] `JWT_REFRESH_SECRET`
- [ ] `JWT_CUSTOMER_SECRET`
- [ ] `JWT_CUSTOMER_REFRESH_SECRET`
- [ ] `ENCRYPTION_KEY`
- [ ] Los cinco son **distintos entre sí**, ninguno empieza por `change_me`, y están en un gestor de contraseñas.

> ⚠️ **`ENCRYPTION_KEY` no se rota sin migrar.** Cifra las credenciales de pago, las contraseñas SMTP y los tokens de
> Telegram de cada tienda. Cambiarla o perderla las deja ilegibles. Cambiar los `JWT_*` solo cierra las sesiones activas.

- [ ] `SUPER_ADMIN_PASSWORD` de **al menos 12 caracteres** antes de sembrar (el seed de producción falla sin ella).
      Cámbiala desde el panel tras el primer acceso.

## 3. Variables de entorno

- [ ] `NODE_ENV=production`
- [ ] `CORS_ORIGINS` con la lista exacta de orígenes de la web (vacía = refleja cualquier origen con credenciales).
- [ ] `PUBLIC_WEB_URL=https://tu-dominio` (todos los enlaces de los correos se construyen con ella).
- [ ] `STOREFRONT_ROOT_DOMAIN=midominio.com` **si las tiendas viven en subdominios** (`acme.midominio.com`), con el mismo
      valor que `VITE_STOREFRONT_ROOT_DOMAIN` de la web. Sin ella, el checkout con tarjeta rechaza (400) las URLs de
      retorno de una tienda en subdominio. Déjala sin definir si solo se usa `/store/<slug>`.
- [ ] `TRUST_PROXY` = número de proxies delante de la API (p. ej. `2` con Cloudflare + Traefik). Sin ella, todos los
      visitantes cuentan como una sola IP para los límites. `true` y `*` se rechazan.
- [ ] `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` — SMTP **de la plataforma**. Por él salen las
      invitaciones de staff, los restablecimientos de contraseña y los avisos de plan. Sin `SMTP_HOST` esos correos no
      se envían (solo se registra el asunto en el log).
- [ ] `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; y `STRIPE_BILLING_WEBHOOK_SECRET` si cobras planes con tarjeta.
- [ ] `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` (ver apartado 5).
- [ ] `PAYPAL_MODE=live`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` (ver apartado 5 y [`PAYPAL_DIGITAL.md`](PAYPAL_DIGITAL.md)).
- [ ] Si vendes productos digitales: `DIGITAL_S3_*` apuntando a un bucket **privado** (ver [`PAYPAL_DIGITAL.md`](PAYPAL_DIGITAL.md)).
- [ ] `SENTRY_DSN` (opcional, pero sin él los errores 5xx solo quedan en los logs).
- [ ] `BACKUP_*` completo (si falta una pieza, los backups quedan desactivados con un aviso).
- [ ] `PLATFORM_DEFAULT_COMMISSION_RATE` revisado.
- [ ] Volumen persistente montado en `/app/uploads` (sin él, cada redespliegue borra las imágenes de todas las tiendas).

## 4. Primer arranque

- [ ] La API arranca. Si no, el log dice qué secreto o qué rol de base de datos rechazó.
- [ ] `docker-entrypoint.sh` aplicó las migraciones (`prisma migrate deploy`).
- [ ] `npm run prisma:seed:prod` ejecutado (planes Free/Pro/Business, cuenta SUPER_ADMIN, plantillas de correo).
- [ ] `GET /api/v1/health` responde 200 y `GET /api/v1/health/strict` también (no `degraded`).
- [ ] Monitor de disponibilidad apuntando a `/api/v1/health/strict`.
- [ ] Inicia sesión como SUPER_ADMIN y comprueba que `/platform/summary` carga.

## 5. Pagos

### Stripe (pedidos de las tiendas)

- [ ] Endpoint en Stripe → `https://<api>/api/v1/payments/stripe/webhook`, evento `checkout.session.completed`.
- [ ] Si alguna tienda cobra por **Stripe Connect** (`connectedAccountId`): el evento llega con la cuenta conectada y se
      acepta **solo** de la cuenta configurada para esa tienda. Crea el endpoint también como *Connect webhook*.
- [ ] Una sesión de prueba (modo test) termina con el pedido en `PAID` / `CONFIRMED`.

### Stripe Billing (planes con tarjeta, opcional)

- [ ] **Segundo** endpoint → `https://<api>/api/v1/billing/stripe/webhook` con `checkout.session.completed`,
      `invoice.paid`, `customer.subscription.updated`, `customer.subscription.deleted`.
- [ ] Portal de cliente activado en Stripe → Settings → Billing.

### MercadoPago

- [ ] Webhook en el panel de MercadoPago → `https://<api>/api/v1/payments/mercadopago/webhook`, tópico *Pagos*.
- [ ] **Entiende el flujo de dinero.** Todos los cobros, consultas y reembolsos de MercadoPago pasan por **la cuenta de
      la plataforma**; las tiendas no pueden poner su propio token. El dinero cae en tu cuenta y **la API no liquida
      a las tiendas**: define cómo se les paga y cómo se aplica la comisión, y que el saldo cubra los reembolsos.
- [ ] Un pago de prueba confirma el pedido y un reembolso desde el panel devuelve el dinero.

### PayPal

- [ ] Webhook en el panel de PayPal (app **Live**) → `https://<api>/api/v1/payments/paypal/webhook` con los eventos
      `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`,
      `PAYMENT.CAPTURE.REVERSED`, `CUSTOMER.DISPUTE.CREATED` y `CUSTOMER.DISPUTE.RESOLVED`; su *Webhook ID* en `PAYPAL_WEBHOOK_ID`.
      Sin él la API rechaza todos los webhooks.
- [ ] Como MercadoPago, **todo el dinero cae en la cuenta de la plataforma** (las tiendas no traen credenciales propias).
- [ ] Una compra de prueba (1 USD) termina en `PAID`, se entrega, y el reembolso desde *Compradores* devuelve el dinero.
      Guion completo en [`PAYPAL_DIGITAL.md`](PAYPAL_DIGITAL.md#11-prueba-en-vivo-1-usd-con-reembolso).

### Reembolsos automáticos

La API devuelve sola el dinero en estos casos y lo deja en el log como error: **configura una alerta** sobre estos textos.

| Situación | Texto en el log |
| --- | --- |
| Pago sobre un pedido ya pagado | `paid twice; refunding` |
| Importe o moneda distintos del pedido | `does not match order` … `refunding` |
| Pago sobre un pedido cancelado | `but the order is CANCELLED` |
| El reembolso automático falló | `failed; refund manually` ← **hay dinero cobrado sin devolver** |
| Evento de una cuenta Connect ajena | `came from account` |

## 6. Prueba completa en staging

Con las pasarelas en **modo test**, antes de abrir a clientes:

- [ ] Registro de una tienda; llega el correo; la tienda empieza en el plan Free.
- [ ] Activar 2FA; cerrar sesión; iniciar sesión pide el código; desactivarlo pide el código.
- [ ] Invitar a un miembro de staff (cuenta nueva): llega un enlace para fijar la contraseña. Invitar a un usuario que
      ya existe: se añade a la tienda **sin** enlace de acceso.
- [ ] Eliminar a ese miembro: pierde el acceso en el acto, también el panel abierto con el stream de pedidos.
- [ ] Pedido con cupón y envío, pagado con Stripe → `PAID`, factura generada, stock descontado, cupón contado.
- [ ] Igual con MercadoPago.
- [ ] Pedido por Zelle con comprobante → el dueño lo confirma → factura. Reenviar el comprobante deja un solo archivo.
- [ ] Cancelar un pedido **pagado** (como dueño): se reembolsa, vuelve el stock y el uso del cupón. Como staff: 403.
- [ ] Pedido abandonado de Stripe/MercadoPago: a las 2 h pasa a `CANCELLED` y devuelve el stock.
- [ ] Restablecer contraseña: solo funciona el enlace más reciente y solo una vez.
- [ ] 10 contraseñas incorrectas seguidas bloquean la cuenta (429) durante 15 min, aunque cambie la IP.
- [ ] Subir de plan (solicitud → aprobación como SUPER_ADMIN) y bajar a uno con menos productos: el exceso queda sin
      publicar.
- [ ] **Backup y restore:** ejecuta un backup (`POST /api/v1/platform/backups/run`) y restáuralo en una base de prueba
      (`POST /api/v1/platform/backups/restore`). Un backup que nadie ha restaurado es una esperanza, no una copia.
- [ ] `npm run smoke:smtp` con las credenciales reales de producción.
- [ ] `/platform/summary` con pedidos en dos monedas: muestra `mixedCurrencies: true` y el desglose en `byCurrency`.

## 7. Frontend (web y apps)

Cambios de contrato de la API que la web/app deben absorber **antes** de producción:

- [ ] `POST /auth/2fa/disable` exige `{ "code": "123456" }` (y `2fa/setup` falla si el 2FA ya está activo).
- [ ] Ajustes de pago de MercadoPago: **solo un interruptor**, sin campos de credenciales (se rechazan con 400).
- [ ] `telegramBotToken` y `smtpPassword` son de **solo escritura**: la API devuelve `telegramBotTokenSet` /
      `smtpPasswordSet`. Un valor vacío los borra; omitirlos los deja igual.
- [ ] Invitación de staff: ya no hace falta enviar `temporaryPassword` (si se omite, se genera una aleatoria).
- [ ] El stream de pedidos (`/orders/events`) se cierra solo si el usuario pierde acceso. Al reconectar con la misma URL
      recibe 401 y `EventSource` no reintenta: la web debe manejar el error y reabrirlo con un token nuevo si procede.
- [ ] STAFF recibe **403** al reembolsar, cancelar un pedido pagado con tarjeta, exportar pedidos, gestionar cupones o
      anonimizar clientes: oculta o desactiva esas acciones.
- [ ] Un pedido o presupuesto con campos sobredimensionados recibe 400 (cantidad máx. 10.000 por línea, 100 líneas,
      textos con longitud máxima).
- [ ] Un producto con variantes exige elegir una; solo se pueden pedir envíos activos.
- [ ] `successUrl` / `cancelUrl` del checkout deben pertenecer a `CORS_ORIGINS` o al dominio/subdominio de la tienda.
- [ ] Tras activar o desactivar el 2FA, las sesiones **móviles** de esa cuenta deben iniciar sesión de nuevo.
- [ ] `/platform/summary` añade `currency`, `mixedCurrencies` y `byCurrency`: no sumes importes de monedas distintas.

## 8. Operación

- [ ] Alertas sobre los textos del apartado 5 y sobre cualquier 5xx (Sentry).
- [ ] Alguien sabe cómo restaurar un backup (apartado 6) y dónde están los secretos.
- [ ] Plan de reversión: las migraciones son solo hacia delante. Antes de cada despliegue con migraciones, backup
      manual; si algo sale mal, restaura en una base nueva y apunta `DATABASE_URL` a ella.
- [ ] Una sola réplica ejecuta los trabajos programados (BullMQ lo garantiza); si hay varias, define
      `RUN_MIGRATIONS=false` en todas menos en el paso de release.
- [ ] Revisión periódica de los registros de auditoría (`/platform/audit-logs`): planes, backups, exportaciones, 2FA e
      impersonaciones quedan registrados, estas últimas atribuidas al administrador y no al dueño.

## 9. Decisiones de producto pendientes

- [ ] **Planes en tiendas adicionales.** Cada tienda tiene sus propios límites: una tienda adicional empieza en el plan
      Free aunque el dueño pague un plan multi-tienda. El límite de *cuántas* tiendas puede crear usa el mejor plan del
      dueño. Decide si las demás deben heredar el plan que paga.
- [ ] Qué hacer con las credenciales de MercadoPago que tiendas ya hayan guardado: se vacían al volver a guardar el
      ajuste de pago, pero quedan sin uso mientras tanto.
- [ ] Liquidación a las tiendas de lo cobrado por MercadoPago (apartado 5).
