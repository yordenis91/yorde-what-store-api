-- Plans that already include online card checkout (Stripe) also get PayPal, so existing paid
-- stores can switch it on. Separate from 20261024120000_paypal_digital_products because Postgres
-- refuses to use an enum value added in the same transaction.
UPDATE "plans"
SET "fulfillment_methods" = array_append("fulfillment_methods", 'PAYPAL'::"FulfillmentMethod")
WHERE 'STRIPE'::"FulfillmentMethod" = ANY("fulfillment_methods")
  AND NOT ('PAYPAL'::"FulfillmentMethod" = ANY("fulfillment_methods"));
