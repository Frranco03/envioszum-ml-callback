export default async function handler(req, res) {
  const { code, state } = req.query;

  if (!code) {
    return res.status(400).send('Código OAuth faltante');
  }

  const CLIENT_ID = process.env.ML_CLIENT_ID;
  const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
  const REDIRECT_URI = process.env.ML_REDIRECT_URI;
  const BASE44_APP_ID = process.env.BASE44_APP_ID;
  const BASE44_API_KEY = process.env.BASE44_API_KEY;

  // Canjear código por tokens
  const tokenRes = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return res.status(400).send(`Error obteniendo tokens: ${err}`);
  }

  const tokens = await tokenRes.json();

  // Obtener info del usuario ML
  const meRes = await fetch('https://api.mercadolibre.com/users/me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const mlUser = meRes.ok ? await meRes.json() : {};

  // Decodificar email del state
  let userEmail = '';
  try { userEmail = atob(state || ''); } catch {}

  // Guardar en Base44
  const base44Res = await fetch(`https://api.base44.com/api/apps/${BASE44_APP_ID}/entities/MercadoLibreToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api_key': BASE44_API_KEY,
    },
    body: JSON.stringify({
      user_email: userEmail,
      ml_user_id: String(mlUser.id || ''),
      ml_nickname: mlUser.nickname || '',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      site_id: mlUser.site_id || 'MLU',
      integration_mode: 'oauth',
    }),
  });

  // Redirigir de vuelta a la app
  res.redirect(302, `https://envioszum.base44.app/comercial?ml_connected=1`);
}
