/**
 * Universal Cloud Client & Member Sync Engine v2.2 - Stealth Auto-Login & Telegram Captcha Solver Edition
 *
 * Perubahan v2.2:
 * - Dynamic redirect polling (hingga 12-15 detik) untuk koneksi cloud latensi tinggi
 * - Fleksibel auto-detect selector kotak captcha (explicit & generic non-email visible inputs)
 * - Foto screenshot form login otomatis dikirim ke Telegram jika membutuhkan kode verifikasi
 * - Polling balasan 4 angka dari Telegram selama 3 menit sebelum timeout
 * - 1x Automatic retry jika fresh login mengalami kegagalan sementara
 * - Sesi login otomatis disimpan ke database web agar sinkronisasi berikutnya bebas captcha
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
const CLIENTS_URL = process.env.PORTAL_CLIENTS_URL || 'https://ma.valetax-indonesia.com/partnership/client?table-ptable=0-10';
const NETWORK_URL = process.env.PORTAL_NETWORK_URL || 'https://ma.valetax-indonesia.com/partnership/network/parental-tree';

function cleanSecret(val) {
    if (!val) return '';
    const s = String(val).trim();
    if (/^(true|false|null|undefined)$/i.test(s)) return '';
    return s;
}

function getTokenInfo(token) {
    if (!token) return { valid: false, expired: true, expDate: null, payload: null };
    try {
        let json = null;
        const b64 = Buffer.from(token, 'base64').toString('utf8');
        const match = b64.match(/\{.*?\}/);
        if (match) {
            json = JSON.parse(match[0]);
        } else {
            const direct = token.match(/\{.*?\}/);
            if (direct) json = JSON.parse(direct[0]);
        }

        if (json && json.expiredAt) {
            const expDate = new Date(json.expiredAt);
            const isExpired = expDate.getTime() <= (Date.now() + 60000);
            return { valid: true, expired: isExpired, expDate, payload: json };
        }
    } catch(e) {}
    return { valid: true, expired: false, expDate: null, payload: null };
}

const PORTAL_EMAIL        = cleanSecret(process.env.PORTAL_EMAIL) || cleanSecret(process.env.VALETAX_EMAIL) || '';
const PORTAL_PASSWORD     = cleanSecret(process.env.PORTAL_PASSWORD) || cleanSecret(process.env.VALETAX_PASSWORD) || '';
const PORTAL_FX_TOKEN     = cleanSecret(process.env.PORTAL_FX_TOKEN);
const PORTAL_PARTNER_ID   = cleanSecret(process.env.PORTAL_PARTNER_ID);
const PORTAL_CLEARANCE    = cleanSecret(process.env.PORTAL_CLEARANCE);
const PORTAL_ANALYTICS_ID = cleanSecret(process.env.PORTAL_ANALYTICS_ID);

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

async function scrapePartnershipSummary(page) {
    console.log(`\n💰 [Step Komisi] Membuka halaman Ikhtisar Kemitraan: ${SUMMARY_URL}`);
    try {
        await page.goto(SUMMARY_URL, { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise(r => setTimeout(r, 3000));

        // Bersihkan widget/chat jika ada
        await page.evaluate(() => {
            document.querySelectorAll('[id*="chat"], [class*="chat"], [class*="widget"], [class*="rio"], iframe[src*="chat"]').forEach(el => el.remove());
        });

        // Pastikan periode "Hari ini" aktif jika ada opsi dropdown
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, div, span, [role="button"], [role="combobox"], [class*="select"]'));
            const todayBtn = btns.find(b => {
                const t = (b.textContent || '').trim().toLowerCase();
                return t === 'hari ini' || t === 'today';
            });
            if (todayBtn && typeof todayBtn.click === 'function') {
                try { todayBtn.click(); } catch(e) {}
            }
        });
        await new Promise(r => setTimeout(r, 1200));

        const summary = await page.evaluate(() => {
            const body = document.body.innerText || '';
            let commissionToday = 0;
            let volumeLotsToday = 0;
            let withdrawableBalance = 0;

            // 1. Komisi yang Diperoleh
            const mComm = body.match(/\$\s*([\d,]+\.?\d*)\s*(?:[^\n]*\n)*?\s*Komisi yang Diperoleh/i)
                       || body.match(/Komisi yang Diperoleh\s*(?:[^\n]*\n)*?\s*\$?\s*([\d,]+\.?\d*)/i);
            if (mComm) commissionToday = parseFloat(mComm[1].replace(/,/g, '')) || 0;

            // 2. Volume yang Diperdagangkan
            const mVol = body.match(/([\d,]+\.?\d*)\s*Lot\s*(?:[^\n]*\n)*?\s*Volume yang Diperdagangkan/i)
                      || body.match(/Volume yang Diperdagangkan\s*(?:[^\n]*\n)*?\s*([\d,]+\.?\d*)\s*Lot?/i);
            if (mVol) volumeLotsToday = parseFloat(mVol[1].replace(/,/g, '')) || 0;

            // 3. Tersedia untuk Penarikan
            const mBal = body.match(/Tersedia untuk Penarikan\s*:\s*\$?\s*([\d,]+\.?\d*)/i)
                      || body.match(/Available for Withdrawal\s*:\s*\$?\s*([\d,]+\.?\d*)/i);
            if (mBal) withdrawableBalance = parseFloat(mBal[1].replace(/,/g, '')) || 0;

            return {
                commission_today: commissionToday,
                volume_lots_today: volumeLotsToday,
                withdrawable_balance: withdrawableBalance
            };
        });

        console.log(`  💵 Komisi Hari Ini  : $${summary.commission_today}`);
        console.log(`  📊 Volume Trading   : ${summary.volume_lots_today} Lot`);
        console.log(`  💼 Saldo Siap Tarik : $${summary.withdrawable_balance}`);
        return summary;
    } catch (err) {
        console.warn('⚠️ Gagal membaca halaman summary komisi:', err.message);
        return { commission_today: 0, volume_lots_today: 0, withdrawable_balance: 0 };
    }
}

async function scrapeClientStats(page, allExtractedRecords) {
    console.log(`\n👥 [Step Klien] Membuka halaman Daftar Klien: ${CLIENTS_URL}`);
    try {
        await page.goto(CLIENTS_URL, { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise(r => setTimeout(r, 3000));

        // Bersihkan widget/chat
        await page.evaluate(() => {
            document.querySelectorAll('[id*="chat"], [class*="chat"], [class*="widget"], [class*="rio"], iframe[src*="chat"]').forEach(el => el.remove());
        });

        const stats = await page.evaluate(() => {
            const body = document.body.innerText || '';
            let clientCount = 0;
            let newClientCount = 0;
            let totalLotsTraded = 0;
            let totalLotsPaid = 0;
            let totalRebates = 0;
            let totalDeposit = 0;
            let totalWithdrawal = 0;

            // Jumlah klien & Klien Baru
            const mCl = body.match(/(\d+)\s+(?:[^\n]*\n)*?\s*Jumlah klien/i)
                     || body.match(/Jumlah klien\s+(?:[^\n]*\n)*?\s*(\d+)/i);
            if (mCl) clientCount = parseInt(mCl[1], 10) || 0;

            const mNew = body.match(/(\d+)\s+(?:[^\n]*\n)*?\s*Klien Baru/i)
                      || body.match(/Klien Baru\s+(?:[^\n]*\n)*?\s*(\d+)/i);
            if (mNew) newClientCount = parseInt(mNew[1], 10) || 0;

            // Total Deposit: "388.80 \n Total Deposit"
            const mDep = body.match(/([\d,]+\.?\d*)\s+(?:[^\n]*\n)*?\s*Total Deposit/i)
                      || body.match(/Total Deposit\s+(?:[^\n]*\n)*?\s*([\d,]+\.?\d*)/i);
            if (mDep) totalDeposit = parseFloat(mDep[1].replace(/,/g, '')) || 0;

            // Total Penarikan: "71.69 \n Total Penarikan"
            const mWdr = body.match(/([\d,]+\.?\d*)\s+(?:[^\n]*\n)*?\s*Total Penarikan/i)
                      || body.match(/Total Penarikan\s+(?:[^\n]*\n)*?\s*([\d,]+\.?\d*)/i);
            if (mWdr) totalWithdrawal = parseFloat(mWdr[1].replace(/,/g, '')) || 0;

            // Total Rabat: "53.5326 \n Total Rabat"
            const mReb = body.match(/([\d,]+\.?\d*)\s+(?:[^\n]*\n)*?\s*Total Rabat/i)
                      || body.match(/Total Rabat\s+(?:[^\n]*\n)*?\s*([\d,]+\.?\d*)/i);
            if (mReb) totalRebates = parseFloat(mReb[1].replace(/,/g, '')) || 0;

            return {
                client_count: clientCount,
                new_client_count: newClientCount,
                total_deposit: totalDeposit,
                total_withdrawal: totalWithdrawal,
                total_rebates: totalRebates,
                page_text: body
            };
        });

        // Parse records dari tabel halaman klien ini juga jika ada
        if (stats.page_text && allExtractedRecords) {
            const tableRecords = parseRawTextToRecords(stats.page_text);
            tableRecords.forEach(c => {
                const key = (c.email || '').toLowerCase().trim();
                if (key && !allExtractedRecords.has(key)) {
                    allExtractedRecords.set(key, c);
                }
            });
        }

        console.log(`  👥 Jumlah Klien    : ${stats.client_count} (${stats.new_client_count} Klien Baru)`);
        console.log(`  📥 Total Deposit   : $${stats.total_deposit}`);
        console.log(`  📤 Total Penarikan : $${stats.total_withdrawal}`);

        return stats;
    } catch (err) {
        console.warn('⚠️ Gagal membaca halaman statistik klien:', err.message);
        return { client_count: 0, new_client_count: 0, total_deposit: 0, total_withdrawal: 0, total_rebates: 0 };
    }
}

async function runClientSync() {
    const startTime = new Date();
    console.log('====================================================');
    console.log('⚡ [Cloud Data Engine v2] Stealth Auto-Login Sync');
    console.log(`⏱️  Timestamp: ${startTime.toISOString()}`);
    console.log('====================================================');

    if (PORTAL_EMAIL && PORTAL_PASSWORD) {
        console.log(`🔐 Kredensial auto-login diset untuk email: ${PORTAL_EMAIL}`);
    } else {
        console.log('ℹ️ Kredensial email/password tidak diset di GitHub Secrets.');
    }
    if (PORTAL_FX_TOKEN) {
        const info = getTokenInfo(PORTAL_FX_TOKEN);
        console.log(`🔑 PORTAL_FX_TOKEN terdeteksi di GitHub Secrets (Status: ${info.expired ? 'Kedaluwarsa' : 'Aktif'}${info.expDate ? ` s/d ${info.expDate.toISOString()}` : ''})`);
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

        // ── STEP 1: Evaluasi & Suntikkan Sesi Terbaik ───────────────────────
        console.log('\n🔍 [Step 1] Mengevaluasi token sesi terbaik (GitHub Secrets vs Database Web)...');
        let savedSession = null;
        try {
            const sessRes = await fetch(`${SYNC_ENDPOINT}?action=get_session`);
            const sessData = await sessRes.json();
            if (sessData.status === 'success' && sessData.session) {
                savedSession = sessData.session;
                const dbInfo = getTokenInfo(savedSession.fx_token);
                console.log(`💾 Ditemukan sesi di database web (Status: ${dbInfo.expired ? 'Kedaluwarsa' : 'Aktif'}, Diperbarui: ${savedSession.updated_at})`);
            } else {
                console.log('ℹ️ Belum ada sesi login tersimpan di database web.');
            }
        } catch(e) {
            console.warn('⚠️ Gagal mengambil sesi database:', e.message);
        }

        const secretInfo = getTokenInfo(PORTAL_FX_TOKEN);
        const dbInfo = getTokenInfo(savedSession?.fx_token);

        let activeToken = '';
        let activePartnerId = PORTAL_PARTNER_ID || savedSession?.partner_id || '';
        let activeCookies = savedSession?.cookies || [];

        // Prioritaskan token yang masih AKTIF (belum expired)
        if (PORTAL_FX_TOKEN && !secretInfo.expired) {
            console.log('✨ Menggunakan PORTAL_FX_TOKEN segar dari GitHub Secrets!');
            activeToken = PORTAL_FX_TOKEN;
        } else if (savedSession?.fx_token && !dbInfo.expired) {
            console.log('✨ Menggunakan sesi aktif yang tersimpan di database web!');
            activeToken = savedSession.fx_token;
        } else if (PORTAL_FX_TOKEN) {
            console.log('⚠️ Token database sudah expired / kosong, mencoba PORTAL_FX_TOKEN dari GitHub Secrets...');
            activeToken = PORTAL_FX_TOKEN;
        } else if (savedSession?.fx_token) {
            console.log('⚠️ Menggunakan token terakhir dari database web...');
            activeToken = savedSession.fx_token;
        }

        // Suntikkan Cloudflare clearance cookie jika ada
        if (PORTAL_CLEARANCE) {
            console.log('🛡️ Menyuntikkan cookie cf_clearance dari GitHub Secrets...');
            try {
                await page.setCookie(
                    { name: 'cf_clearance', value: PORTAL_CLEARANCE, domain: '.valetax-indonesia.com', path: '/', httpOnly: true, secure: true },
                    { name: 'cf_clearance', value: PORTAL_CLEARANCE, domain: 'ma.valetax-indonesia.com', path: '/', httpOnly: true, secure: true }
                );
            } catch(e) {}
        }

        // Suntikkan cookies tersimpan
        if (Array.isArray(activeCookies) && activeCookies.length > 0) {
            console.log(`🍪 Menyuntikkan ${activeCookies.length} cookies sesi...`);
            for (const cookie of activeCookies) {
                try { await page.setCookie(cookie); } catch(err) {}
            }
        }

        // Suntikkan LocalStorage & SessionStorage via evaluateOnNewDocument
        if (activeToken || activePartnerId || PORTAL_ANALYTICS_ID) {
            console.log('🔑 Mengatur token sesi ke LocalStorage browser...');
            await page.evaluateOnNewDocument((tok, pid, aid) => {
                if (tok) {
                    try { localStorage.setItem('FX-Token', tok); } catch(e) {}
                    try { sessionStorage.setItem('FX-Token', tok); } catch(e) {}
                }
                if (pid) {
                    try { localStorage.setItem('PartnerId', pid); } catch(e) {}
                    try { sessionStorage.setItem('PartnerId', pid); } catch(e) {}
                }
                if (aid) {
                    try { localStorage.setItem('analytics_user_id', aid); } catch(e) {}
                }
            }, activeToken, activePartnerId, PORTAL_ANALYTICS_ID);
        }

        // ── STEP 2: Coba Akses Halaman Member ───────────────────────────────
        console.log(`\n🌐 [Step 2] Mencoba membuka halaman data member: ${NETWORK_URL}`);
        await page.goto(NETWORK_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 4000));

        // Pastikan token tetap tersimpan di localStorage setelah navigasi
        if (activeToken) {
            await page.evaluate((tok, pid, aid) => {
                try {
                    if (tok && !localStorage.getItem('FX-Token')) localStorage.setItem('FX-Token', tok);
                    if (pid && !localStorage.getItem('PartnerId')) localStorage.setItem('PartnerId', pid);
                    if (aid && !localStorage.getItem('analytics_user_id')) localStorage.setItem('analytics_user_id', aid);
                } catch(e) {}
            }, activeToken, activePartnerId, PORTAL_ANALYTICS_ID);
        }

        let currentUrl = page.url();
        console.log(`📍 URL sekarang: ${currentUrl}`);

        let isLoggedIn = !currentUrl.includes('/sign-in') && !currentUrl.includes('/guest') && !currentUrl.includes('/auth') && currentUrl !== LOGIN_URL;

        if (isLoggedIn) {
            console.log('\n🎉 [SESI AKTIF] Berhasil masuk langsung tanpa login & TANPA CAPTCHA! 🚀');
        } else {
            console.log('\n🔐 Sesi login belum aktif atau sudah kedaluwarsa.');

            if (!PORTAL_EMAIL || !PORTAL_PASSWORD) {
                const errMsg = '❌ Sesi Valetax kedaluwarsa dan kredensial PORTAL_EMAIL / PORTAL_PASSWORD belum diset di GitHub Secrets!\n\n' +
                    '👉 Dua Pilihan Solusi:\n' +
                    '1. Masukkan PORTAL_EMAIL & PORTAL_PASSWORD di GitHub Secrets (repo rendybloody/vipsync > Settings > Secrets) agar robot bisa auto-login dan memperbarui token otomatis.\n' +
                    '   ATAU\n' +
                    '2. Ambil FX-Token baru dari browser F12 (Storage/Application > Local Storage > FX-Token) lalu update secret PORTAL_FX_TOKEN di GitHub Secrets.';
                console.error(errMsg);
                await sendTelegram(`🚨 <b>RHFX Sync Dihentikan</b>\n\n${errMsg}`);
                process.exit(1);
            }

            console.log('🔄 Memulai proses Auto-Login dengan Email & Password...');

            // Helper function untuk mencari tombol submit
            const findAndClickLoginBtn = async (passInput) => {
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
                if (!loginBtn && passInput) {
                    await passInput.press('Enter');
                } else if (loginBtn) {
                    await loginBtn.click();
                    console.log('🖱️  Tombol login diklik.');
                }
            };

            // Helper function untuk mencari kotak input captcha (fleksibel & pintar)
            const getCaptchaInput = async () => {
                const explicitSelectors = [
                    'input[name*="captcha" i]', 'input[id*="captcha" i]', 'input[placeholder*="captcha" i]',
                    'input[placeholder*="kode" i]', 'input[placeholder*="code" i]', 'input[placeholder*="angka" i]',
                    'input[name*="verify" i]', 'input[name*="vcode" i]', 'input[id*="verify" i]'
                ];
                for (const sel of explicitSelectors) {
                    try {
                        const el = await page.$(sel);
                        if (el) {
                            const isVisible = await el.evaluate(e => {
                                const rect = e.getBoundingClientRect();
                                const s = window.getComputedStyle(e);
                                return rect.width > 0 && rect.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
                            });
                            if (isVisible) return el;
                        }
                    } catch(e) {}
                }

                try {
                    const candidates = await page.$$('input:not([type="hidden"]):not([type="password"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])');
                    for (const el of candidates) {
                        const info = await el.evaluate(e => ({
                            type: (e.type || '').toLowerCase(),
                            name: (e.name || '').toLowerCase(),
                            id: (e.id || '').toLowerCase(),
                            placeholder: (e.placeholder || '').toLowerCase(),
                            w: e.getBoundingClientRect().width,
                            h: e.getBoundingClientRect().height,
                            display: window.getComputedStyle(e).display,
                            vis: window.getComputedStyle(e).visibility
                        }));
                        if (info.type === 'email' || info.name.includes('email') || info.id.includes('email') || info.placeholder.includes('email')) continue;
                        if (info.w > 0 && info.h > 0 && info.display !== 'none' && info.vis !== 'hidden') {
                            return el;
                        }
                    }
                } catch(e) {}
                return null;
            };

            const getOnPageError = async () => {
                return await page.evaluate(() => {
                    const sels = ['.alert-danger', '.alert', '.error', '[role="alert"]', '.ant-message-error', '.el-message--error', '.form-error', '.text-danger'];
                    for (const sel of sels) {
                        const els = document.querySelectorAll(sel);
                        for (const el of els) {
                            const t = (el.innerText || '').trim();
                            if (t && !t.toLowerCase().includes('cookie') && !t.toLowerCase().includes('lang')) return t;
                        }
                    }
                    return '';
                });
            };

            const executeLoginStep = async (attempt = 1) => {
                console.log(`\n📝 [Step 2] Mengisi form login Email + Password (Percobaan ${attempt}/2)...`);
                if (!page.url().includes('/sign-in') && !page.url().includes('/guest')) {
                    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
                    await new Promise(r => setTimeout(r, 2000));
                }

                try {
                    await page.waitForSelector('input[type="email"], input[name="email"], input[type="text"]', { timeout: 15000 });
                } catch(e) {
                    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
                    throw new Error(`Form login tidak ditemukan. Kemungkinan kena Cloudflare atau proteksi bot.\nISI HALAMAN: ${pageText}`);
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
                await page.keyboard.press('Backspace');
                await emailField.type(PORTAL_EMAIL, { delay: 70 });
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
                await page.keyboard.press('Backspace');
                await passField.type(PORTAL_PASSWORD, { delay: 80 });
                console.log('🔑 Password diisi.');
                await new Promise(r => setTimeout(r, 800));

                // 3. Cek apakah ada captcha sebelum klik submit
                let captchaField = await getCaptchaInput();

                if (!captchaField) {
                    console.log('ℹ️ Tidak ada kotak captcha di awal. Mencoba klik Sign In langsung...');
                    await findAndClickLoginBtn(passField);

                    // Polling dinamis tunggu redirect (maks 12 detik)
                    console.log('⏳ Menunggu respons server setelah klik Sign In (maks 12 detik)...');
                    for (let s = 0; s < 12; s++) {
                        await new Promise(r => setTimeout(r, 1000));
                        const checkUrl = page.url();
                        const isOutsideLogin = !checkUrl.includes('/sign-in') && !checkUrl.includes('/guest') && !checkUrl.includes('/auth') && checkUrl !== LOGIN_URL;
                        if (isOutsideLogin) {
                            console.log('🎉 Login LANGSUNG SUKSES tanpa captcha! 🚀');
                            return true;
                        }
                        captchaField = await getCaptchaInput();
                        if (captchaField) {
                            console.log('🔢 Kotak verifikasi/captcha muncul setelah klik Sign In!');
                            break;
                        }
                    }
                }

                // 4. JIKA MASIH DI HALAMAN LOGIN -> Kirim Screenshot ke Telegram & Tunggu Balasan 4 Angka
                const postClickUrl = page.url();
                const stillNeedLogin = postClickUrl.includes('/sign-in') || postClickUrl.includes('/guest') || postClickUrl === LOGIN_URL;

                if (stillNeedLogin) {
                    const pageAlert = await getOnPageError();
                    console.log(`⚠️ Halaman masih di login: ${postClickUrl}${pageAlert ? ` (${pageAlert})` : ''}`);

                    if (TG_TOKEN && TG_CHAT_ID) {
                        console.log('📸 Mengambil screenshot form login & mengirim ke Telegram...');
                        const screenshotBuf = await page.screenshot({ type: 'png', fullPage: false });

                        let captionText = '📸 <b>RHFX Sync: KODE VERIFIKASI / CAPTCHA DIPERLUKAN!</b>\n\n' +
                            'Robot terhenti di layar login Valetax.\n' +
                            '👉 <b>Lihat gambar di atas:</b>\n' +
                            'Jika ada <b>kode Captcha (4 angka)</b>, silakan <b>BALAS chat ini dengan 4 ANGKA</b> tersebut sekarang!\n\n' +
                            '💡 <i>Setelah berhasil login, sesi akan tersimpan otomatis di database web agar sync berikutnya bebas captcha.</i>\n\n' +
                            '⏳ <i>Robot menunggu balasan Anda selama 3 menit...</i>';

                        if (pageAlert) {
                            captionText += `\n\n⚠️ <i>Pesan layar: <code>${pageAlert}</code></i>`;
                        }

                        try {
                            const formData = new FormData();
                            formData.append('chat_id', TG_CHAT_ID);
                            formData.append('caption', captionText);
                            formData.append('parse_mode', 'HTML');
                            formData.append('photo', new Blob([screenshotBuf], { type: 'image/png' }), 'captcha.png');

                            await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
                                method: 'POST',
                                body: formData
                            });
                            console.log('📲 Screenshot login berhasil dikirim ke Telegram!');
                        } catch(err) {
                            console.warn('⚠️ Gagal kirim foto via FormData, mengirim teks:', err.message);
                            await sendTelegram(captionText);
                        }

                        // Ambil last update_id
                        let lastUpdateId = 0;
                        try {
                            const initRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?limit=1&offset=-1`);
                            const initData = await initRes.json();
                            if (initData.ok && initData.result.length > 0) {
                                lastUpdateId = initData.result[initData.result.length - 1].update_id;
                            }
                        } catch(e) {}

                        // Polling balasan user dari Telegram (3 menit)
                        let captchaCode = null;
                        console.log('⏳ Menunggu balasan 4 angka dari Telegram (maks 3 menit)...');

                        for (let attemptSec = 0; attemptSec < 60; attemptSec++) {
                            await new Promise(r => setTimeout(r, 3000));
                            try {
                                const updRes = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=3`);
                                const updData = await updRes.json();
                                if (updData.ok && updData.result.length > 0) {
                                    for (const upd of updData.result) {
                                        lastUpdateId = upd.update_id;
                                        const msgText = (upd.message?.text || '').trim();
                                        if (/^[a-zA-Z0-9]{4,6}$/.test(msgText)) {
                                            captchaCode = msgText;
                                            console.log(`🎯 KODE CAPTCHA DITERIMA DARI TELEGRAM: ${captchaCode}`);
                                            break;
                                        }
                                    }
                                }
                            } catch(e) {}

                            if (captchaCode) break;
                            if ((attemptSec + 1) % 5 === 0) {
                                console.log(`⏳ Masih menunggu balasan Telegram... (${(attemptSec + 1) * 3} detik)`);
                            }
                        }

                        if (!captchaCode) {
                            if (attempt === 1) {
                                console.warn('⚠️ Belum ada balasan Telegram pada percobaan 1. Mencoba reload 1x...');
                                await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                                return await executeLoginStep(2);
                            }
                            throw new Error('Waktu habis (3 menit) belum ada balasan kode captcha dari Telegram! Sesi login belum tersimpan. Silakan trigger ulang workflow atau balas foto captcha saat notifikasi masuk.');
                        }

                        // Ketikkan captcha ke kotak input
                        captchaField = await getCaptchaInput();
                        if (captchaField) {
                            await captchaField.click({ clickCount: 3 });
                            await captchaField.type(captchaCode, { delay: 90 });
                            console.log(`✍️  Kode captcha ${captchaCode} berhasil diketikkan ke form.`);
                        } else if (passField) {
                            await passField.press('Tab');
                            await page.keyboard.type(captchaCode, { delay: 90 });
                        }

                        await sendTelegram(`✅ Kode captcha <b>${captchaCode}</b> diterima! Robot sedang submit & memverifikasi...`);
                        await new Promise(r => setTimeout(r, 800));

                        // Submit setelah captcha diisi
                        await findAndClickLoginBtn(passField);
                        console.log('⏳ Menunggu verifikasi redirect setelah login dengan captcha (maks 15 detik)...');

                        for (let w = 0; w < 15; w++) {
                            await new Promise(r => setTimeout(r, 1000));
                            const afterCheckUrl = page.url();
                            if (!afterCheckUrl.includes('/sign-in') && !afterCheckUrl.includes('/guest') && !afterCheckUrl.includes('/auth') && afterCheckUrl !== LOGIN_URL) {
                                console.log('🎉 Login BERHASIL setelah verifikasi captcha! 🚀');
                                return true;
                            }
                        }
                    } else {
                        // Telegram bot belum diset di secrets
                        if (attempt === 1) {
                            console.warn('⚠️ Login tertahan & Telegram belum diset. Mencoba reload 1x...');
                            await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                            return await executeLoginStep(2);
                        }
                        throw new Error(`Login tertahan di halaman: ${postClickUrl}${pageAlert ? ` (${pageAlert})` : ''}.\n\nPastikan email & password benar, atau masukkan TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID di GitHub Secrets agar robot bisa mengirim foto captcha ke Telegram untuk Anda balas.`);
                    }
                }

                const finalUrl = page.url();
                const isLoginFailed = finalUrl.includes('/sign-in') || finalUrl.includes('/guest') || finalUrl === LOGIN_URL;
                if (isLoginFailed) {
                    const finalErr = await getOnPageError();
                    if (attempt === 1) {
                        console.warn(`⚠️ Login percobaan 1 belum berhasil (${finalErr || finalUrl}). Mencoba 1x reload...`);
                        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                        return await executeLoginStep(2);
                    }
                    throw new Error(`Login GAGAL! URL masih di halaman login: ${finalUrl}${finalErr ? `\n\nPesan Error Valetax: ${finalErr}` : '\n\nPastikan email, password, atau captcha sudah sesuai.'}`);
                }

                console.log('✅ Login berhasil!');
                return true;
            };

            await executeLoginStep(1);

            // ── SIMPAN SESI LOGIN KE DATABASE WEB ───────────────────────────
            try {
                console.log('💾 Mengambil token sesi & cookies untuk disimpan ke database web...');
                const freshCookies = await page.cookies();
                const freshToken = await page.evaluate(() => localStorage.getItem('FX-Token') || '');
                const freshPartnerId = await page.evaluate(() => localStorage.getItem('PartnerId') || '');

                const saveRes = await fetch(`${SYNC_ENDPOINT}?action=save_session`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
                    body: JSON.stringify({
                        action: 'save_session',
                        fx_token: freshToken,
                        partner_id: freshPartnerId,
                        cookies: freshCookies
                    })
                });
                const saveResult = await saveRes.json();
                if (saveResult.status === 'success') {
                    console.log('🎉 Sesi login berhasil disimpan ke database web! Sync berikutnya akan berjalan otomatis tanpa captcha.');
                }
            } catch(saveErr) {
                console.warn('⚠️ Gagal menyimpan sesi ke web:', saveErr.message);
            }

            // Buka Halaman Member
            console.log(`\n🌳 Membuka halaman data member: ${NETWORK_URL}`);
            await page.goto(NETWORK_URL, { waitUntil: 'networkidle2', timeout: 60000 });
            await new Promise(r => setTimeout(r, 4000));
        }

        // ── STEP 3: Bersihkan Widget & Mulai Scraping ────────────────────────

        // Bersihkan chat widget
        await page.evaluate(() => {
            document.querySelectorAll('[id*="chat"], [class*="chat"], [class*="widget"], [class*="rio"], iframe[src*="chat"]').forEach(el => el.remove());
        });



        // 5. Ekstraksi Data Seluruh Halaman (Looping Multi-Page 1, 2, 3, 4, 5, dst)
        let pageNum = 1;
        let grandSynced = 0;
        const allExtractedRecords = new Map(); // key: email, value: { email, full_name, equity, total_lots, total_rebates }
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
                const key = (c.email || '').toLowerCase().trim();
                if (key && !allExtractedRecords.has(key)) {
                    allExtractedRecords.set(key, c);
                    newOnThisPage++;
                }
                console.log(`  👤 [MEMBER] ${c.email} | ${c.full_name || 'N/A'} | Equity: $${c.equity} | Lots: ${c.total_lots}`);
            });

            console.log(`📊 Halaman ${pageNum}: Berhasil membaca ${records.length} member (${newOnThisPage} member baru, Total Akumulasi: ${allExtractedRecords.size})`);

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
                    source: 'cloud_engine_v3' 
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

        // ── STEP 4: Ambil Data Komisi Hari Ini & Statistik Kemitraan ───────────
        console.log('\n📊 [Step 4] Membaca Ikhtisar Komisi & Statistik Kemitraan...');
        const summaryData = await scrapePartnershipSummary(page);
        const clientStats = await scrapeClientStats(page, allExtractedRecords);

        const endTime = new Date();
        const durationSec = Math.round((endTime - startTime) / 1000);

        const allMembers = Array.from(allExtractedRecords.values());
        const eligibleMembers = allMembers.filter(m => (m.equity || 0) >= 5);
        const lowEquityMembers = allMembers.filter(m => (m.equity || 0) < 5);

        const commissionSummary = {
            commission_today: summaryData.commission_today || 0,
            volume_lots_today: summaryData.volume_lots_today || 0,
            withdrawable_balance: summaryData.withdrawable_balance || 0,
            client_count: clientStats.client_count || 0,
            new_client_count: clientStats.new_client_count || 0,
            total_deposit: clientStats.total_deposit || 0,
            total_withdrawal: clientStats.total_withdrawal || 0
        };

        // Kirim final sync dengan seluruh member terkumpul untuk deteksi real-time keluar IB
        let removedDetectedCount = 0;
        if (allMembers.length > 0) {
            try {
                console.log(`📡 Mengirim sinyal Full Sync (${allMembers.length} member) untuk deteksi instan member keluar IB...`);
                const fullSyncRes = await fetch(SYNC_ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
                    body: JSON.stringify({ 
                        records: allMembers,
                        commission_summary: commissionSummary,
                        is_full_sync: true, 
                        sync_key: SYNC_KEY, 
                        source: 'cloud_engine_v3' 
                    })
                });
                const fullSyncJson = await fullSyncRes.json();
                if (fullSyncJson.status === 'success') {
                    grandSynced = fullSyncJson.total || grandSynced;
                    removedDetectedCount = fullSyncJson.removed_count || 0;
                    if (removedDetectedCount > 0) {
                        console.log(`🚨 [DETEKSI KELUAR IB] Terdeteksi ${removedDetectedCount} member keluar IB di sync ini!`);
                    }
                }
            } catch (fsErr) {
                console.warn('⚠️ Gagal mengirim sinyal full sync:', fsErr.message);
            }
        }

        // Urutkan member lolos berdasarkan equity terbanyak (DESCENDING)
        eligibleMembers.sort((a, b) => (b.equity || 0) - (a.equity || 0));

        console.log(`\n====================================================`);
        console.log(`🎉 [SELESAI] Total Member Disinkron: ${allMembers.length}`);
        console.log(`💵 Komisi Diperoleh Hari Ini: $${commissionSummary.commission_today}`);
        console.log(`📊 Volume Trading Hari Ini: ${commissionSummary.volume_lots_today} Lot`);
        console.log(`💼 Saldo Siap Tarik: $${commissionSummary.withdrawable_balance}`);
        console.log(`✨ Member Lolos VIP (Equity ≥ $5): ${eligibleMembers.length}`);
        console.log(`⏳ Member Belum Memenuhi (< $5): ${lowEquityMembers.length}`);
        console.log(`🚪 Member Terdeteksi Keluar IB: ${removedDetectedCount}`);
        console.log(`👑 Total Tercatat di Database: ${grandSynced}`);
        console.log(`⏱️  Durasi: ${durationSec} detik`);
        console.log(`====================================================\n`);

        let eligibleListText = '';
        if (eligibleMembers.length > 0) {
            eligibleListText = '\n\n💎 <b>Daftar Member Lolos VIP (Equity ≥ $5):</b>\n' +
                eligibleMembers.map((m, idx) => {
                    const nameStr = m.full_name ? ` (${m.full_name})` : '';
                    return `${idx + 1}. <code>${m.email}</code>${nameStr} — <b>$${m.equity}</b>`;
                }).join('\n');
        } else {
            eligibleListText = '\n\n⚠️ <i>Belum ada member dengan equity ≥ $5.</i>';
        }

        const commStr = summaryData.commission_today > 0 ? Number(summaryData.commission_today).toFixed(4) : '0.0000';
        const volStr = summaryData.volume_lots_today > 0 ? Number(summaryData.volume_lots_today).toFixed(4) : '0.0000';
        const balStr = summaryData.withdrawable_balance > 0 ? Number(summaryData.withdrawable_balance).toFixed(4) : '0.0000';
        const depStr = Number(clientStats.total_deposit || 0).toFixed(2);
        const wdrStr = Number(clientStats.total_withdrawal || 0).toFixed(2);
        const clientCountVal = clientStats.client_count > 0 ? clientStats.client_count : allMembers.length;
        const newClientSuffix = clientStats.new_client_count > 0 ? ` (${clientStats.new_client_count} Klien Baru)` : '';

        if (allMembers.length > 0) {
            await sendTelegram(
                `✅ <b>RHFX SYNC & EARNINGS REPORT</b>\n\n` +
                `📊 <b>IKHTISAR UTAMA:</b>\n` +
                `💵 Komisi Hari Ini  : <b>$${commStr}</b>\n` +
                `🗄️ Total Database   : <b>${grandSynced} Client (${durationSec} dtk)</b>\n` +
                `✨ Lolos VIP (≥ $5) : <b>${eligibleMembers.length} Member</b>\n` +
                `👥 Jumlah Klien     : <b>${clientCountVal} Klien${newClientSuffix}</b>\n\n` +
                `💰 <b>FINANSIAL & TRADING:</b>\n` +
                `📊 Volume Trading   : <b>${volStr} Lot</b>\n` +
                `💼 Saldo Siap Tarik : <b>$${balStr}</b>\n` +
                `📥 Total Deposit    : <b>$${depStr}</b>\n` +
                `📤 Total Penarikan  : <b>$${wdrStr}</b>\n` +
                `⏳ Belum Memenuhi   : <b>${lowEquityMembers.length} Member (&lt; $5)</b>` +
                eligibleListText + '\n\n' +
                `🕐 <i>${endTime.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB</i>`
            );
        } else {
            await sendTelegram(
                `⚠️ <b>RHFX Sync WARNING</b>\n\n` +
                `❗ 0 member berhasil dibaca dari Valetax.\n` +
                `💵 Komisi Hari Ini: <b>$${commStr}</b>\n` +
                `💼 Saldo Siap Tarik: <b>$${balStr}</b>\n\n` +
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
        if (browser) {
            try { await browser.close(); } catch(e) {}
        }
    }
}

runClientSync();
