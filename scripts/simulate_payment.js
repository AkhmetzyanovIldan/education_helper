const fetch = require('node-fetch');
const crypto = require('crypto');

// Usage: node scripts/simulate_payment.js <serverUrl> <fileId> <chatId>
// Example: node scripts/simulate_payment.js http://localhost:3000 1002 12345678

const [,, serverUrl, fileId, chatId] = process.argv;
if (!serverUrl || !fileId || !chatId) {
  console.error('Usage: node simulate_payment.js <serverUrl> <fileId> <chatId>');
  process.exit(1);
}

async function run() {
  // Получим цену из create-payment (optional) — но для симуляции сформируем label
  const label = `${fileId}_${chatId}_${Date.now()}`;
  const operation_id = 'SIMULATED_' + Date.now();
  const amount = '1.00';
  const currency = '643';
  const datetime = new Date().toISOString();
  const sender = 'simulator@example.com';
  const codepro = 'false';
  const notification_type = 'p2p-incoming';

  const secret = process.env.YOO_SECRET || 'ваш_секрет';
  const hashString = `${notification_type}&${operation_id}&${amount}&${currency}&${datetime}&${sender}&${codepro}&${secret}&${label}`;
  const sha1_hash = crypto.createHash('sha1').update(hashString).digest('hex');

  const body = { notification_type, operation_id, amount, currency, datetime, sender, codepro, label, sha1_hash };

  console.log('Posting simulated webhook to', `${serverUrl}/webhook`);
  const resp = await fetch(`${serverUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  console.log('Status:', resp.status);
  const text = await resp.text();
  console.log('Response:', text);
}

run().catch(err => console.error(err));
