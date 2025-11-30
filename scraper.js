import puppeteer from "puppeteer";
import admin from "firebase-admin";
import cron from "node-cron";
import fs from "fs";

// -------------------------------
// FIREBASE SERVICE ACCOUNT FIX
// -------------------------------
if (process.env.SERVICE_ACCOUNT_JSON) {
  const tmpPath = "/tmp/service-account.json";
  fs.writeFileSync(tmpPath, process.env.SERVICE_ACCOUNT_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

const db = admin.firestore();

const SCRAPE_INTERVAL_MIN = parseInt(process.env.SCRAPE_INTERVAL_MIN || "60");

// ---------------------------------------
// UTIL: Extract hashtags from any text
// ---------------------------------------
function parseHashtagsFromText(text) {
  const regex = /#([A-Za-z0-9_]+)/g;
  const map = {};
  let match;

  while ((match = regex.exec(text)) !== null) {
    const tag = "#" + match[1].toLowerCase();
    map[tag] = (map[tag] || 0) + 1;
  }

  return map;
}

// ---------------------------------------
// MAIN SCRAPER FUNCTION
// ---------------------------------------
async function fetchTrendingForCountry(countryCode = "global") {
  console.log(`⏳ Starting scrape for: ${countryCode}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    const page = await browser.newPage();

    // Pretend to be a real user
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/118.0 Safari/537.36"
    );

    // TikTok changes often, this is best stable URL
    const url = "https://www.tiktok.com/discover";

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 90000,
    });

    // Wait for trending section to load (TikTok dynamic)
    await page.waitForTimeout(5000);

    // ---------------------------------------
    // Grab visible text for fallback extraction
    // ---------------------------------------
    const allText = await page.evaluate(() => document.body.innerText);

    const counts = parseHashtagsFromText(allText);

    // ---------------------------------------
    // DOM extraction of trending hashtags
    // ---------------------------------------
    const tagsFromDOM = await page.evaluate(() => {
      const found = [];
      const selectors = [
        "[data-e2e='trending-item'] a",
        "[data-e2e='suggested-hashtag']",
        ".tiktok-1qb12g8-SpanText", // older layout
        "a[href*='/tag/']",
      ];

      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(node => {
          const t = node.innerText || node.textContent;
          if (t && t.startsWith("#") && t.length < 50) {
            found.push(t.trim());
          }
        });
      });

      return found;
    });

    // Merge DOM results
    tagsFromDOM.forEach(tag => {
      const key = tag.toLowerCase();
      counts[key] = (counts[key] || 0) + 5; // weight DOM tags higher
    });

    // Convert to sorted array
    const hashtags = Object.entries(counts)
      .map(([tag, score]) => ({ tag, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 150);

    // ---------------------------------------
    // Save to Firestore
    // ---------------------------------------
    const docRef = db.collection("trending").doc(countryCode);

    await docRef.set({
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      hashtags,
      count: hashtags.length,
      source: "tiktok",
    });

    console.log(`✅ Saved ${hashtags.length} hashtags for ${countryCode}`);
  } catch (err) {
    console.error("❌ SCRAPER ERROR:", err.message || err);
  } finally {
    await browser.close();
  }
}

// ---------------------------------------
// RUN + CRON SCHEDULING
// ---------------------------------------
(async () => {
  await fetchTrendingForCountry("global");

  const minutes = Math.max(1, SCRAPE_INTERVAL_MIN);
  const cronExpression = `*/${minutes} * * * *`;

  console.log(`⏱️ Cron scheduled: every ${minutes} minutes (${cronExpression})`);

  cron.schedule(cronExpression, async () => {
    try {
      await fetchTrendingForCountry("global");
    } catch (err) {
      console.error("❌ Scheduled scrape error:", err);
    }
  });
})();
