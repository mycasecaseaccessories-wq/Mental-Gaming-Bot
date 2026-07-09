---
name: Gemini free-tier quota exhaustion
description: Bot AI answers/OCR silently degrade when AI_API_KEY hits free-tier 429 — check logs before debugging code
---
The bot's AI features (support answers, ambient replies, game-news image OCR, sentiment) all go through Gemini via AI_API_KEY. When the key's free tier is exhausted, the API returns 429 with "limit: 0" and every AI feature stops answering — this looks like a code bug but is not.
**Why:** On 2026-07-09 the user reported the game-news AI "doesn't work"; the real cause was `[AIService] Gemini 429 ... free_tier ... limit: 0` in workflow logs.
**How to apply:** When any AI-driven bot feature "stops working", grep the Telegram Bot workflow log for `Gemini 429` first. Fix = user enables billing or supplies a fresh key; code paths are built to degrade gracefully (return null / skip OCR).
