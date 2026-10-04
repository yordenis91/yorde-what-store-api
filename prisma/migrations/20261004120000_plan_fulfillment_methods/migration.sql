-- Gives each plan an enforced list of checkout channels. Until now the only
-- per-plan restrictions were maxStores/maxProducts; `features` is display
-- copy, so a Free store could still turn on Stripe, MercadoPago, Zelle or
-- Telegram.
--
-- New plans default to WhatsApp only. Existing paid plans keep every channel
-- so no paying store loses a checkout option on deploy; free plans drop to
-- WhatsApp only, which is what the Free plan has always advertised. A Super
-- Admin can grandfather one store with limits_override.fulfillmentMethods.
ALTER TABLE "plans" ADD COLUMN "fulfillment_methods" "FulfillmentMethod"[] DEFAULT ARRAY['WHATSAPP']::"FulfillmentMethod"[];

UPDATE "plans"
SET "fulfillment_methods" = ARRAY['WHATSAPP', 'TELEGRAM', 'STRIPE', 'MERCADOPAGO', 'ZELLE']::"FulfillmentMethod"[]
WHERE "price" > 0;
