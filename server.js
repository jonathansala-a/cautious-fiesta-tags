// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import admin from "firebase-admin";
import { RateLimiterMemory } from "rate-limiter-flexible";
import sanitizeHtml from "sanitize-html";
import natural from "natural";
import puppeteer from "puppeteer";
import fs from "fs";

const PORT = process.env.PORT || 8000;

// FIREBASE SERVICE ACCOUNT
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

// ---------------------------
// RATE LIMITER
// ---------------------------
const limiter = new RateLimiterMemory({
  points: parseInt(process.env.RATE_LIMIT_POINTS || "25"),
  duration: parseInt(process.env.RATE_LIMIT_DURATION || "60"),
});

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

app.use(async (req, res, next) => {
  try {
    await limiter.consume(req.ip);
    next();
  } catch (err) {
    res.status(429).json({ error: "Too many requests" });
  }
});

// ---------------------------
// TRENDING HASHTAGS HELPER
// ---------------------------
async function getTrending(country = "global") {
  const docRef = db.collection("trending").doc(country.toLowerCase());
  const snap = await docRef.get();
  if (!snap.exists) return { updatedAt: null, hashtags: [] };
  return snap.data();
}

// ---------------------------
// KEYWORD EXTRACTION
// ---------------------------
function extractKeywords(text, top = 10) {
  const clean = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const tokenizer = new natural.WordTokenizer();
  const tokens = tokenizer.tokenize(clean).filter(t => t.length > 2);
  const freq = {};
  tokens.forEach(t => (freq[t] = (freq[t] || 0) + 1));
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(x => x[0]);
}

// ---------------------------
// ENDPOINT: GET /trending
// ---------------------------
app.get("/trending", async (req, res) => {
  try {
    const country = (req.query.country || "global").toLowerCase();
    const data = await getTrending(country);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ---------------------------
// ENDPOINT: POST /generate
// ---------------------------
app.post("/generate", async (req, res) => {
  try {
    const { text = "", country = "global", limit = 12 } = req.body || {};
    if (!text || text.trim().length < 3)
      return res.status(400).json({ error: "Provide text" });

    const keywords = extractKeywords(text, 10);
    const trendDoc = await getTrending(country);
    const trendList = (trendDoc.hashtags || []).map(h => h.tag.toLowerCase());

    const candidates = new Set();

    keywords.forEach(k => {
      trendList.forEach(tag => {
        if (tag.includes(k)) candidates.add(tag.replace(/^#/, ""));
      });
    });

    keywords.forEach(k => {
      const base = k.replace(/\s+/g, "");
      candidates.add(base);
      candidates.add(`${base}tok`);
      candidates.add(`${base}tiktok`);
    });

    for (const t of trendList) {
      if (candidates.size >= limit) break;
      candidates.add(t.replace(/^#/, ""));
    }

    const final = Array.from(candidates)
      .slice(0, limit)
      .map(x => (x.startsWith("#") ? x : `#${x}`));

    res.json({
      generated: final,
      keywords,
      sourceUpdatedAt: trendDoc.updatedAt || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not generate hashtags" });
  }
});

// ---------------------------
// SCRAPER FUNCTION
// ---------------------------
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
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/118.0 Safari/537.36"
    );

    const url = "https://www.tiktok.com/discover";
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
    console.error("❌ SCRAPER ERROR:", err.message || err);
  } finally {
    await browser.close();
  }
}

// ---------------------------
// NEW ENDPOINT: POST /scrape
// ---------------------------
app.post("/scrape", async (req, res) => {
  try {
    await fetchTrendingForCountry("global");
    res.json({ status: "success", message: "Scrape completed" });
  } catch (err) {
    console.error("❌ /scrape error:", err);
    res.status(500).json({ error: err.message || "Scrape failed" });
  }
});

// ---------------------------
// START SERVER
// ---------------------------
app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
