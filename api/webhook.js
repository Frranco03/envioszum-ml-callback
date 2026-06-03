async function getKey(rawKey) {
  const raw = new TextEncoder().encode(rawKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hashBuffer, { name: 'AES-GCM' }, false, ['decrypt']);
}

async function decryptToken(ciphertext, rawKey) {
  if (!ciphertext) return '';
  try {
    const key = await getKey(rawKey);
    const combined = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const cipher = combined.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(plain);
  } catch {
    return ciphertext;
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const BASE44_API_KEY = process.env.BASE44_API_KEY;
  const ML_CLIENT_ID = process.env.ML_CLIENT_ID;
  const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
  const ENC_KEY = process.env.ML_TOKEN_ENC_KEY || 'envios-zum-default-32byteskey!!x';

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

    const allTokens = await base44.entities.MercadoLibreToken.filter({ ml_user_id: mlUserId });
    if (allTokens.length === 0) {
      return res.status(200).json({ status: 'no token for user', ml_user_id: mlUserId });
    }

    const tokenRecord = allTokens[0];

    console.log('Token raw primeros 20 chars:', tokenRecord.access_token?.substring(0, 20));

    let accessToken = await decryptToken(tokenRecord.access_token, ENC_KEY);
    let refreshToken = await decryptToken(tokenRecord.refresh_token, ENC_KEY);

    console.log('Access token desencriptado, longitud:', accessToken.length);
    console.log('Access token primeros 20 chars:', accessToken?.substring(0, 20));

    async function refreshAccessToken() {
      const refreshRes = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: ML_CLIENT_ID,
          client_secret: ML_CLIENT_SECRET,
          refresh_token: refreshToken,
        }),
      });
      if (!refreshRes.ok) {
        const err = await refreshRes.text();
        console.error('Refresh failed:', err);
        return null;
      }
      return await refreshRes.json();
    }

    let orderRes = await fetch(`https://api.mercadolibre.com${resourceUrl}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (orderRes.status === 401 || orderRes.status === 403) {
      console.log('Token vencido, refrescando...');
      const newTokens = await refreshAccessToken();
      if (!newTokens) {
        return res.status(200).json({ status: 'token refresh failed' });
      }

      await base44.entities.MercadoLibreToken.update(tokenRecord.id, {
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token,
        expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
      });

      accessToken = newTokens.access_token;
      orderRes = await fetch(`https://api.mercadolibre.com${resourceUrl}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    }

    if (!orderRes.ok) {
      return res.status(200).json({ status: 'ml order fetch failed', code: orderRes.status });
    }

    const order = await orderRes.json();
    console.log('Orden ML recibida:', order.id);
    console.log('Shipping completo:', JSON.stringify(order.shipping));

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
