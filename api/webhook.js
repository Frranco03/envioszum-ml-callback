export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const BASE44_API_KEY = process.env.BASE44_API_KEY;

  try {
    const { createClient } = await import('@base44/sdk');
    const base44 = createClient({
      appId: '69e8dcad5d3cfe653cb58e7d',
      headers: { 'api_key': BASE44_API_KEY },
    });

    const body = req.body;
    console.log('Webhook recibido:', JSON.stringify(body));

    const result = await base44.functions.invoke('mlWebhook', body);
    console.log('Resultado mlWebhook:', JSON.stringify(result));

    return res.status(200).json({ status: 'ok', result });
  } catch (err) {
    console.error('Error en webhook:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
