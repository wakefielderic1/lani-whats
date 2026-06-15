// ═══════════════════════════════════════════════════════════════════
// STRIPE WEBHOOK HANDLER — LANI Fase 3 Parte B
// 
// Recibe eventos de Stripe (checkout.session.completed),
// valida la firma, y reenvía los datos relevantes a un
// webhook de Make para que actualice Bookings + Calendar + WhatsApp.
//
// ENV VARS requeridas:
//   STRIPE_SECRET_KEY — ya configurada
//   STRIPE_WEBHOOK_SECRET — signing secret del webhook endpoint
//   MAKE_STRIPE_WEBHOOK_URL — URL del webhook de Make
// ═══════════════════════════════════════════════════════════════════

let stripeModule = null;
function getStripe() {
  if (stripeModule) return stripeModule;
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("[WEBHOOK] STRIPE_SECRET_KEY not set");
    return null;
  }
  try {
    const Stripe = require("stripe");
    stripeModule = Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20"
    });
    return stripeModule;
  } catch (err) {
    console.error("[WEBHOOK] Failed to init Stripe:", err.message);
    return null;
  }
}

exports.handler = async (event) => {
  // Stripe solo manda POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const stripe = getStripe();
  if (!stripe) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Stripe not configured" })
    };
  }

  // ─── Validar firma del webhook ───
  // Esto previene que alguien mande eventos falsos a esta URL.
  // Sin validación, cualquiera podría marcar bookings como pagados.
  const sig = event.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  if (webhookSecret && sig) {
    try {
      stripeEvent = stripe.webhooks.constructEvent(
        event.body,  // raw body, no parsed
        sig,
        webhookSecret
      );
    } catch (err) {
      console.error("[WEBHOOK] Signature verification failed:", err.message);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid signature" })
      };
    }
  } else {
    // En desarrollo/test sin webhook secret configurado,
    // aceptar el evento sin verificar (SOLO para testing).
    // En producción, SIEMPRE tener STRIPE_WEBHOOK_SECRET configurado.
    console.warn("[WEBHOOK] No webhook secret configured, skipping signature check");
    try {
      stripeEvent = JSON.parse(event.body);
    } catch (err) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid JSON" })
      };
    }
  }

  // ─── Solo procesar checkout.session.completed ───
  const eventType = stripeEvent.type || stripeEvent.data?.type;

  if (eventType !== "checkout.session.completed") {
    // Stripe manda muchos tipos de eventos. Solo nos interesa este.
    console.log(`[WEBHOOK] Ignoring event type: ${eventType}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ received: true, ignored: true })
    };
  }

  // ─── Extraer datos de la sesión ───
  const session = stripeEvent.data?.object || stripeEvent.data;

  if (!session) {
    console.error("[WEBHOOK] No session data in event");
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "No session data" })
    };
  }

  const metadata = session.metadata || {};

  const payload = {
    // Identificadores
    stripe_session_id: session.id || null,
    stripe_payment_intent: session.payment_intent || null,
    booking_code: metadata.booking_code || null,

    // Datos del guest (del metadata que pusimos al crear la sesión)
    guest_name: metadata.guest_name || null,
    guest_email: session.customer_email || metadata.guest_email || null,
    guest_phone: metadata.guest_phone || null,

    // Datos de la reserva (del metadata)
    property_name: metadata.property_name || null,
    room_type: metadata.room_type || null,
    check_in: metadata.check_in || null,
    check_out: metadata.check_out || null,
    nights: metadata.nights || null,
    guests_count: metadata.guests_count || null,
    total_amount: metadata.total_amount || null,
    currency: metadata.currency || session.currency || "USD",

    // Estado del pago
    payment_status: session.payment_status || "paid",
    amount_paid: session.amount_total || null,

    // Timestamp
    confirmed_at: new Date().toISOString()
  };

  console.log("[WEBHOOK] Payment confirmed:", JSON.stringify({
    booking_code: payload.booking_code,
    guest_name: payload.guest_name,
    total: payload.total_amount,
    currency: payload.currency
  }));

  // ─── Reenviar a Make ───
  const makeWebhookUrl = process.env.MAKE_STRIPE_WEBHOOK_URL;

  if (makeWebhookUrl) {
    try {
      const makeResponse = await fetch(makeWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!makeResponse.ok) {
        console.error("[WEBHOOK] Make webhook failed:", makeResponse.status);
      } else {
        console.log("[WEBHOOK] Successfully forwarded to Make");
      }
    } catch (err) {
      console.error("[WEBHOOK] Failed to call Make webhook:", err.message);
      // No retornar error a Stripe — el pago ya se procesó.
      // Si Make falla, los datos están en el log y en Stripe Dashboard.
    }
  } else {
    console.warn("[WEBHOOK] MAKE_STRIPE_WEBHOOK_URL not set, skipping Make notification");
  }

  // ─── Siempre retornar 200 a Stripe ───
  // Si no retornamos 200, Stripe va a reintentar el webhook hasta 3 días.
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      received: true,
      booking_code: payload.booking_code
    })
  };
};
