import { db } from '../db/database';
import { decrypt_api_key } from './apiKeyCrypto';
import type { Response } from 'express';

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

function getAppSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value?.trim() || null;
}

function resolveGeminiApiKey(): string | null {
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey) return envKey;
  const setting = getAppSetting('gemini_api_key');
  const decrypted = decrypt_api_key(setting);
  return typeof decrypted === 'string' && decrypted.trim() ? decrypted.trim() : null;
}

function resolveGeminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || getAppSetting('gemini_model') || DEFAULT_GEMINI_MODEL;
}

function resolveGeminiBaseUrl(): string {
  return (process.env.GEMINI_API_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
}

export interface PlaceActivityContext {
  name: string;
  address?: string | null;
  description?: string | null;
  notes?: string | null;
  website?: string | null;
  phone?: string | null;
  rating?: number | null;
  opening_hours?: string[] | null;
  summary?: string | null;
  trip_language?: string;
}

/**
 * Streams an AI-generated activity plan for a place using Gemini via SSE.
 * Writes text chunks as `data: {"text":"..."}` SSE events to the Express response.
 * Sends `event: done` when complete or `event: error` on failure.
 */
export async function streamPlaceActivityPlan(
  context: PlaceActivityContext,
  res: Response
): Promise<void> {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Gemini API key is not configured. Set GEMINI_API_KEY on the server.' })}\n\n`);
    res.end();
    return;
  }

  const model = resolveGeminiModel();
  const endpoint = `${resolveGeminiBaseUrl()}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`;

  const lang = context.trip_language || 'en';

  const systemInstruction = [
    'You are a travel activity planning assistant embedded in the TREK travel app.',
    `Always respond in language: ${lang}.`,
    'Your task is to generate a concise, practical activity guide for a specific place.',
    'Format the response in Markdown with the following structure:',
    '1. A short introductory sentence about what makes this place special.',
    '2. ## Suggested Activities — 3–6 activities with emoji bullet points, a one-line description and an estimated time.',
    '3. ## Best Time to Visit — 1–2 sentences.',
    '4. ## Visitor Tips — 2–3 practical tips.',
    'Keep the tone friendly and helpful. Be concise. No generic filler text.',
  ].join('\n');

  const placeLines = [
    `Place name: ${context.name}`,
    context.address ? `Address: ${context.address}` : null,
    context.summary ? `Editorial summary: ${context.summary}` : null,
    context.description ? `Description: ${context.description}` : null,
    context.notes ? `Notes: ${context.notes}` : null,
    context.website ? `Website: ${context.website}` : null,
    context.rating != null ? `Rating: ${context.rating}/5` : null,
    context.opening_hours?.length
      ? `Opening hours:\n${context.opening_hours.map(h => `  ${h}`).join('\n')}`
      : null,
  ].filter(Boolean).join('\n');

  const userPrompt = `Create an activity plan for:\n\n${placeLines}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let geminiResponse: globalThis.Response;
  try {
    geminiResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.7 },
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : 'Request failed';
    res.write(`event: error\ndata: ${JSON.stringify({ message: `Gemini request failed: ${msg}` })}\n\n`);
    res.end();
    return;
  }

  if (!geminiResponse.ok) {
    clearTimeout(timeout);
    let errMsg = `HTTP ${geminiResponse.status}`;
    try {
      const errData = await geminiResponse.json() as Record<string, unknown>;
      errMsg = (errData?.error as { message?: string })?.message || errMsg;
    } catch { /* ignore */ }
    res.write(`event: error\ndata: ${JSON.stringify({ message: `Gemini API error: ${errMsg}` })}\n\n`);
    res.end();
    return;
  }

  const reader = geminiResponse.body?.getReader();
  if (!reader) {
    clearTimeout(timeout);
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'No response body from Gemini' })}\n\n`);
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let lineBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (!trimmed.startsWith('data:')) continue;

        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        try {
          const chunk = JSON.parse(jsonStr) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
          if (typeof text === 'string' && text.length > 0) {
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          }
        } catch {
          // skip malformed chunks
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Stream error';
    res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
  } finally {
    clearTimeout(timeout);
    reader.cancel().catch(() => {});
    res.write('event: done\ndata: {}\n\n');
    res.end();
  }
}
