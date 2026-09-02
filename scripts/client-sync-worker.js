/**
 * Universal Cloud Client & Member Sync Engine v2.1 - Stealth Auto-Login Edition
 *
 * Perubahan v2.1:
 * - Fix deteksi login gagal: tangkap URL /guest/sign-in & /sign-in
 * - Login otomatis via Email + Password (tidak perlu update token manual)
 * - Stealth mode anti-Cloudflare bot detection (puppeteer-extra-plugin-stealth)
 * - Notifikasi Telegram otomatis saat ERROR & saat SUKSES selesai sync
 */

const { execSync } = require('child_process');

// Auto install puppeteer-extra & stealth jika belum ada
try { require.resolve('puppeteer-extra'); } catch(e) {
    console.log('📦 Installing puppeteer-extra & stealth plugin...');
    execSync('npm install puppeteer-extra puppeteer-extra-plugin-stealth --save', { stdio: 'inherit' });
}

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// Notifikasi Telegram
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID   || '';

async function sendTelegram(message) {
    if (!TG_TOKEN || !TG_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: 'HTML' });
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        const data = await res.json();
        if (data.ok) console.log('📲 Notifikasi Telegram terkirim!');
        else console.warn('⚠️ Telegram gagal:', data.description);
    } catch (e) { console.warn('⚠️ Gagal kirim Telegram:', e.message); }
}

const LOGIN_URL   = 'https://ma.valetax-indonesia.com/';
const SUMMARY_URL = process.env.PORTAL_SUMMARY_URL || 'https://ma.valetax-indonesia.com/partnership/summary';
const NETWORK_URL = process.env.PORTAL_NETWORK_URL || 'https://ma.valetax-indonesia.com/partnership/network/parental-tree';

const PORTAL_EMAIL    = process.env.PORTAL_EMAIL    || process.env.VALETAX_EMAIL    || '';
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || process.env.VALETAX_PASSWORD || '';

const SYNC_ENDPOINT = process.env.TARGET_SYNC_URL || 'https://vip.rhfxtrade.web.id/api/valetax_sync.php';
const SYNC_KEY      = process.env.TARGET_SYNC_KEY  || '';

function parseRawTextToRecords(rawText) {
    if (!rawText) return [];
    const lines = rawText.split(/\r?\n/);
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const numberPattern = /^-?\d+(?:\.\d+)?$/;
    const structurePattern = /^\d+(?:\s*\|\s*\d+){1,}$/;
    const ignoreWordsPattern = /^(active|inactive|verified|level|lots|rebates|equity|usd|idr|client|name|email)$/i;
    const records = {};

    // 1. Tab / Column separated rows
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\t+|\s{2,}/).map(p => p.trim()).filter(Boolean);
        let emailKey = null;
        parts.forEach((p, idx) => { if (emailPattern.test(p)) emailKey = idx; });
        if (emailKey !== null && parts.length >= 2) {
            const email = parts[emailKey].toLowerCase();
            const numbers = [];
            let namePart = '';
            let structure = '';
            parts.forEach((p, idx) => {
                if (idx === emailKey) return;
                if (numberPattern.test(p)) numbers.push(parseFloat(p));
                else if (!structure && structurePattern.test(p)) structure = p;
                else if (!namePart && !ignoreWordsPattern.test(p)) namePart = p;
            });
            if (numbers.length >= 1) {
                records[email] = {
                    email: email,
                    full_name: namePart,
                    total_lots: numbers[0] || 0,
                    total_rebates: numbers[1] || 0,
                    equity: numbers[numbers.length - 1] || 0,
                    structure: structure
                };
            }
        }
    }

    // 2. Vertical line blocks
    for (let i = 0; i < lines.length; i++) {
        const email = lines[i].trim().toLowerCase();
        if (!emailPattern.test(email)) continue;
        if (records[email] && records[email].full_name && records[email].equity > 0) continue;

        let name = '';
        const numbers = [];
        let structure = '';

        for (let j = i + 1; j < lines.length; j++) {
            const val = lines[j].trim();
            if (emailPattern.test(val)) break;
            if (!val) continue;
            if (!structure && structurePattern.test(val)) {
                structure = val;
                break;
            }
            if (numberPattern.test(val)) {
                if (numbers.length < 3) numbers.push(parseFloat(val));
                continue;
            }
            if (!name && !ignoreWordsPattern.test(val)) name = val;
        }

        if (numbers.length >= 1 || records[email]) {
            records[email] = {
                email: email,
                full_name: name || (records[email]?.full_name || ''),
                total_lots: numbers[0] ?? (records[email]?.total_lots || 0),
                total_rebates: numbers[1] ?? (records[email]?.total_rebates || 0),
                equity: numbers[numbers.length - 1] ?? (records[email]?.equity || 0),
                structure: structure || (records[email]?.structure || '')
            };
        }
    }
    return Object.values(records);
}

async function runClientSync() {
    const startTime = new Date();
    console.log('====================================================');
    console.log('⚡ [Cloud Data Engine v2] Stealth Auto-Login Sync');
    console.log(`⏱️  Timestamp: ${startTime.toISOString()}`);
    console.log('====================================================');

    if (!PORTAL_EMAIL || !PORTAL_PASSWORD) {
        const msg = '❌ PORTAL_EMAIL atau PORTAL_PASSWORD tidak diset di GitHub Secrets!';
        console.error(msg);
        await sendTelegram(`🚨 <b>RHFX Sync ERROR</b>\n\n${msg}\n\n⏱ ${startTime.toISOString()}`);
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', '--disable-gpu',
            '--window-size=1366,768',
            '--disable-blink-features=AutomationControlled',
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

        // Blokir tracker & chat widget
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url().toLowerCase();
            const blocked = ['livechat','intercom','crisp','tawk','zendesk','freshchat','hotjar','clarity','doubleclick','google-analytics'];
            if (blocked.some(b => url.includes(b))) req.abort();
            else req.continue();
        });

        // ── STEP 1: Buka halaman login ──────────────────────────────────────
        console.log('\n🔐 [Step 1] Membuka halaman login Valetax...');
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 2000));
        const currentUrl = page.url();
        console.log(`📍 URL sekarang: ${currentUrl}`);

        // ── STEP 2: Cek apakah sudah login langsung ─────────────────────────
        const isAlreadyLoggedIn = currentUrl.includes('/dashboard') || currentUrl.includes('/partnership');
        if (isAlreadyLoggedIn) {
            console.log('✅ Sudah terdeteksi login. Skip form login.');
        } else {
            console.log('\n📝 [Step 2] Mengisi form login Email + Password...');

            try {
                await page.waitForSelector('input[type="email"], input[name="email"], input[type="text"]', { timeout: 15000 });
            } catch(e) {
                const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
                throw new Error(`Form login tidak ditemukan. Kemungkinan kena Cloudflare.\nISI HALAMAN: ${pageText}`);
            }

            // 1. Isi Email
            const emailSelectors = ['input[type="email"]', 'input[name="email"]', 'input[id*="email"]', 'input[placeholder*="email" i]'];
            let emailField = null;
            for (const sel of emailSelectors) {
                try { emailField = await page.$(sel); if (emailField) break; } catch(e) {}
            }
            if (!emailField) { const inputs = await page.$$('input:not([type="hidden"])'); if (inputs.length > 0) emailField = inputs[0]; }
            if (!emailField) throw new Error('Field email tidak ditemukan di halaman login!');
            await emailField.click({ clickCount: 3 });
            await emailField.type(PORTAL_EMAIL, { delay: 80 });
            console.log(`✍️  Email diisi: ${PORTAL_EMAIL}`);
            await new Promise(r => setTimeout(r, 500));

            // 2. Isi Password
            const passSelectors = ['input[type="password"]', 'input[name="password"]', 'input[id*="password"]'];
            let passField = null;
            for (const sel of passSelectors) {
                try { passField = await page.$(sel); if (passField) break; } catch(e) {}
            }
            if (!passField) throw new Error('Field password tidak ditemukan di halaman login!');
            await passField.click({ clickCount: 3 });
            await passField.type(PORTAL_PASSWORD, { delay: 90 });
            console.log('🔑 Password diisi.');
            
            // Trigger blur/focusout agar form Valetax memunculkan kotak captcha dinamis
            await passField.press('Tab');
            console.log('⏳ Menunggu beberapa detik hingga kotak captcha muncul...');
            await new Promise(r => setTimeout(r, 3500));

            // 3. Cek apakah captcha sudah muncul, atau coba klik submit 1x untuk memicu captcha
            let captchaField = await page.$('input[name*="captcha" i], input[id*="captcha" i], input[placeholder*="captcha" i], input[placeholder*="kode" i], input[placeholder*="code" i], input[placeholder*="angka" i]');
            
            if (!captchaField) {
                console.log('ℹ️ Captcha belum langsung muncul, mencoba klik login sekali untuk memunculkan captcha...');
                const tempLoginBtn = await page.$('button[type="submit"], input[type="submit"], button:not([type])');
                if (tempLoginBtn) {
                    await tempLoginBtn.click().catch(() => {});
                    await new Promise(r => setTimeout(r, 3000));
                }
                captchaField = await page.$('input[name*="captcha" i], input[id*="captcha" i], input[placeholder*="captcha" i], input[placeholder*="kode" i], input[placeholder*="code" i], input[placeholder*="angka" i]');
            }

            // 4. Jika ada captcha, kirim screenshot ke Telegram & tunggu balasan 4 angka dari user
            if (captchaField) {
                console.log('🔢 Kotak Captcha 4 Angka TERDETEKSI!');
                
                // Ambil screenshot buffer PNG
                const screenshotBuf = await page.screenshot({ type: 'png', fullPage: false });

                if (TG_TOKEN && TG_CHAT_ID) {
                    console.log('📸 Mengirim foto captcha ke Telegram...');
                    
                    try {
                        const formData = new FormData();
                        formData.append('chat_id', TG_CHAT_ID);
                        formData.append('caption', '🔢 <b>RHFX Sync: KODE CAPTCHA DIPERLUKAN!</b>\n\nLihat gambar di atas, lalu <b>BALAS chat ini dengan 4 ANGKA</b> captchanya!\n\n⏳ <i>Robot menunggu balasan Anda selama 3 menit...</i>');
                        formData.append('parse_mode', 'HTML');
                        formData.append('photo', new Blob([screenshotBuf], { type: 'image/png' }), 'captcha.png');

                        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
                            method: 'POST',
                            body: formData
                        });
                        console.log('📲 Foto captcha berhasil dikirim ke Telegram!');
                    } catch(err) {
                        console.warn('⚠️ Gagal kirim foto via FormData, mengirim pesan teks:', err.message);
                        await sendTelegram('🔢 <b>RHFX Sync butuh kode CAPTCHA 4 Angka!</b>\n\nBuka Valetax bro, lihat 4 angka captchanya, lalu <b>balas chat ini dengan 4 angka tersebut</b>!\n⏳ Robot menunggu 3 menit...');
                    }

                    // Ambil last update_id agar tidak membaca pesan lama
                    let lastUpdateId = 0;
                    try {
                        const initRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?limit=1&offset=-1`);
                        const initData = await initRes.json();
                        if (initData.ok && initData.result.length > 0) {
                            lastUpdateId = initData.result[initData.result.length - 1].update_id;
                        }
                    } catch(e) {}

                    // Polling balasan user dari Telegram (max 3 menit = 60 × 3 detik)
                    let captchaCode = null;
                    console.log('⏳ Menunggu balasan 4 angka dari Telegram bro (maks 3 menit)...');

                    for (let attempt = 0; attempt < 60; attempt++) {
                        await new Promise(r => setTimeout(r, 3000));
                        try {
                            const updRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=3`);
                            const updData = await updRes.json();
                            if (updData.ok && updData.result.length > 0) {
                                for (const upd of updData.result) {
                                    lastUpdateId = upd.update_id;
                                    const msgText = (upd.message?.text || '').trim();
                                    // Cek apakah pesan berisi 4-6 angka
                                    if (/^\d{4,6}$/.test(msgText)) {
                                        captchaCode = msgText;
                                        console.log(`🎯 KODE CAPTCHA DITERIMA DARI TELEGRAM: ${captchaCode}`);
                                        break;
                                    }
                                }
                            }
                        } catch(e) {}

                        if (captchaCode) break;
                        if ((attempt + 1) % 5 === 0) {
                            console.log(`⏳ Masih menunggu balasan Telegram... (${(attempt + 1) * 3} detik)`);
                        }
                    }

                    if (!captchaCode) {
                        throw new Error('Waktu habis (3 menit) belum ada balasan kode captcha dari Telegram! Sync dibatalkan.');
                    }

                    // Ketikkan captcha yang diterima
                    await captchaField.click({ clickCount: 3 });
                    await captchaField.type(captchaCode, { delay: 100 });
                    console.log(`✍️  Kode captcha ${captchaCode} berhasil diketikkan.`);
                    await sendTelegram(`✅ Kode captcha <b>${captchaCode}</b> diterima! Robot sedang melakukan login...`);
                    await new Promise(r => setTimeout(r, 800));

                } else {
                    throw new Error('Captcha terdeteksi tapi TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum diset!');
                }
            } else {
                console.log('ℹ️ Tidak ada captcha, langsung lanjut login...');
            }

            // 5. Submit Form Login
            let loginBtn = null;
            const loginSelectors = ['button[type="submit"]', 'input[type="submit"]', 'button:not([type])'];
            for (const sel of loginSelectors) {
                try {
                    const els = await page.$$(sel);
                    for (const el of els) {
                        const txt = (await page.evaluate(e => e.innerText || e.value || '', el) || '').toLowerCase();
                        if (txt.includes('login') || txt.includes('masuk') || txt.includes('sign') || txt.includes('submit')) {
                            loginBtn = el; break;
                        }
                    }
                    if (loginBtn) break;
                } catch(e) {}
            }
            if (!loginBtn) { await passField.press('Enter'); } else { await loginBtn.click(); console.log('🖱️  Tombol login diklik.'); }

            console.log('⏳ Menunggu verifikasi redirect setelah login...');
            try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }); } catch(e) {}
            await new Promise(r => setTimeout(r, 4000));
            const afterUrl = page.url();
            console.log(`📍 URL setelah login: ${afterUrl}`);

            const isLoginFailed = afterUrl.includes('/sign-in') || afterUrl.includes('/guest') || afterUrl === LOGIN_URL;
            if (isLoginFailed) {
                throw new Error(`Login GAGAL! URL masih di halaman login: ${afterUrl}\n\nPastikan email, password, atau captcha sudah sesuai.`);
            }
            console.log('✅ Login berhasil! Berpindah ke halaman data member...');
        }

        // ── STEP 3: Buka halaman Network / Parental Tree ────────────────────
        console.log(`\n🌳 [Step 3] Membuka halaman data member: ${NETWORK_URL}`);
        await page.goto(NETWORK_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 4000));

        // Bersihkan chat widget
        await page.evaluate(() => {
            document.querySelectorAll('[id*="chat"], [class*="chat"], [class*="widget"], [class*="rio"], iframe[src*="chat"]').forEach(el => el.remove());
        });



        // 5. Ekstraksi Data Seluruh Halaman (Looping Multi-Page 1, 2, 3, 4, 5, dst)
        let pageNum = 1;
        let grandSynced = 0;
        const allExtractedEmails = new Set();
        const maxPages = 2000;

        while (pageNum <= maxPages) {
            console.log(`\n====================================================`);
            console.log(`📄 [Scraping Halaman ${pageNum}] Membaca data tabel...`);
            console.log(`====================================================`);
            await new Promise(r => setTimeout(r, 1200));

            const pageRawText = await page.evaluate(() => {
                let fullText = document.body.innerText || '';
                document.querySelectorAll('iframe').forEach(f => {
                    try {
                        const doc = f.contentDocument || f.contentWindow.document;
                        if (doc && doc.body) fullText += '\n' + doc.body.innerText;
                    } catch (err) {}
                });
                return fullText;
            });

            // Parse structured records from raw text
            const records = parseRawTextToRecords(pageRawText);
            const currentFirstEmail = records[0] ? records[0].email : '';

            let newOnThisPage = 0;
            records.forEach(c => {
                if (!allExtractedEmails.has(c.email)) {
                    allExtractedEmails.add(c.email);
                    newOnThisPage++;
                }
                console.log(`  👤 [MEMBER] ${c.email} | ${c.full_name || 'N/A'} | Equity: $${c.equity} | Lots: ${c.total_lots}`);
            });

            console.log(`📊 Halaman ${pageNum}: Berhasil membaca ${records.length} member (${newOnThisPage} member baru, Total Akumulasi: ${allExtractedEmails.size})`);

            if (records.length === 0) {
                console.log(`ℹ️ Halaman ${pageNum} kosong. Selesai.`);
                break;
            }

            // Kirim data halaman ini ke database website backend
            const response = await fetch(SYNC_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
                body: JSON.stringify({ 
                    records: records,
                    raw_text: pageRawText, 
                    preview: false, 
                    sync_key: SYNC_KEY, 
                    source: 'cloud_engine' 
                })
            });

            const result = await response.json();
            if (result.status === 'success') {
                grandSynced = result.total || grandSynced;
            }

            // Navigasi ke Halaman Berikutnya (Hal 2, 3, 4, 5, dst)
            const targetNextPageNumber = pageNum + 1;
            console.log(`🔍 Mencari tombol untuk pindah ke Halaman ${targetNextPageNumber}...`);

            // Cari koordinat fisik tombol halaman di layar
            const btnCoord = await page.evaluate((nextNum) => {
                const elements = Array.from(document.querySelectorAll('button, a, span, div, li, td, th, [role="button"], [role="link"], .page-link, .page-item, [class*="page"], [class*="pagin"]'));
                
                // 1. Cari nomor halaman spesifik (misal: "2", "3", "4", "5")
                const numEl = elements.find(el => {
                    const txt = (el.textContent || '').trim();
                    const rect = el.getBoundingClientRect();
                    return txt === String(nextNum) && rect.width > 0 && rect.height > 0;
                });

                if (numEl) {
                    numEl.scrollIntoView({ behavior: 'auto', block: 'center' });
                    const rect = numEl.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, type: 'number', label: String(nextNum) };
                }

                // 2. Cari tombol panah berikutnya (">" atau "»")
                const arrowEl = elements.find(el => {
                    const txt = (el.textContent || '').trim();
                    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                    const isNext = txt === '>' || txt === '»' || txt.toLowerCase() === 'next' || aria.includes('next');
                    const isDis = el.disabled || el.classList.contains('disabled') || el.classList.contains('p-disabled');
                    const rect = el.getBoundingClientRect();
                    return isNext && !isDis && rect.width > 0 && rect.height > 0;
                });

                if (arrowEl) {
                    arrowEl.scrollIntoView({ behavior: 'auto', block: 'center' });
                    const rect = arrowEl.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, type: 'arrow', label: '>' };
                }

                return null;
            }, targetNextPageNumber);

            if (!btnCoord) {
                console.log(`🏁 Tidak ada lagi tombol navigasi halaman berikutnya. Selesai di Halaman ${pageNum}.`);
                break;
            }

            console.log(`🖱️ Mengklik tombol halaman (${btnCoord.type}: "${btnCoord.label}") pada posisi [${Math.round(btnCoord.x)}, ${Math.round(btnCoord.y)}]...`);
            
            // Klik menggunakan Hardware Mouse Click
            await page.mouse.click(btnCoord.x, btnCoord.y);

            // Trigger juga native DOM click & pointer events
            await page.evaluate((nextNum) => {
                const all = Array.from(document.querySelectorAll('*'));
                const target = all.find(e => (e.textContent || '').trim() === String(nextNum) && e.offsetWidth > 0);
                if (target) {
                    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                }
            }, targetNextPageNumber);

            // Verifikasi transisi tabel (pastikan data member di layar sudah berganti)
            let pageChanged = false;
            for (let retry = 0; retry < 6; retry++) {
                await new Promise(r => setTimeout(r, 600));
                const newText = await page.evaluate(() => document.body.innerText || '');
                const newRecs = parseRawTextToRecords(newText);
                const newFirstEmail = newRecs[0] ? newRecs[0].email : '';
                
                if (newFirstEmail && newFirstEmail !== currentFirstEmail) {
                    pageChanged = true;
                    console.log(`✨ Halaman ${targetNextPageNumber} Berhasil Terbuka! Member pertama: ${newFirstEmail}`);
                    break;
                }
            }

            if (!pageChanged) {
                console.log(`⚠️ Data halaman tidak berganti lagi (sudah di halaman terakhir). Selesai di Halaman ${pageNum}.`);
                break;
            }

            pageNum++;
        }

        const endTime = new Date();
        const durationSec = Math.round((endTime - startTime) / 1000);

        console.log(`\n====================================================`);
        console.log(`🎉 [SELESAI] Member Unik Disinkron: ${allExtractedEmails.size}`);
        console.log(`👑 Total di Database: ${grandSynced}`);
        console.log(`⏱️  Durasi: ${durationSec} detik`);
        console.log(`====================================================\n`);

        if (allExtractedEmails.size > 0) {
            await sendTelegram(
                `✅ <b>RHFX Sync SUKSES</b>\n\n` +
                `👥 Member berhasil disinkron: <b>${allExtractedEmails.size}</b>\n` +
                `🗄️ Total di database: <b>${grandSynced}</b>\n` +
                `⏱️ Durasi: ${durationSec} detik\n` +
                `🕐 ${endTime.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`
            );
        } else {
            await sendTelegram(
                `⚠️ <b>RHFX Sync WARNING</b>\n\n` +
                `❗ 0 member berhasil dibaca dari Valetax.\n` +
                `🔍 Kemungkinan halaman Valetax berubah atau sesi login bermasalah.\n` +
                `👉 Cek: https://github.com/rendybloody/vipsync/actions\n` +
                `🕐 ${endTime.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`
            );
        }

    } catch (error) {
        console.error('\n❌ ENGINE ERROR:', error.message);
        await sendTelegram(
            `🚨 <b>RHFX Sync ERROR!</b>\n\n` +
            `❌ <b>Error:</b> ${error.message.substring(0, 500)}\n\n` +
            `📌 Cek log di GitHub Actions:\n` +
            `🔗 https://github.com/rendybloody/vipsync/actions\n\n` +
            `🕐 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`
        );
        process.exit(1);
    } finally {
        await browser.close();
    }
}

runClientSync();
