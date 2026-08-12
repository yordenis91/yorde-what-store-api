Fase 1 completada: Backend NestJS funcionando end-to-end
Descarté el scaffold roto (respaldado en backend_legacy_scaffold_bak/) y reconstruí /var/www/html/yorde-what-store/backend desde cero. Resumen de lo entregado:

Infraestructura

docker-compose.yml en la raíz del proyecto levanta Postgres (:5433) y Redis (:6380) aislados de otros proyectos en esta máquina.
Prisma + PostgreSQL, schema normalizado (26 modelos), migración inicial aplicada con Row Level Security real: cada tabla tenant-scoped tiene política tenant_id = current_setting('app.tenant_id'), activada por transacción vía PrismaService.withTenant() / TenantScopeInterceptor. Verificado con un test negativo: un segundo tenant autenticado consulta /products y recibe [] aunque el primero tiene productos.
Winston (logs JSON estructurados), @nestjs/throttler con almacenamiento en Redis, Swagger en /api/v1/docs, filtro global de excepciones, JWT+RolesGuard globales.
Módulos (todos con controller+service+DTO reales, no stubs):

auth: registro (crea User+Tenant+membership OWNER en una transacción), login, refresh rotativo (cookie httpOnly), 2FA TOTP (otplib+QR) para Owner/Staff/SuperAdmin, switch-tenant.
tenants: CRUD de tienda, resolución pública por slug, credenciales de pago cifradas en reposo (AES-256-GCM).
products: categorías/impuestos/variantes/imágenes normalizados (ya no CSV como en Laravel).
orders: cálculo de impuestos/cupones portado de la lógica legacy, y checkout por WhatsApp/Telegram como método de primera clase — probado end-to-end: genera el link wa.me con el mensaje ya renderizado desde la plantilla de la tienda.
payments: PaymentAdapter (Strategy) + StripeAdapter, checkout session, webhook con verificación de firma.
plans/users: planes+suscripciones (con planes sembrados: Free/Pro/Business), staff por tienda.
BullMQ: colas email, invoice-pdf (genera PDF real con pdfkit), inventory-sync, order-notification (envío a Telegram Bot API).
npm run build compila sin errores y el servidor arranca y responde correctamente en pruebas reales (registro → producto → orden WhatsApp → aislamiento entre tenants).