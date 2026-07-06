require('dotenv').config();
const https = require('https');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('❌ BOT_TOKEN not found in environment');
  process.exit(1);
}

function apiCall(method, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(JSON.parse(data)));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function clearBot() {
  console.log('🤖 Mental Gaming Store Bot — Clearing...\n');

  const info = await apiCall('getMe');
  if (!info.ok) {
    console.error('❌ Invalid BOT_TOKEN or bot unreachable');
    process.exit(1);
  }
  console.log(`✅ Connected to: @${info.result.username} (${info.result.first_name})`);

  const webhook = await apiCall('deleteWebhook', { drop_pending_updates: true });
  console.log(`🔗 Webhook deleted + pending updates dropped: ${webhook.ok ? '✅' : '❌'}`);

  const cmds = await apiCall('setMyCommands', { commands: [] });
  console.log(`📋 Bot commands cleared: ${cmds.ok ? '✅' : '❌'}`);

  const desc = await apiCall('setMyDescription', { description: '' });
  console.log(`📝 Bot description cleared: ${desc.ok ? '✅' : '❌'}`);

  const shortDesc = await apiCall('setMyShortDescription', { short_description: '' });
  console.log(`📄 Short description cleared: ${shortDesc.ok ? '✅' : '❌'}`);

  const menuBtn = await apiCall('setChatMenuButton', { menu_button: { type: 'default' } });
  console.log(`🔘 Menu button reset to default: ${menuBtn.ok ? '✅' : '❌'}`);

  console.log('\n✅ Bot fully cleared and ready for fresh setup!');
}

clearBot().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
