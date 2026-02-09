const axios = require('axios');

async function test(op) {
    try {
        const res = await axios.get('https://api.jasaotp.id/v1/order.php', {
            params: {
                api_key: 'invalid_key',
                negara: 6,
                layanan: 'wa',
                operator: op
            },
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        console.log(`Op '${op}': OK (Status ${res.status})`);
    } catch (e) {
        console.log(`Op '${op}': Error ${e.response ? e.response.status : e.message}`);
        if (e.response && e.response.data) console.log(JSON.stringify(e.response.data));
    }
}

async function run() {
    await test('any');
    await test('');
    await test('telkomsel');
}
run();
