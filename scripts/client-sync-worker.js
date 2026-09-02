/**
 * Universal Cloud Client & Member Sync Engine (Ultra-Secure Anonymous Edition)
 * 
 * Script otomatis untuk sinkronisasi data member/client secara periodik.
 * Semua URL, Kunci Akses, dan Domain disimpan aman di Secrets.
 */

const puppeteer = require('puppeteer');

const SUMMARY_URL = process.env.PORTAL_SUMMARY_URL || 'https://ma.valetax-indonesia.com/partnership/summary';
const NETWORK_URL = process.env.PORTAL_NETWORK_URL || 'https://ma.valetax-indonesia.com/partnership/network/parental-tree';

const CF_CLEARANCE = process.env.PORTAL_CLEARANCE || '';
const FX_TOKEN = process.env.PORTAL_FX_TOKEN || '';
const PARTNER_ID = process.env.PORTAL_PARTNER_ID || '';
const ANALYTICS_ID = process.env.PORTAL_ANALYTICS_ID || '';

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

        // Blokir popup & tracker
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

        // 4. Akses Network Tree
        console.log(`🌳 [2/2] Opening Client Network Records...`);
        await page.goto(NETWORK_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 6000));

        // Bersihkan DOM
        await page.evaluate(() => {
            document.querySelectorAll('[id*="chat"], [class*="chat"], [class*="widget"], [class*="rio"], iframe[src*="chat"]').forEach(el => el.remove());
        });

        // Set pagination ke 100
        try {
            await page.evaluate(() => {
                const selects = Array.from(document.querySelectorAll('select'));
                for (const sel of selects) {
                    const has100 = Array.from(sel.options).some(o => o.value === '100' || o.text.includes('100'));
                    if (has100) {
                        sel.value = '100';
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                        break;
                    }
                }
            });
            await new Promise(r => setTimeout(r, 3000));
        } catch (e) {}

        // 5. Ekstraksi Data
        let pageNum = 1;
        let grandSynced = 0;

        while (true) {
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

            console.log(`📄 Page ${pageNum}: ${pageRawText.length} characters`);

            if (!pageRawText || pageRawText.trim().length === 0) break;

            const response = await fetch(SYNC_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Sync-Key': SYNC_KEY },
                body: JSON.stringify({ 
                    raw_text: pageRawText, 
                    preview: false, 
                    sync_key: SYNC_KEY, 
                    source: 'cloud_engine' 
                })
            });

            const result = await response.json();
            if (result.status === 'success') {
                console.log(`✅ Page ${pageNum} Synced successfully: ${result.total || 0} clients, Eligible: ${result.eligible || 0}`);
                grandSynced = result.total || grandSynced;
            } else {
                console.warn(`⚠️ Endpoint Response: ${result.message}`);
            }

            const hasNextPage = await page.evaluate(() => {
                const nextButtons = Array.from(document.querySelectorAll('button, a, .page-link, .pagination a'));
                const nextBtn = nextButtons.find(el => {
                    const text = (el.textContent || '').trim().toLowerCase();
                    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                    return text === 'next' || text === '>' || text === '>>' || aria.includes('next');
                });
                if (nextBtn && !nextBtn.disabled && !nextBtn.classList.contains('disabled')) {
                    nextBtn.click();
                    return true;
                }
                return false;
            });

            if (hasNextPage) {
                pageNum++;
                await new Promise(r => setTimeout(r, 4000));
            } else {
                break;
            }

            if (pageNum > 20) break;
        }

        console.log(`====================================================`);
        console.log(`🎉 [SESSION COMPLETED] Total Clients Registered: ${grandSynced}`);
        console.log(`====================================================\n`);

    } catch (error) {
        console.error('❌ Engine error:', error.message);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

runClientSync();
