// scraper.js
import puppeteer from "puppeteer-core"; // <-- use puppeteer-core
import admin from "firebase-admin";
import cron from "node-cron";
import fs from "fs";

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

// Helper: parse hashtags
function parseHashtagsFromText(text) {
  const regex = /#([A-Za-z0-9_]+)/g;
  const map = {};
  let m;
  while ((m = regex.exec(text)) !== null) {
    const tag = `#${m[1].toLowerCase()}`;
    map[tag] = (map[tag] || 0) + 1;
  }
  return map;
}

// Scraper function
async function fetchTrendingForCountry(countryCode = "global") {
  console.log("Scraping hashtags for", countryCode);

  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/chromium-browser", // <-- use system Chromium
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/118.0 Safari/537.36"
    );

    const url =
      countryCode === "global"
        ? "https://www.tiktok.com/discover"
        : `https://www.tiktok.com/tag/${countryCode}`;

    await page.goto(url, { waitUntil: "networkidle2", timeout: 90000 });
    await page.waitForTimeout(5000);

    const allText = await page.evaluate(() => document.body.innerText);
    const counts = {};
    allText.match(/#([A-Za-z0-9_]+)/g)?.forEach(tag => {
      const key = tag.toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
    });

    const tagsFromDOM = await page.evaluate(() => {
      const found = [];
      const selectors = [
        "[data-e2e='trending-item'] a",
        "[data-e2e='suggested-hashtag']",
        ".tiktok-1qb12g8-SpanText",
        "a[href*='/tag/']",
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(node => {
          const t = node.innerText || node.textContent;
          if (t && t.startsWith("#") && t.length < 50) found.push(t.trim());
        });
      });
      return found;
    });

    tagsFromDOM.forEach(tag => {
      const key = tag.toLowerCase();
      counts[key] = (counts[key] || 0) + 5;
    });

    const hashtags = Object.entries(counts)
      .map(([tag, score]) => ({ tag, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 150);

    const docRef = db.collection("trending").doc(countryCode);
    await docRef.set({
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      hashtags,
      count: hashtags.length,
      source: "tiktok",
    });

    console.log(`✅ Saved ${hashtags.length} hashtags for ${countryCode}`);
  } catch (err) {
    console.error("❌ Scraper error:", err.message || err);
  } finally {
    await browser.close();
  }
}

// Optional: run immediately for global
(async () => {
  await fetchTrendingForCountry("global");

  const minutes = Math.max(1, SCRAPE_INTERVAL_MIN);
  const cronExpr = `*/${minutes} * * * *`;
  console.log("Scheduling scrape every", minutes, "minutes:", cronExpr);

  cron.schedule(cronExpr, async () => {
    try {
      await fetchTrendingForCountry("global");
    } catch (err) {
      console.error("Scheduled scrape failed:", err);
    }
  });
})();
