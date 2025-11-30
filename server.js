import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import admin from "firebase-admin";
import { RateLimiterMemory } from "rate-limiter-flexible";
import sanitizeHtml from "sanitize-html";
import natural from "natural";
import fetch from "node-fetch"; // for RapidAPI requests
import fs from "fs";

const PORT = process.env.PORT || 8000;

// ---------------------------
// FIREBASE
// ---------------------------
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
// TRENDING HELPERS
// ---------------------------
async function getTrending(country = "US") {
  const docRef = db.collection("trending").doc(country.toUpperCase());
  const snap = await docRef.get();
  if (!snap.exists) return { updatedAt: null, hashtags: [] };
  return snap.data();
}

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
// RapidAPI TikTok trending function
// ---------------------------
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST; // e.g., tiktok-trending-hashtags.p.rapidapi.com

async function fetchTrendingFromAPI(country = "US") {
  const url = `https://${RAPIDAPI_HOST}/trending?country=${country}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-RapidAPI-Key": RAPIDAPI_KEY,
      "X-RapidAPI-Host": RAPIDAPI_HOST,
    },
  });
  const data = await res.json();
  return data.hashtags || [];
}

// ---------------------------
// ENDPOINTS
// ---------------------------

// GET /trending?country=XX
app.get("/trending", async (req, res) => {
  try {
    const country = (req.query.country || "US").toUpperCase();
    const data = await getTrending(country);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /generate { text, country, limit }
app.post("/generate", async (req, res) => {
  try {
    const { text = "", country = "US", limit = 12 } = req.body || {};
    if (!text || text.trim().length < 3)
      return res.status(400).json({ error: "Provide text" });

    const keywords = extractKeywords(text, 10);
    const trendDoc = await getTrending(country.toUpperCase());
    const trendList = (trendDoc.hashtags || []).map(h => h.toLowerCase());
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

// POST /scrape?country=XX
app.post("/scrape", async (req, res) => {
  try {
    const country = (req.query.country || "US").toUpperCase();
    const hashtags = await fetchTrendingFromAPI(country);

    const docRef = db.collection("trending").doc(country);
    await docRef.set({
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      hashtags,
      count: hashtags.length,
      source: "rapidapi",
    });

    res.json({ status: "success", country, hashtags });
  } catch (err) {
    console.error("❌ /scrape error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------
// START SERVER
// ---------------------------
app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
