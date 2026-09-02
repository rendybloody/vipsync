/**
 * Universal Cloud Client & Member Sync Engine v2 - Stealth Auto-Login Edition
 *
 * Perubahan v2:
 * - Login otomatis via Email + Password (tidak perlu update token manual)
 * - Stealth mode anti-Cloudflare bot detection (puppeteer-extra-plugin-stealth)
 * - Notifikasi Telegram otomatis saat ERROR & saat SUKSES selesai sync
 */

const { execSync } = require('child_process');

try { require.resolve('puppeteer-extra'); } catch(e) {
    console.log('📦 Installing puppeteer-extra & stealth plugin...');
    execSync('npm install puppeteer-extra puppeteer-extra-plugin-stealth --save', { stdio: 'inherit' });
}

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

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
const NETWORK_URL = process.env.PORTAL_NETWORK_URL || 'https://ma.valetax-indonesia.com/partnership/network/parental-tree';
const PORTAL_EMAIL    = process.env.PORTAL_EMAIL    || '';
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || '';
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
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\t+|\s{2,}/).map(p => p.trim()).filter(Boolean);
        let emailKey = null;
        parts.forEach((p, idx) => { if (emailPattern.test(p)) emailKey = idx; });
        if (emailKey !== null && parts.length >= 2) {
            const email = parts[emailKey].toLowerCase();
            const numbers = []; let namePart = ''; let structure = '';
            parts.forEach((p, idx) => {
                if (idx === emailKey) return;
                if (numberPattern.test(p)) numbers.push(parseFloat(p));
                else if (!structure && structurePattern.test(p)) structure = p;
                else if (!namePart && !ignoreWordsPattern.test(p)) namePart = p;
            });
            if (numbers.length >= 1) records[email] = { email, full_name: namePart, total_lots: numbers[0]||0, total_rebates: numbers[1]||0, equity: numbers[numbers.length-1]||0, structure };
        }
    }
    for (let i = 0; i < lines.length; i++) {
        const email = lines[i].trim().toLowerCase();
        if (!emailPattern.test(email)) continue;
        if (records[email] && records[email].full_name && records[email].equity > 0) continue;
        let name = ''; const numbers = []; let structure = '';
        for (let j = i + 1; j < lines.length; j++) {
            const val = lines[j].trim();
            if (emailPattern.test(val)) break;
            if (!val) continue;
            if (!structure && structurePattern.test(val)) { structure = val; break; }
            if (numberPattern.test(val)) { if (numbers.length < 3) numbers.push(parseFloat(val)); continue; }
            if (!name && !ignoreWordsPattern.test(val)) name = val;
        }
        if (numbers.length >= 1 || records[email]) {
            records[email] = { email, full_name: name||(records[email]?.full_name||''), total_lots: numbers[0]??(records[email]?.total_lots||0), total_rebates: numbers[1]??(records[email]?.total_rebates||0), equity: numbers[numbers.length-1]??(records[email]?.equity||0), structure: structure||(records[email]?.structure||'') };
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
        await sendTelegram(`🚨 <b>RHFX Sync ERROR</b>\n\n${msg}`);
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--window-size=1366,768','--disable-blink-features=AutomationControlled']
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url().toLowerCase();
            const blocked = ['livechat','intercom','crisp','tawk','zendesk','freshchat','hotjar','clarity'];
            if (blocked.some(b => url.includes(b))) req.abort(); else req.continue();
        });

        console.log('\n🔐 [Step 1] Membuka halaman login Valetax...');
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 3000));
        const currentUrl = page.url();
        console.log(`📍 URL: ${currentUrl}`);

        const isLoggedIn = currentUrl.includes('/dashboard') || currentUrl.includes('/partnership');
        if (!isLoggedIn) {
            console.log('\n📝 [Step 2] Mengisi form login...');
            try { await page.waitForSelector('input[type="email"], input[name="email"], input[type="text"]', { timeout: 15000 }); }
            catch(e) { throw new Error(`Form login tidak ditemukan. Kemungkinan kena Cloudflare.`); }

            let emailField = null;
            for (const sel of ['input[type="email"]','input[name="email"]','input[id*="email"]']) {
                try { emailField = await page.$(sel); if (emailField) break; } catch(e) {}
            }
            if (!emailField) { const inputs = await page.$$('input:not([type="hidden"])'); if (inputs.length > 0) emailField = inputs[0]; }
            if (!emailField) throw new Error('Field email tidak ditemukan!');
            await emailField.click({ clickCount: 3 });
            await emailField.type(PORTAL_EMAIL, { delay: 80 });
            await new Promise(r => setTimeout(r, 800));

            let passField = null;
            for (const sel of ['input[type="password"]','input[name="password"]']) {
                try { passField = await page.$(sel); if (passField) break; } catch(e) {}
            }
            if (!passField) throw new Error('Field password tidak ditemukan!');
            await passField.click({ clickCount: 3 });
            await passField.type(PORTAL_PASSWORD, { delay: 90 });
            await new Promise(r => setTimeout(r, 600));

            let loginBtn = null;
            for (const sel of ['button[type="submit"]','input[type="submit"]','button:not([type])']) {
                try {
                    const els = await page.$$(sel);
                    for (const el of els) {
                        const txt = (await page.evaluate(e => e.innerText || e.value || '', el)||'').toLowerCase();
                        if (txt.includes('login')||txt.includes('masuk')||txt.includes('sign')) { loginBtn = el; break; }
                    }
                    if (loginBtn) break;
                } catch(e) {}
            }
            if (!loginBtn) { await passField.press('Enter'); } else { await loginBtn.click(); }

            try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }); } catch(e) {}
            await new Promise(r => setTimeout(r, 3000));
            const afterUrl = page.url();
            console.log(`📍 URL setelah login: ${afterUrl}`);
            if (afterUrl.includes('/login') || afterUrl === LOGIN_URL) throw new Error(`Login GAGAL! Cek PORTAL_EMAIL & PORTAL_PASSWORD di GitHub Secrets!`);
            console.log('✅ Login berhasil!');
        }

        console.log(`\n🌳 [Step 3] Buka halaman member: ${NETWORK_URL}`);
        await page.goto(NETWORK_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 4000));
        await page.evaluate(() => { document.querySelectorAll('[id*="chat"],[class*="chat"],[class*="widget"],iframe[src*="chat"]').forEach(el => el.remove()); });

        let pageNum = 1, grandSynced = 0;
        const allExtractedEmails = new Set();

        while (pageNum <= 2000) {
            console.log(`\n📄 [Halaman ${pageNum}] Membaca data...`);
            await new Promise(r => setTimeout(r, 1200));
            const pageRawText = await page.evaluate(() => document.body.innerText || '');
            const records = parseRawTextToRecords(pageRawText);
            const currentFirstEmail = records[0]?.email || '';
            let newOnPage = 0;
            records.forEach(c => { if (!allExtractedEmails.has(c.email)) { allExtractedEmails.add(c.email); newOnPage++; } console.log(`  👤 ${c.email} | Equity: $${c.equity}`); });
            console.log(`📊 Hal ${pageNum}: ${records.length} member (${newOnPage} baru, Total: ${allExtractedEmails.size})`);
            if (records.length === 0) { console.log(`ℹ️ Halaman kosong. Selesai.`); break; }

            const response = await fetch(SYNC_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY }, body: JSON.stringify({ records, preview: false, sync_key: SYNC_KEY, source: 'cloud_engine_v2' }) });
            const result = await response.json();
            if (result.status === 'success') grandSynced = result.total || grandSynced;

            const nextNum = pageNum + 1;
            const btnCoord = await page.evaluate((n) => {
                const els = Array.from(document.querySelectorAll('button,a,span,div,li,[role="button"],.page-link,[class*="page"],[class*="pagin"]'));
                const numEl = els.find(el => (el.textContent||'').trim()===String(n) && el.getBoundingClientRect().width > 0);
                if (numEl) { numEl.scrollIntoView({block:'center'}); const r=numEl.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,type:'number'}; }
                const arrEl = els.find(el => { const t=(el.textContent||'').trim(); const a=(el.getAttribute('aria-label')||'').toLowerCase(); return (t==='>'||t==='»'||t.toLowerCase()==='next'||a.includes('next'))&&!el.disabled&&!el.classList.contains('disabled')&&el.getBoundingClientRect().width>0; });
                if (arrEl) { arrEl.scrollIntoView({block:'center'}); const r=arrEl.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,type:'arrow'}; }
                return null;
            }, nextNum);

            if (!btnCoord) { console.log(`🏁 Tidak ada halaman berikutnya. Selesai.`); break; }
            await page.mouse.click(btnCoord.x, btnCoord.y);

            let changed = false;
            for (let i = 0; i < 6; i++) {
                await new Promise(r => setTimeout(r, 600));
                const newRecs = parseRawTextToRecords(await page.evaluate(() => document.body.innerText||''));
                if (newRecs[0]?.email && newRecs[0].email !== currentFirstEmail) { changed = true; break; }
            }
            if (!changed) { console.log(`⚠️ Sudah halaman terakhir.`); break; }
            pageNum++;
        }

        const endTime = new Date();
        const dur = Math.round((endTime - startTime) / 1000);
        console.log(`\n🎉 SELESAI! Member: ${allExtractedEmails.size} | DB: ${grandSynced} | Durasi: ${dur}s`);

        if (allExtractedEmails.size > 0) {
            await sendTelegram(`✅ <b>RHFX Sync SUKSES</b>\n\n👥 Member disinkron: <b>${allExtractedEmails.size}</b>\n🗄️ Total DB: <b>${grandSynced}</b>\n⏱️ Durasi: ${dur} detik\n🕐 ${endTime.toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB`);
        } else {
            await sendTelegram(`⚠️ <b>RHFX Sync WARNING</b>\n\n❗ 0 member dibaca dari Valetax.\n🔍 Cek: https://github.com/rendybloody/vipsync/actions\n🕐 ${endTime.toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB`);
        }

    } catch (error) {
        console.error('\n❌ ENGINE ERROR:', error.message);
        await sendTelegram(`🚨 <b>RHFX Sync ERROR!</b>\n\n❌ ${error.message.substring(0,400)}\n\n🔗 https://github.com/rendybloody/vipsync/actions\n🕐 ${new Date().toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})} WIB`);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

runClientSync();
