// server.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import admin from "firebase-admin";
import rateLimitFlexible from "rate-limiter-flexible";
import sanitizeHtml from "sanitize-html";
import natural from "natural";

const PORT = process.env.PORT || 8000;

// Setup service account credentials from env (if SERVICE_ACCOUNT_JSON provided)
if (process.env.SERVICE_ACCOUNT_JSON) {
  const tmpPath = "/tmp/service-account.json";
  import fs from "fs";
  fs.writeFileSync(tmpPath, process.env.SERVICE_ACCOUNT_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
}

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// Simple rate limiter (rate-limiter-flexible)
const { RateLimiterMemory } = rateLimitFlexible;
const limiter = new RateLimiterMemory({
  points: parseInt(process.env.RATE_LIMIT_POINTS || "25"),
  duration: parseInt(process.env.RATE_LIMIT_DURATION || "60"), // seconds
});

app.use(async (req, res, next) => {
  try {
    await limiter.consume(req.ip);
    next();
  } catch (err) {
    res.status(429).json({ error: "Too many requests" });
  }
});

// Helper: get trending hashtags for a country (or global)
async function getTrending(country = "global") {
  const docRef = db.collection("trending").doc(country.toLowerCase());
  const snap = await docRef.get();
  if (!snap.exists) return { updatedAt: null, hashtags: [] };
  return snap.data();
}

// Endpoint: GET /trending?country=US
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

// Basic keyword extraction: return top nouns/words from text
function extractKeywords(text, top = 10) {
  // sanitize and basic tokenization
  const clean = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim().toLowerCase();
  const tokenizer = new natural.WordTokenizer();
  const tokens = tokenizer.tokenize(clean).filter(t => t.length > 2);
  // frequency count
  const freq = {};
  tokens.forEach(t => { freq[t] = (freq[t] || 0) + 1; });
  const sorted = Object.entries(freq).sort((a,b)=> b[1]-a[1]).slice(0, top).map(x => x[0]);
  return sorted;
}

// Endpoint: POST /generate
// body: { text: "...", country: "US", limit: 10 }
app.post("/generate", async (req, res) => {
  try {
    const { text = "", country = "global", limit = 12 } = req.body || {};
    if (!text || text.trim().length < 3) return res.status(400).json({ error: "Provide text" });

    const keywords = extractKeywords(text, 10);
    const trendDoc = await getTrending(country);
    const trendList = (trendDoc.hashtags || []).map(h => h.tag.toLowerCase());

    // Build candidate hashtags:
    const candidates = new Set();

    // 1) match keywords to trending tags (contains)
    keywords.forEach(k => {
      trendList.forEach(tag => {
        if (tag.includes(k)) candidates.add(tag.replace(/^#/, ""));
      });
    });

    // 2) direct keyword -> hashtag variations
    keywords.forEach(k => {
      candidates.add(k.replace(/\s+/g, ""));
      candidates.add(`${k}tok`);
      candidates.add(`${k}tiktok`);
    });

    // 3) add top trending if still short
    for (const t of trendList) {
      if (candidates.size >= limit) break;
      candidates.add(t.replace(/^#/, ""));
    }

    // create final array prefixed with #
    const final = Array.from(candidates).slice(0, limit).map(x => (x.startsWith("#") ? x : `#${x}`));

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
