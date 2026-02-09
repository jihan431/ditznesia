const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');

// --- KONFIGURASI ---
const BOT_TOKEN = '8285731614:AAEPqwSipOaEKLVbWuAZl5wm3m7TYHyYkZ0'; 
const BASE_URL = 'https://api.jasaotp.id/v1'; 

const bot = new Telegraf(BOT_TOKEN);
const DB_FILE = 'users.json';

// --- DATABASE ---
let userKeys = {};
if (fs.existsSync(DB_FILE)) {
    try { userKeys = JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { userKeys = {}; }
}

function saveUser(userId, apiKey) {
    userKeys[userId] = apiKey;
    fs.writeFileSync(DB_FILE, JSON.stringify(userKeys, null, 2));
}

function getApiKey(userId) {
    return userKeys[userId];
}

// --- UTILS: LOGGER ---
function logServer(userId, msg) {
    const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
    console.log(`[${time}] [User: ${userId}] ${msg}`);
}

// --- API WRAPPER ---
async function apiRequest(endpoint, params = {}) {
    try {
        // Debug params if needed
        // console.log(`[DEBUG_API] ${endpoint} Params:`, JSON.stringify(params));
        
        const response = await axios.get(`${BASE_URL}${endpoint}`, { 
            params,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        
        // Detect HTML garbage in 200 OK response
        if (typeof response.data === 'string' && response.data.includes('<html')) {
            return { success: false, message: 'Server Error (HTML Response)' };
        }

        return response.data;
    } catch (error) {
        console.error(`API Error [${endpoint}]:`, error.message);
        if (error.config && error.config.params) {
            console.error(`Params:`, JSON.stringify(error.config.params)); 
        }
        
        if (error.response) {
             // Handle 429 explicitly
             if (error.response.status === 429) {
                 return { success: false, message: 'Terlalu banyak request (429). Coba lagi nanti.' };
             }
             // Handle HTML error pages
             if (typeof error.response.data === 'string' && error.response.data.includes('<html')) {
                 return { success: false, message: 'API Error: Server returned HTML page.' };
             }
             console.error('Data:', error.response.data);
        }
        return { success: false, message: 'Koneksi API Error.' };
    }
}

// --- FUNGSI AUTO-CHECK OTP ---
async function startAutoCheck(ctx, orderId, number, apiKey, orderMessageId, originChatId, userId) {
    let attempts = 0;
    const maxAttempts = 85; // ~10 menit (85 * 7s)
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    logServer(userId, `Mulai Auto-Check Order: ${orderId} (Target OTP: ${originChatId})`);

    while (attempts < maxAttempts) {
        await delay(7000); // Jeda 7 detik (Aman dari 429)
        
        const res = await apiRequest('/sms.php', { api_key: apiKey, id: orderId });

        if (res.success && res.data?.otp) {
            const rawOtp = res.data.otp.toString().toLowerCase();

            // FILTER: Abaikan jika status masih "Menunggu/Proses"
            if (rawOtp.includes('menunggu') || rawOtp.includes('waiting') || rawOtp.includes('proses')) {
                // Diam saja, lanjut looping
            } else {
                // JIKA OTP BENARAN MASUK
                const maskedNumber = number.length > 7 ? number.substring(0, 4) + 'xxxx' + number.slice(-4) : number;
                const msg = `NOMOR: ${maskedNumber}\nKODE OTP: \`${res.data.otp}\``;
                
                // Kirim OTP ke Chat ASAL (Bisa Group, bisa PM)
                // Kita gunakan ctx.telegram agar bisa kirim ke ID spesifik (originChatId)
                const otpMsg = await ctx.telegram.sendMessage(originChatId, msg, { parse_mode: 'Markdown' });
                logServer(userId, `OTP Diterima: ${res.data.otp}`);
                
                // 1. Hapus Pesan Order (Nomor) di PM User
                if (orderMessageId) {
                    // Gunakan ctx.telegram.deleteMessage untuk hapus pesan di chat USER (PM)
                    ctx.telegram.deleteMessage(userId, orderMessageId).catch(err => console.error('Gagal hapus pesan order (PM):', err.message));
                }

                // 2. Schedule Hapus Pesan OTP (di Group/Asal) setelah 5 menit
                setTimeout(() => {
                    ctx.telegram.deleteMessage(originChatId, otpMsg.message_id).catch(err => console.error('Gagal hapus pesan OTP:', err.message));
                }, 5 * 60 * 1000); // 5 menit

                return; // STOP LOOP
            }
        } 
        
        // Cek jika order dicancel
        if (res.message && res.message.toLowerCase().includes('cancel')) {
            // Jika order dicancel (mungkin dari web), hapus pesan order juga
            if (orderMessageId) {
                 ctx.telegram.deleteMessage(userId, orderMessageId).catch(err => console.error('Gagal hapus order msg (Cancelled):', err.message));
            }
            return;
        }

        attempts++;
    }
    // Waktu habis - Kirim notif ke Chat Asal
    await ctx.telegram.sendMessage(originChatId, `Waktu habis. Order ${orderId} tidak menerima kode.`);
}

// --- MENU SIMPEL ---
bot.telegram.deleteMyCommands().then(() => {
    bot.telegram.setMyCommands([
        { command: 'start', description: 'Mulai Bot' },
        { command: 'setkey', description: 'Set API Key' },
        { command: 'saldo', description: 'Cek Saldo' },
        { command: 'order', description: 'Order Nomor' }
    ]);
});

// --- COMMAND HANDLERS ---

bot.start((ctx) => {
    logServer(ctx.from.id, 'User started the bot');
    ctx.reply(
        `Bot OTP Ditznesia\n\n` +
        `Command Utama:\n` +
        `/order [layanan] [operator] - Order (Indo)\n` +
        `/saldo - Cek Saldo\n\n` +
        `Setup:\n` +
        `/setkey API_KEY_KAMU`
    );
});

bot.command('setkey', (ctx) => {
    logServer(ctx.from.id, 'Command: /setkey');
    const args = ctx.message.text.split(' ');
    const apiKey = args[1];

    if (!apiKey) {
        return ctx.reply(
            `⚠️ *API Key Belum Diisi!*\n\n` +
            `Caranya:\n` +
            `1. Login ke website ditznesia.id\n` +
            `2. Cari menu *Profile* atau *API*.\n` +
            `3. Salin *API Key* anda.\n` +
            `4. Ketik di sini:\n` +
            `\`/setkey KODE_API_KEY_ANDA\`\n\n` +
            `Contoh:\n` +
            `\`/setkey ditz-xxxxxxxx\``,
            { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
    }
    
    saveUser(ctx.from.id, apiKey);
    ctx.reply('✅ API Key berhasil disimpan! Sekarang ketik /saldo untuk cek.');
});

bot.command('saldo', async (ctx) => {
    logServer(ctx.from.id, 'Command: /saldo');
    const apiKey = getApiKey(ctx.from.id);
    if (!apiKey) return ctx.reply('Set API Key dulu.');
    
    const res = await apiRequest('/balance.php', { api_key: apiKey });
    if (res.success || res.code === 200) {
        const saldo = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR' }).format(res.data.saldo);
        ctx.reply(`Saldo: ${saldo}`);
    } else {
        ctx.reply(`Gagal: ${res.message}`);
    }
});

bot.command('order', async (ctx) => {
    const userId = ctx.from.id;
    const originChatId = ctx.chat.id; // Chat ID tempat command diketik (Group atau PM)
    const apiKey = getApiKey(userId);
    
    if (!apiKey) return ctx.reply('Set API Key dulu. Cek PM /setkey');

    // INPUT PARSING (Remove keywords like 'beli', 'nokos', 'negara', 'operator')
    const rawParts = ctx.message.text.split(/\s+/);
    const command = rawParts[0];
    
    // Filter filler/noise words
    const params = rawParts.slice(1).filter(arg => !['beli', 'nokos', 'pesan', 'order', 'negara', 'operator', 'layanan', 'op'].includes(arg.toLowerCase()));
    
    // Reconstruct valid args
    const args = [command, ...params]; 
    
    let negaraCode = '6'; // Default Indonesia
    let layananCode = 'wa';
    let operatorCode = 'any';

    if (args.length > 1) {
        if (!isNaN(args[1])) {
             negaraCode = args[1];
             if (args[2]) layananCode = args[2];
             if (args[3]) operatorCode = args[3];
        } else {
             layananCode = args[1];
             if (args[2]) operatorCode = args[2];
        }
    }

    // Info processing
    const processingMsg = await ctx.reply(`Memproses Order...`);
    logServer(userId, `Order ${layananCode} Negara ${negaraCode} Operator ${operatorCode}`);

    const res = await apiRequest('/order.php', {
        api_key: apiKey,
        negara: negaraCode,
        layanan: layananCode,
        operator: operatorCode.toLowerCase()
    });

    if (res.success || res.data?.number) {
        const { order_id, number } = res.data;
        
        const msg = `No: \`${number}\`\n` +
                    `Op: ${operatorCode.toUpperCase()}\n` +
                    `ID: ${order_id}\n\n` +
                    `Menunggu OTP masuk...\n` +
                    `(OTP akan dikirim ke Chat Asal)`;

        try {
            // KIRIM NOMOR VIA PM (Private Message) ke USER
            const orderMsg = await ctx.telegram.sendMessage(userId, msg, {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('Batal / Ganti Nomor', `cancel_${order_id}`)]
                ])
            });

            // Jika Origin bukan PM (berarti di Group), Edit pesan processing jadi notifikasi PERMANEN
            if (originChatId !== userId) {
                await ctx.telegram.editMessageText(
                    originChatId, 
                    processingMsg.message_id, 
                    null, 
                    `✅ Nomor dikirim ke PM @${ctx.from.username || 'User'}. Cek Private Message!`
                ).catch((err) => console.log('Gagal edit msg:', err.message));
            } else {
                 // Jika di PM, hapus pesan "Memproses" supaya rapi (karena pesan Nomor akan muncul)
                 ctx.deleteMessage(processingMsg.message_id).catch(() => {});
            }
            
            // JALANKAN AUTO CHECK
            startAutoCheck(ctx, order_id, number, apiKey, orderMsg.message_id, originChatId, userId);

        } catch (error) {
            console.error('Gagal kirim PM:', error.message);
            ctx.reply(`❌ Gagal kirim pesan ke PM. Pastikan Anda sudah START bot ini di Private Chat!`);
        }

    } else {
        // Hapus pesan processing jika gagal
        ctx.deleteMessage(processingMsg.message_id).catch(() => {});
        logServer(userId, `Order Filed: ${JSON.stringify(res)}`);
        ctx.reply(`Stok Kosong atau Gagal: ${res.message || 'Unknown Error'}`);
    }
});

bot.action(/cancel_(\d+)/, async (ctx) => {
    // Action ini terjadi di PM (tombol ada di PM)
    const orderId = ctx.match[1];
    logServer(ctx.from.id, `Action: Cancel Order ${orderId}`);
    const apiKey = getApiKey(ctx.from.id);
    const res = await apiRequest('/cancel.php', { api_key: apiKey, id: orderId });
    
    // SAFE TRUNCATE MESSAGE
    const safeMsg = (res.message || 'Gagal').substring(0, 100); 

    if (res.success) {
        // Hapus pesan order (di PM) jika sukses cancel
        await ctx.deleteMessage().catch(err => console.error('Gagal hapus pesan cancel:', err.message));
        
        // Kirim notifikasi toast saja
        await ctx.answerCbQuery(`Order ${orderId} Berhasil Dibatalkan.`);
    } else {
        await ctx.answerCbQuery(`Gagal cancel: ${safeMsg}...`);
    }
});

bot.launch();
console.log(`
 #######  #######  #######     ###  ##   ######  ##  ###  ######
 ##   ##    ###    ##   ##     ###  ##   ##  ##  ### ###      ##
 ##   ##    ###    ##   ##     ###  ##   ##  ##  #######     ##
 ##  ###    ###    #######     #######  #######  ## ####    ##
 ##  ###    ###    ###         ###  ##  ###  ##  ##  ###   ##
 #######    ###    ###         ###  ##  ###  ##  ##  ###  ######

                                      
 SERVER READY - WAITING FOR UPDATES...
`);