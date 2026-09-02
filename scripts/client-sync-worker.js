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
        await new Promise(r => setTimeout(r, 6000));

        // Periksa apakah halaman ter-redirect ke login / sign-in
        let currentUrl = page.url().toLowerCase();
        console.log(`📍 Current Page URL: ${page.url()}`);

        if (currentUrl.includes('sign-in') || currentUrl.includes('login') || currentUrl.includes('auth')) {
            console.log('🔐 Redirected to Sign-In. Attempting automated login with credentials...');
            
            if (PORTAL_EMAIL && PORTAL_PASSWORD) {
                console.log(`🔑 Logging in as ${PORTAL_EMAIL}...`);
                try {
                    const emailInput = await page.$('input[type="email"], input[name="email"], input[name="login"], input[placeholder*="email" i], input[type="text"]');
                    if (emailInput) {
                        await emailInput.click({ clickCount: 3 });
                        await emailInput.type(PORTAL_EMAIL, { delay: 40 });
                    }

                    const passInput = await page.$('input[type="password"], input[name="password"]');
                    if (passInput) {
                        await passInput.click({ clickCount: 3 });
                        await passInput.type(PORTAL_PASSWORD, { delay: 40 });
                    }

                    const submitBtn = await page.$('button[type="submit"], button.btn-primary, button');
                    if (submitBtn) {
                        await Promise.all([
                            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
                            submitBtn.click()
                        ]);
                        await new Promise(r => setTimeout(r, 5000));
                    }

                    console.log(`🔓 Post-login URL: ${page.url()}`);
                    console.log(`🌳 Re-navigating to Network Parental Tree: ${NETWORK_URL}`);
                    await page.goto(NETWORK_URL, { waitUntil: 'networkidle2', timeout: 60000 });
                    await new Promise(r => setTimeout(r, 6000));
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
                // Native select
                const selects = Array.from(document.querySelectorAll('select'));
                for (const sel of selects) {
                    const has100 = Array.from(sel.options).some(o => o.value === '100' || o.text.includes('100'));
                    if (has100) {
                        sel.value = '100';
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                        return;
                    }
                }
                // Custom UI dropdown (PrimeNG / Angular / Material / React)
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
            await new Promise(r => setTimeout(r, 4000));
        } catch (e) {}

        // 5. Ekstraksi Data Seluruh Halaman (Looping Multi-Page)
        let pageNum = 1;
        let grandSynced = 0;
        const allExtractedClients = [];

        while (true) {
            console.log(`\n📄 [Processing Page ${pageNum}] Scraping table data...`);
            await new Promise(r => setTimeout(r, 3000));

            const pageData = await page.evaluate(() => {
                let fullText = document.body.innerText || '';
                document.querySelectorAll('iframe').forEach(f => {
                    try {
                        const doc = f.contentDocument || f.contentWindow.document;
                        if (doc && doc.body) fullText += '\n' + doc.body.innerText;
                    } catch (err) {}
                });

                // Structured extraction directly from HTML table rows
                const rows = Array.from(document.querySelectorAll('table tbody tr, tr, [role="row"]'));
                const records = [];
                const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
                const numberRegex = /^-?\d+(?:\.\d+)?$/;
                const structureRegex = /^\d+(?:\s*\|\s*\d+){1,}$/;
                const ignoreWordsRegex = /^(active|inactive|verified|level|lots|rebates|equity|usd|idr|client|name|email)$/i;

                for (const row of rows) {
                    const text = (row.innerText || '').trim();
                    const emailMatch = text.match(emailRegex);
                    if (!emailMatch) continue;

                    const email = emailMatch[0].toLowerCase();
                    const parts = text.split(/\t+|\n+|\s{2,}/).map(p => p.trim()).filter(Boolean);

                    const numbers = [];
                    let name = '';
                    let structure = '';

                    for (const p of parts) {
                        if (p.toLowerCase() === email) continue;
                        if (structureRegex.test(p)) {
                            structure = p;
                        } else if (numberRegex.test(p)) {
                            numbers.push(parseFloat(p));
                        } else if (!name && !ignoreWordsRegex.test(p)) {
                            name = p;
                        }
                    }

                    if (numbers.length >= 1) {
                        records.push({
                            email: email,
                            full_name: name,
                            total_lots: numbers[0] || 0,
                            total_rebates: numbers[1] || 0,
                            equity: numbers[numbers.length - 1] || 0,
                            structure: structure
                        });
                    }
                }

                return {
                    rawText: fullText,
                    records: records
                };
            });

            const rawText = pageData.rawText || '';
            const records = pageData.records || [];

            console.log(`📊 Page ${pageNum}: Found ${records.length} structured client rows`);

            // Print each client found for transparent logs
            records.forEach(c => {
                allExtractedClients.push(c);
                console.log(`  👤 [CLIENT] ${c.email} | ${c.full_name || 'N/A'} | Equity: $${c.equity} | Lots: ${c.total_lots}`);
            });

            if (!rawText || rawText.trim().length === 0 || records.length === 0) {
                console.log(`ℹ️ Page ${pageNum} contains no more client records.`);
                break;
            }

            // Kirim ke backend sync endpoint
            console.log(`🚀 Sending Page ${pageNum} data to Website Database (${SYNC_ENDPOINT})...`);
            const response = await fetch(SYNC_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
                body: JSON.stringify({ 
                    records: records,
                    raw_text: rawText, 
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
                await new Promise(r => setTimeout(r, 5000));
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
