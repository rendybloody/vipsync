/**
 * Universal Cloud Client & Member Sync Engine (Ultra-Secure Anonymous Edition)
 * 
 * Script otomatis untuk sinkronisasi data member/client secara periodik.
 * Menggunakan Real Hardware Mouse Click + Transition Verification antar halaman.
 */

const puppeteer = require('puppeteer');

const SUMMARY_URL = process.env.PORTAL_SUMMARY_URL || 'https://ma.valetax-indonesia.com/partnership/summary';
const NETWORK_URL = process.env.PORTAL_NETWORK_URL || 'https://ma.valetax-indonesia.com/partnership/network/parental-tree';

const CF_CLEARANCE = process.env.PORTAL_CLEARANCE || '';
const FX_TOKEN = process.env.PORTAL_FX_TOKEN || '';
const PARTNER_ID = process.env.PORTAL_PARTNER_ID || '';
const ANALYTICS_ID = process.env.PORTAL_ANALYTICS_ID || '';

const PORTAL_EMAIL = process.env.PORTAL_EMAIL || process.env.VALETAX_EMAIL || '';
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || process.env.VALETAX_PASSWORD || '';

// Target Sync Endpoint
const SYNC_ENDPOINT = process.env.TARGET_SYNC_URL || 'https://vip.rhfxtrade.web.id/api/valetax_sync.php';
const SYNC_KEY = process.env.TARGET_SYNC_KEY || '';

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
    console.log('====================================================');
    console.log('⚡ [Cloud Data Engine] Starting High-Precision Sync Session');
    console.log(`⏱️ Timestamp: ${new Date().toISOString()}`);
    console.log('====================================================');

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1920x1080'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        // Blokir popup & tracker yang memperlambat rendering
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url().toLowerCase();
            if (url.includes('livechat') || url.includes('intercom') || url.includes('crisp') || 
                url.includes('tawk') || url.includes('zendesk') || url.includes('freshchat') ||
                url.includes('hotjar') || url.includes('clarity')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // 1. Suntikkan Cookies
        if (CF_CLEARANCE) {
            await page.setCookie({
                name: 'cf_clearance',
                value: CF_CLEARANCE,
                domain: '.valetax-indonesia.com',
                path: '/',
                secure: true,
                httpOnly: true
            });
        }

        if (PARTNER_ID) {
            await page.setCookie({
                name: 'PartnerId',
                value: PARTNER_ID,
                domain: 'ma.valetax-indonesia.com',
                path: '/',
                secure: true,
                httpOnly: false
            });
        }

        if (FX_TOKEN) {
            await page.setCookie({
                name: 'FX-Token',
                value: FX_TOKEN,
                domain: 'ma.valetax-indonesia.com',
                path: '/',
                secure: true,
                httpOnly: false
            });
        }

        // 2. Suntikkan LocalStorage Token
        await page.evaluateOnNewDocument((token, partnerId, analyticsId) => {
            if (token) localStorage.setItem('FX-Token', token);
            if (analyticsId) localStorage.setItem('analytics_user_id', analyticsId);
            if (partnerId) localStorage.setItem('PartnerId', partnerId);
        }, FX_TOKEN, PARTNER_ID, ANALYTICS_ID);

        // 3. Akses Summary
        console.log(`🌐 [1/2] Connecting to Partner Portal...`);
        await page.goto(SUMMARY_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 2000));

        await page.evaluate((token, analyticsId) => {
            if (token) localStorage.setItem('FX-Token', token);
            if (analyticsId) localStorage.setItem('analytics_user_id', analyticsId);
        }, FX_TOKEN, ANALYTICS_ID);

        // 4. Akses Network Tree (Parental Tree)
        console.log(`🌳 [2/2] Opening Client Network Records: ${NETWORK_URL}`);
        await page.goto(NETWORK_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 4000));

        // Bersihkan DOM dari chat widget yang mengganggu
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

        console.log(`\n====================================================`);
        console.log(`🎉 [SESSION COMPLETED] Total Member Unik Berhasil Disinkron: ${allExtractedEmails.size}`);
        console.log(`👑 Total Tercatat di Database Website: ${grandSynced}`);
        console.log(`====================================================\n`);

    } catch (error) {
        console.error('❌ Engine error:', error.message);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

runClientSync();
