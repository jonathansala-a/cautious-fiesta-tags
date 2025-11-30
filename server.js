// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import admin from "firebase-admin";
import { RateLimiterMemory } from "rate-limiter-flexible";
import sanitizeHtml from "sanitize-html";
import natural from "natural";
import fetch from "node-fetch";

const PORT = process.env.PORT || 8000;

// ---------------------------
// FIREBASE
// ---------------------------
if (process.env.SERVICE_ACCOUNT_JSON) {
  const fs = await import("fs");
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

// ---------------------------
// RATE LIMITER
// ---------------------------
const limiter = new RateLimiterMemory({
  points: parseInt(process.env.RATE_LIMIT_POINTS || "25"),
  duration: parseInt(process.env.RATE_LIMIT_DURATION || "60"),
});

// ---------------------------
// APP SETUP
// ---------------------------
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
// COUNTRY → PLACEID (RapidAPI mapping)
// ---------------------------
const COUNTRY_PLACE_IDS = {
  global: "22535796481538024",
  US: "22535796481538024",
  JP: "22535796481538025",
  IN: "22535796481538026",
  // add more countries as needed
};

// ---------------------------
// TRENDING HASHTAGS SCRAPER
// ---------------------------
async function fetchTrendingHashtags(country = "global") {
  const placeId = COUNTRY_PLACE_IDS[country] || COUNTRY_PLACE_IDS.global;

  const url = `https://${process.env.RAPIDAPI_HOST}/place-posts?placeId=${placeId}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
        "X-RapidAPI-Host": process.env.RAPIDAPI_HOST,
      },
    });
    const data = await response.json();

    // Extract hashtags from posts
    const hashtagsMap = {};
    if (data.posts && Array.isArray(data.posts)) {
      data.posts.forEach(post => {
        const text = post.description || "";
        const matches = text.match(/#([A-Za-z0-9_]+)/g) || [];
        matches.forEach(tag => {
          const key = tag.toLowerCase();
          hashtagsMap[key] = (hashtagsMap[key] || 0) + 1;
        });
      });
    }

    // Convert to sorted array
    const hashtags = Object.entries(hashtagsMap)
      .map(([tag, score]) => ({ tag, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 150);

    // Save to Firestore
    const docRef = db.collection("trending").doc(country);
    await docRef.set({
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      hashtags,
      source: "rapidapi",
      count: hashtags.length,
      placeId,
    });

    console.log(`✅ Saved ${hashtags.length} hashtags for ${country}`);
    return hashtags;
  } catch (err) {
    console.error(`❌ Failed to fetch hashtags for ${country}:`, err.message || err);
    return [];
  }
}

// ---------------------------
// GET TRENDING HASHTAGS
// ---------------------------
async function getTrending(country = "global") {
  const docRef = db.collection("trending").doc(country.toLowerCase());
  const snap = await docRef.get();
  if (!snap.exists) return { updatedAt: null, hashtags: [] };
  return snap.data();
}

// ---------------------------
// EXTRACT KEYWORDS FROM USER TEXT
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
// ENDPOINTS
// ---------------------------

// GET /trending?country=XX
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

// POST /scrape?country=XX
app.post("/scrape", async (req, res) => {
  try {
    const country = (req.query.country || "global").toLowerCase();
    const hashtags = await fetchTrendingHashtags(country);
    res.json({ status: "success", country, hashtags });
  } catch (err) {
    console.error("❌ /scrape error:", err);
    res.status(500).json({ error: err.message || "Scrape failed" });
  }
});

// POST /generate { text, country, limit }
app.post("/generate", async (req, res) => {
  try {
    const { text = "", country = "global", limit = 12 } = req.body || {};
    if (!text || text.trim().length < 3)
      return res.status(400).json({ error: "Provide text" });

    const keywords = extractKeywords(text, 10);
    const trendDoc = await getTrending(country.toLowerCase());
    const trendList = (trendDoc.hashtags || []).map(h => h.tag.toLowerCase());
    const candidates = new Set();

    // match keywords with trending hashtags
    keywords.forEach(k => {
      trendList.forEach(tag => {
        if (tag.includes(k)) candidates.add(tag.replace(/^#/, ""));
      });
    });

    // add keyword variations
    keywords.forEach(k => {
      const base = k.replace(/\s+/g, "");
      candidates.add(base);
      candidates.add(`${base}tok`);
      candidates.add(`${base}tiktok`);
    });

    // fill with trending if not enough
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
// AUTO UPDATE TRENDING (cron)
// ---------------------------
import cron from "node-cron";
const SCRAPE_INTERVAL_MIN = parseInt(process.env.SCRAPE_INTERVAL_MIN || "60");

cron.schedule(`*/${SCRAPE_INTERVAL_MIN} * * * *`, async () => {
  console.log(`⏱ Auto-scraping every ${SCRAPE_INTERVAL_MIN} minutes`);
  for (const country of Object.keys(COUNTRY_PLACE_IDS)) {
    try {
      await fetchTrendingHashtags(country);
    } catch (err) {
      console.error(`❌ Auto-scrape failed for ${country}:`, err.message || err);
    }
  }
});

// ---------------------------
// START SERVER
// ---------------------------
app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
