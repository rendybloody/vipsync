/**
 * Universal Cloud Client & Member Sync Engine (Ultra-Secure Anonymous Edition)
 * 
 * Script otomatis untuk sinkronisasi data member/client secara periodik.
 * Mendukung Token Session + Auto-Login Email/Password Fallback + Multi-Page Pagination (100 per page).
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
    console.log('⚡ [Cloud Data Engine] Starting Scheduled Sync Session');
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
        await new Promise(r => setTimeout(r, 3000));

        await page.evaluate((token, analyticsId) => {
            if (token) localStorage.setItem('FX-Token', token);
            if (analyticsId) localStorage.setItem('analytics_user_id', analyticsId);
        }, FX_TOKEN, ANALYTICS_ID);

        // 4. Akses Network Tree (Parental Tree)
        console.log(`🌳 [2/2] Opening Client Network Records: ${NETWORK_URL}`);
        await page.goto(NETWORK_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 8000));

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

                    await new Promise(r => setTimeout(r, 1000));

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

                    await new Promise(r => setTimeout(r, 6000));
                    console.log(`🔓 Post-login URL: ${page.url()}`);
                    console.log(`🌳 Navigating to Network Parental Tree: ${NETWORK_URL}`);
                    await page.goto(NETWORK_URL, { waitUntil: 'networkidle2', timeout: 60000 });
                    await new Promise(r => setTimeout(r, 8000));

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

        // Set pagination ke 100 client per halaman
        console.log('⚙️ Setting table pagination to 100 rows per page...');
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
                const dropdowns = Array.from(document.querySelectorAll('.p-dropdown, .dropdown, [class*="select"], [role="combobox"], [class*="page-size"]'));
                for (const dd of dropdowns) {
                    if (dd.textContent.includes('10') || dd.textContent.includes('20') || dd.textContent.includes('25') || dd.textContent.includes('50') || dd.textContent.includes('100')) {
                        dd.click();
                        setTimeout(() => {
                            const opts = Array.from(document.querySelectorAll('.p-dropdown-item, .dropdown-item, [role="option"], li'));
                            const opt100 = opts.find(o => o.textContent.trim() === '100' || o.textContent.includes('100'));
                            if (opt100) opt100.click();
                        }, 500);
                        return;
                    }
                }
            });
            await new Promise(r => setTimeout(r, 5000));
        } catch (e) {}

        // 5. Ekstraksi Data Seluruh Halaman (Looping Multi-Page)
        let pageNum = 1;
        let grandSynced = 0;
        const allExtractedClients = [];

        while (true) {
            console.log(`\n📄 [Processing Page ${pageNum}] Scraping table data...`);
            await new Promise(r => setTimeout(r, 4000));

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

            console.log(`📄 Page ${pageNum}: Raw text length = ${pageRawText.length} characters`);

            // Parse structured records from raw text
            const records = parseRawTextToRecords(pageRawText);
            console.log(`📊 Page ${pageNum}: Successfully parsed ${records.length} client records`);

            // Print each client found for transparent logs
            records.forEach(c => {
                allExtractedClients.push(c);
                console.log(`  👤 [CLIENT] ${c.email} | ${c.full_name || 'N/A'} | Equity: $${c.equity} | Lots: ${c.total_lots}`);
            });

            if (!pageRawText || pageRawText.trim().length === 0 || records.length === 0) {
                console.log(`ℹ️ Page ${pageNum} contains no more client records.`);
                break;
            }

            // Kirim ke backend sync endpoint
            console.log(`🚀 Sending Page ${pageNum} data (${records.length} records) to Website Database (${SYNC_ENDPOINT})...`);
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
                console.log(`✅ Page ${pageNum} Synced successfully: ${result.total || 0} clients saved, Eligible (≥$5): ${result.eligible || 0}`);
                grandSynced = result.total || grandSynced;
            } else {
                console.warn(`⚠️ Endpoint Response: ${result.message}`);
            }

            // Periksa apakah ada halaman berikutnya (Next Page)
            const hasNextPage = await page.evaluate(() => {
                const selectors = [
                    'button[aria-label*="Next" i]',
                    'a[aria-label*="Next" i]',
                    '.p-paginator-next:not(.p-disabled)',
                    '.pagination-next:not(.disabled) a',
                    '.pagination .next:not(.disabled) a',
                    'button.next:not([disabled])',
                    'a.next:not(.disabled)',
                    'li.next:not(.disabled) a',
                    '.page-item:not(.disabled) a[aria-label*="next" i]'
                ];
                for (const s of selectors) {
                    const el = document.querySelector(s);
                    if (el && !el.disabled && !el.classList.contains('disabled') && !el.classList.contains('p-disabled')) {
                        el.click();
                        return true;
                    }
                }
                const buttons = Array.from(document.querySelectorAll('button, a, .page-link, [role="button"]'));
                const nextBtn = buttons.find(el => {
                    const text = (el.textContent || '').trim().toLowerCase();
                    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                    const isNext = text === 'next' || text === '>' || text === '»' || text === 'selanjutnya' || aria.includes('next');
                    const isDisabled = el.disabled || el.classList.contains('disabled') || el.classList.contains('p-disabled') || el.getAttribute('aria-disabled') === 'true';
                    return isNext && !isDisabled;
                });
                if (nextBtn) {
                    nextBtn.click();
                    return true;
                }
                return false;
            });

            if (hasNextPage) {
                pageNum++;
                console.log(`⏭️ Moving to Next Page (${pageNum})...`);
                await new Promise(r => setTimeout(r, 6000));
            } else {
                console.log(`🏁 Reached last page of client records.`);
                break;
            }

            if (pageNum > 20) break;
        }

        console.log(`\n====================================================`);
        console.log(`🎉 [SESSION COMPLETED] Total Clients Extracted: ${allExtractedClients.length}`);
        console.log(`👑 Total Registered in Database: ${grandSynced}`);
        console.log(`====================================================\n`);

    } catch (error) {
        console.error('❌ Engine error:', error.message);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

runClientSync();
