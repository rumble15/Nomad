import { db } from '../db/database';
import { decrypt_api_key } from './apiKeyCrypto';

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const GEMINI_TEXT_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_VISUAL_MODEL = 'gemini-3.1-flash-image-preview';

export interface TripPdfInsights {
  summary: string | null;
  visualHighlights: string | null;
  models: {
    summary: string;
    visual: string;
  };
}

function getAppSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() || null;
}

function resolveGeminiApiKey(): string | null {
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey) return envKey;
  const decrypted = decrypt_api_key(getAppSetting('gemini_api_key'));
  return typeof decrypted === 'string' && decrypted.trim() ? decrypted.trim() : null;
}

function resolveGeminiBaseUrl(): string {
  return (process.env.GEMINI_API_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
}

async function generateText(apiKey: string, model: string, prompt: string): Promise<string | null> {
  const endpoint = `${resolveGeminiBaseUrl()}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 600 },
    }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
    .join('\n')
    .trim();
  return text || null;
}

export async function generateTripPdfInsights(tripSummary: unknown): Promise<TripPdfInsights> {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    return {
      summary: null,
      visualHighlights: null,
      models: { summary: GEMINI_TEXT_MODEL, visual: GEMINI_VISUAL_MODEL },
    };
  }

  const input = JSON.stringify(tripSummary ?? {}, null, 2);
  const summaryPrompt = `Create a concise premium trip overview for a PDF offline backup.
Use max 140 words, include key logistics (dates, cities, bookings) and practical highlights.
Plain text only.

Trip JSON:
${input}`;
  const visualPrompt = `Create a short "visual mood and photo checklist" for a premium trip PDF.
Use max 90 words and focus on image-worthy moments and memory cues.
Plain text only.

Trip JSON:
${input}`;

  const [summary, visualHighlights] = await Promise.all([
    generateText(apiKey, GEMINI_TEXT_MODEL, summaryPrompt),
    generateText(apiKey, GEMINI_VISUAL_MODEL, visualPrompt),
  ]);

  return {
    summary,
    visualHighlights,
    models: { summary: GEMINI_TEXT_MODEL, visual: GEMINI_VISUAL_MODEL },
  };
}
