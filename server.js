// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import admin from "firebase-admin";
import { RateLimiterMemory } from "rate-limiter-flexible";   // FIXED
import sanitizeHtml from "sanitize-html";
import natural from "natural";
import * as fs from "fs";                                     // FIXED

const PORT = process.env.PORT || 8000;

// Setup service account credentials from env (if SERVICE_ACCOUNT_JSON provided)
if (process.env.SERVICE_ACCOUNT_JSON) {
  const tmpPath = "/tmp/service-account.json";
  fs.writeFileSync(tmpPath, process.env.SERVICE_ACCOUNT_JSON);   // FIXED
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
}

// Firebase init
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

// App
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// Rate limiter (safe import)
const limiter = new RateLimiterMemory({
  points: parseInt(process.env.RATE_LIMIT_POINTS || "25"),
  duration: parseInt(process.env.RATE_LIMIT_DURATION || "60"),
});

// Global rate limit middleware
app.use(async (req, res, next) => {
  try {
    await limiter.consume(req.ip);
    next();
  } catch (err) {
    res.status(429).json({ error: "Too many requests" });
  }
});

// Get trending hashtags by country
async function getTrending(country = "global") {
  const docRef = db.collection("trending").doc(country.toLowerCase());
  const snap = await docRef.get();
  if (!snap.exists) return { updatedAt: null, hashtags: [] };
  return snap.data();
}

// GET /trending?country=US
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

// Extract top keywords
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

// POST /generate
app.post("/generate", async (req, res) => {
  try {
    const { text = "", country = "global", limit = 12 } = req.body || {};
    if (!text || text.trim().length < 3)
      return res.status(400).json({ error: "Provide text" });

    const keywords = extractKeywords(text, 10);
    const trendDoc = await getTrending(country);
    const trendList = (trendDoc.hashtags || []).map(h => h.tag.toLowerCase());

    const candidates = new Set();

    // 1. Match keywords to trending
    keywords.forEach(k => {
      trendList.forEach(tag => {
        if (tag.includes(k)) candidates.add(tag.replace(/^#/, ""));
      });
    });

    // 2. Add keyword variations
    keywords.forEach(k => {
      const base = k.replace(/\s+/g, "");
      candidates.add(base);
      candidates.add(`${base}tok`);
      candidates.add(`${base}tiktok`);
    });

    // 3. Add top trending until limit
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

app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});
