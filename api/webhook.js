export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const BASE44_API_KEY = process.env.BASE44_API_KEY;

  try {
    const body = req.body;
    console.log('Webhook recibido:', JSON.stringify(body));

    const topic = body.topic || body.type;
    if (topic !== 'orders_v2') {
      return res.status(200).json({ status: 'ignored', topic });
    }

    const resourceUrl = body.resource;
    const mlUserId = String(body.user_id || '');
    if (!resourceUrl || !mlUserId) {
      return res.status(200).json({ status: 'missing data' });
    }

    const { createClient } = await import('@base44/sdk');
    const base44 = createClient({
      appId: '69e8dcad5d3cfe653cb58e7d',
      headers: { 'api_key': BASE44_API_KEY },
    });

    // Buscar token de la tienda
    const allTokens = await base44.entities.MercadoLibreToken.filter({ ml_user_id: mlUserId });
    if (allTokens.length === 0) {
      return res.status(200).json({ status: 'no token for user', ml_user_id: mlUserId });
    }

    const tokenRecord = allTokens[0];
    const accessToken = tokenRecord.access_token;

    // Fetch de la orden
    const orderRes = await fetch(`https://api.mercadolibre.com${resourceUrl}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!orderRes.ok) {
      return res.status(200).json({ status: 'ml order fetch failed', code: orderRes.status });
    }

    const order = await orderRes.json();
    console.log('Orden ML:', JSON.stringify(order));

    // Deduplicación
    const existing = await base44.entities.CommercialOrder.filter({ package_reference: `ML-${order.id}` });
    if (existing.length > 0) {
      return res.status(200).json({ status: 'already_imported', order_id: order.id });
    }

    const buyer = order.buyer || {};
    const shippingAddress = order.shipping?.receiver_address || {};
    const fullAddress = [
      shippingAddress.street_name,
      shippingAddress.street_number,
      shippingAddress.city?.name || shippingAddress.municipality?.name,
    ].filter(Boolean).join(' ');

    const lat = shippingAddress.latitude || null;
    const lng = shippingAddress.longitude || null;

    const commercialUsers = await base44.entities.CommercialUser.filter({ user_email: tokenRecord.user_email });
    const commercialUser = commercialUsers[0];

    const newOrder = {
      user_email: tokenRecord.user_email,
      tenant_id: commercialUser?.tenant_id || '',
      user_name: commercialUser?.business_name || tokenRecord.ml_nickname || tokenRecord.user_email,
      recipient_name: buyer.nickname || `${buyer.first_name || ''} ${buyer.last_name || ''}`.trim() || 'Comprador ML',
      destination_address: fullAddress || 'Dirección no disponible',
      contact_phone: buyer.phone?.number ? String(buyer.phone.number) : '',
      package_reference: `ML-${order.id}`,
      zone: 'tarifa_comercial',
      status: 'pendiente_recoleccion',
      notes: `Venta ML #${order.id}`,
      destination_lat: lat,
      destination_lng: lng,
    };

    await base44.entities.CommercialOrder.create(newOrder);
    console.log('Orden creada:', newOrder.package_reference);

    return res.status(200).json({ status: 'order_created', ml_order_id: order.id });

  } catch (err) {
    console.error('Error en webhook:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
