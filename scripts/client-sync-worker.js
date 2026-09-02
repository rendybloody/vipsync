/**
 * Universal Cloud Client & Member Sync Engine (Ultra-Secure Anonymous Edition)
 * 
 * Script otomatis untuk sinkronisasi data member/client secara periodik.
 * Mendukung Multi-Page Skala Besar (hingga ribuan halaman) dengan Ekstraksi Kilat (~1 detik per halaman).
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
    console.log('⚡ [Cloud Data Engine] Starting High-Speed Scheduled Sync');
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
                url.includes('hotjar') || url.includes('clarity') || url.endsWith('.png') || url.endsWith('.jpg')) {
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
        await new Promise(r => setTimeout(r, 3500));

        // Periksa apakah halaman ter-redirect ke login / sign-in
        let currentUrl = page.url().toLowerCase();
        console.log(`📍 Current Page URL: ${page.url()}`);

        if (currentUrl.includes('sign-in') || currentUrl.includes('login') || currentUrl.includes('auth') || currentUrl.includes('guest')) {
            console.log('🔐 Session token expired / Redirected to Sign-In. Attempting automated login...');
            
            if (PORTAL_EMAIL && PORTAL_PASSWORD) {
                console.log(`🔑 Filling credentials for ${PORTAL_EMAIL}...`);
                try {
                    await page.waitForSelector('input', { timeout: 15000 });
                    
                    await page.evaluate((email, pass) => {
                        const inputs = Array.from(document.querySelectorAll('input'));
                        const emailInput = inputs.find(i => 
                            i.type === 'email' || 
                            i.name === 'email' || 
                            i.name === 'login' || 
                            i.id === 'email' || 
                            (i.placeholder && i.placeholder.toLowerCase().includes('email')) ||
                            (i.getAttribute('formcontrolname') === 'email')
                        ) || inputs[0];

                        const passInput = inputs.find(i => 
                            i.type === 'password' || 
                            i.name === 'password' || 
                            i.id === 'password' || 
                            (i.getAttribute('formcontrolname') === 'password')
                        ) || inputs[1];

                        if (emailInput) {
                            emailInput.focus();
                            emailInput.value = email;
                            emailInput.dispatchEvent(new Event('input', { bubbles: true }));
                            emailInput.dispatchEvent(new Event('change', { bubbles: true }));
                            emailInput.dispatchEvent(new Event('blur', { bubbles: true }));
                        }

                        if (passInput) {
                            passInput.focus();
                            passInput.value = pass;
                            passInput.dispatchEvent(new Event('input', { bubbles: true }));
                            passInput.dispatchEvent(new Event('change', { bubbles: true }));
                            passInput.dispatchEvent(new Event('blur', { bubbles: true }));
                        }
                    }, PORTAL_EMAIL, PORTAL_PASSWORD);

                    await new Promise(r => setTimeout(r, 800));

                    await page.evaluate(() => {
                        const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
                        const submitBtn = btns.find(b => 
                            b.type === 'submit' || 
                            b.textContent.toLowerCase().includes('sign in') || 
                            b.textContent.toLowerCase().includes('masuk') || 
                            b.textContent.toLowerCase().includes('log in') ||
                            b.classList.contains('btn-primary')
                        );
                        if (submitBtn) {
                            submitBtn.removeAttribute('disabled');
                            submitBtn.click();
                        }
                    });

                    await new Promise(r => setTimeout(r, 4000));
                    console.log(`🔓 Post-login URL: ${page.url()}`);
                    console.log(`🌳 Navigating to Network Parental Tree: ${NETWORK_URL}`);
                    await page.goto(NETWORK_URL, { waitUntil: 'networkidle2', timeout: 60000 });
                    await new Promise(r => setTimeout(r, 3500));

                } catch (authErr) {
                    console.warn(`⚠️ Auto-login attempt encountered an issue: ${authErr.message}`);
                }
            } else {
                console.warn('⚠️ Token expired and no PORTAL_EMAIL / PORTAL_PASSWORD secrets found.');
            }
        }

        // Bersihkan DOM dari chat widget yang mengganggu
        await page.evaluate(() => {
            document.querySelectorAll('[id*="chat"], [class*="chat"], [class*="widget"], [class*="rio"], iframe[src*="chat"]').forEach(el => el.remove());
        });

        // Coba ubah "Baris per halaman" ke 100 jika tersedia
        try {
            await page.evaluate(() => {
                const selects = Array.from(document.querySelectorAll('select'));
                for (const sel of selects) {
                    const has100 = Array.from(sel.options).some(o => o.value === '100' || o.text.includes('100'));
                    if (has100) {
                        sel.value = '100';
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                        return;
                    }
                }
                const allDivs = Array.from(document.querySelectorAll('div, span, button, [role="button"], [role="combobox"]'));
                const sizeDropdown = allDivs.find(el => {
                    const text = (el.textContent || '').trim();
                    return text === '20' || text === '20 v' || text === '20 ⌵' || (el.className && el.className.includes('page-size'));
                });
                if (sizeDropdown) {
                    sizeDropdown.click();
                    setTimeout(() => {
                        const opts = Array.from(document.querySelectorAll('li, div, span, [role="option"]'));
                        const opt100 = opts.find(o => (o.textContent || '').trim() === '100' || (o.textContent || '').includes('100'));
                        if (opt100) opt100.click();
                    }, 300);
                }
            });
            await new Promise(r => setTimeout(r, 1500));
        } catch (e) {}

        // 5. Ekstraksi Data Seluruh Halaman Skala Besar (Hingga 1000+ Halaman) - Cepat (~1.2 detik/halaman)
        let pageNum = 1;
        let grandSynced = 0;
        const allExtractedEmails = new Set();
        const maxPages = 2000; // Mendukung hingga 2000 halaman

        while (pageNum <= maxPages) {
            console.log(`📄 [Halaman ${pageNum}] Membaca data...`);
            await new Promise(r => setTimeout(r, 1200)); // Delay kilat 1.2 detik

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

            let newOnThisPage = 0;
            records.forEach(c => {
                if (!allExtractedEmails.has(c.email)) {
                    allExtractedEmails.add(c.email);
                    newOnThisPage++;
                }
                console.log(`  👤 [MEMBER] ${c.email} | ${c.full_name || 'N/A'} | Equity: $${c.equity} | Lots: ${c.total_lots}`);
            });

            console.log(`📊 Halaman ${pageNum}: ${records.length} member (${newOnThisPage} baru, Total Terkumpul: ${allExtractedEmails.size})`);

            if (records.length === 0) {
                console.log(`ℹ️ Halaman ${pageNum} kosong. Ekstraksi selesai.`);
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

            // Target Navigasi ke Halaman Berikutnya (Hal 2, 3, 4, 5, ... 100, ... 1000+)
            const targetNextPageNumber = pageNum + 1;

            const navSuccess = await page.evaluate((nextNum) => {
                const allClickable = Array.from(document.querySelectorAll('button, a, span, div, li, [role="button"], [role="link"], .page-link, .page-item'));
                
                // 1. Coba klik nomor halaman berikutnya
                const numBtn = allClickable.find(el => {
                    const txt = (el.textContent || '').trim();
                    const isExactNumber = txt === String(nextNum);
                    const isVisible = el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0;
                    return isExactNumber && isVisible;
                });

                if (numBtn) {
                    numBtn.scrollIntoView({ behavior: 'auto', block: 'center' });
                    numBtn.click();
                    return { found: true, type: 'number', label: String(nextNum) };
                }

                // 2. Coba klik tombol panah ">" (Next)
                const nextArrowBtn = allClickable.find(el => {
                    const txt = (el.textContent || '').trim();
                    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                    const title = (el.getAttribute('title') || '').toLowerCase();
                    const isNextText = txt === '>' || txt === '»' || txt.toLowerCase() === 'next' || txt.toLowerCase() === 'selanjutnya';
                    const isNextAria = aria.includes('next') || title.includes('next');
                    const isDisabled = el.disabled || el.classList.contains('disabled') || el.classList.contains('p-disabled') || el.getAttribute('aria-disabled') === 'true';
                    const isVisible = el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0;
                    return (isNextText || isNextAria) && !isDisabled && isVisible;
                });

                if (nextArrowBtn) {
                    nextArrowBtn.scrollIntoView({ behavior: 'auto', block: 'center' });
                    nextArrowBtn.click();
                    return { found: true, type: 'arrow', label: '>' };
                }

                return { found: false };
            }, targetNextPageNumber);

            if (navSuccess && navSuccess.found) {
                pageNum++;
            } else {
                console.log(`🏁 Mencapai halaman terakhir (Halaman ${pageNum}).`);
                break;
            }
        }

        console.log(`\n====================================================`);
        console.log(`🎉 [SESSION COMPLETED] Total Member Berhasil Disinkron: ${allExtractedEmails.size}`);
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
