// scraper.js
import puppeteer from "puppeteer";
import admin from "firebase-admin";
import cron from "node-cron";
import * as fs from "fs";

if (process.env.SERVICE_ACCOUNT_JSON) {
  const tmpPath = "/tmp/service-account.json";
  fs.writeFileSync(tmpPath, process.env.SERVICE_ACCOUNT_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

const SCRAPE_INTERVAL_MIN = parseInt(process.env.SCRAPE_INTERVAL_MIN || "60");

// Helper: parse hashtags from a page content string
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

async function fetchTrendingForCountry(countryCode = "global") {
  console.log("Starting fetch for", countryCode);
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: true
  });
  try {
    const page = await browser.newPage();
    // Use TikTok explore/trending URL or search results
    // NOTE: TikTok frequently changes layout. This example loads the "discover" page.
    const url = countryCode === "global"
      ? "https://www.tiktok.com/discover"
      : `https://www.tiktok.com/tag/${countryCode}`; // fallback

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // collect visible text and meta tags
    const bodyText = await page.evaluate(() => document.body.innerText || "");
    const metaTags = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("meta")).map(m => ({ name: m.name, content: m.content || "" }));
    });

    // gather hashtags from text
    const counts = parseHashtagsFromText(bodyText);

    // Additionally attempt to pull tag elements (if discover page has them)
    const tagsFromDOM = await page.evaluate(() => {
      const list = [];
      // common selectors observed — adjust if TikTok changed layout
      const nodes = document.querySelectorAll("[data-e2e='hashtag-item'] a, .discover-item a, .tiktok-1tag a");
      nodes.forEach(n => {
        const text = n.innerText || n.textContent || "";
        if (text && text.startsWith("#")) list.push(text);
      });
      return list;
    });

    tagsFromDOM.forEach(t => {
      const key = t.toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
    });

    // Convert to sorted list
    const hashtags = Object.entries(counts)
      .map(([tag, count]) => ({ tag, score: count }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 200); // keep top 200

    // Save to Firestore
    const docRef = db.collection("trending").doc(countryCode.toLowerCase());
    await docRef.set({
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      hashtags,
      sourceUrl: url
    });

    console.log(`Saved ${hashtags.length} hashtags for ${countryCode}`);
  } catch (err) {
    console.error("Scrape error:", err);
  } finally {
    await browser.close();
  }
}

// Cron-style: run immediately then schedule
(async () => {
  await fetchTrendingForCountry("global");

  // schedule using node-cron (every N minutes)
  const minutes = Math.max(1, SCRAPE_INTERVAL_MIN);
  const cronExpr = `*/${minutes} * * * *`; // every N minutes
  console.log("Scheduling scrape every", minutes, "minutes:", cronExpr);
  cron.schedule(cronExpr, async () => {
    try {
      await fetchTrendingForCountry("global");
    } catch (err) {
      console.error("Scheduled scrape failed:", err);
    }
  });
})();
