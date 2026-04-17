import { db } from '../db/database';
import { decrypt_api_key } from './apiKeyCrypto';

const DEFAULT_GEMINI_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const MAX_ACTIONS = 8;

export interface TripSearchHit {
  path: string;
  value: string;
}

export type GeminiPlannedAction =
  | {
      type: 'create_note';
      title: string;
      content: string;
      category?: string;
      color?: string;
    }
  | {
      type: 'create_todo';
      name: string;
      category?: string;
      description?: string;
      priority?: number;
    }
  | {
      type: 'search_trip';
      query: string;
      max_results?: number;
    }
  | {
      type: 'maps_search';
      query: string;
      max_results?: number;
    };

export interface GeminiExecutionPlan {
  model: string;
  assistantMessage: string;
  actions: GeminiPlannedAction[];
  warnings: string[];
  rawText: string;
}

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

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function cleanText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 3)}...` : trimmed;
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function parseAction(raw: unknown, warnings: string[]): GeminiPlannedAction | null {
  if (!raw || typeof raw !== 'object') {
    warnings.push('Dropped invalid action entry (not an object).');
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const type = cleanText(obj.type, 40).toLowerCase();

  if (type === 'create_note') {
    const title = cleanText(obj.title, 140);
    const content = cleanText(obj.content, 6000);
    if (!title || !content) {
      warnings.push('Dropped create_note action with missing title/content.');
      return null;
    }
    const category = cleanText(obj.category, 80) || 'Gemini';
    const color = cleanText(obj.color, 20) || '#2563eb';
    return { type: 'create_note', title, content, category, color };
  }

  if (type === 'create_todo') {
    const name = cleanText(obj.name, 180);
    if (!name) {
      warnings.push('Dropped create_todo action with missing name.');
      return null;
    }
    const category = cleanText(obj.category, 80) || 'Gemini';
    const description = cleanText(obj.description, 3000) || '';
    const priority = clampInt(obj.priority, 0, 5, 1);
    return { type: 'create_todo', name, category, description, priority };
  }

  if (type === 'search_trip') {
    const query = cleanText(obj.query, 200);
    if (!query) {
      warnings.push('Dropped search_trip action with missing query.');
      return null;
    }
    const max_results = clampInt(obj.max_results, 1, 30, 10);
    return { type: 'search_trip', query, max_results };
  }

  if (type === 'maps_search') {
    const query = cleanText(obj.query, 200);
    if (!query) {
      warnings.push('Dropped maps_search action with missing query.');
      return null;
    }
    const max_results = clampInt(obj.max_results, 1, 10, 5);
    return { type: 'maps_search', query, max_results };
  }

  warnings.push(`Dropped unsupported action type: ${type || 'unknown'}.`);
  return null;
}

function extractTextFromGeminiResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const candidate = (payload as Record<string, unknown>).candidates;
  if (!Array.isArray(candidate) || candidate.length === 0) return '';

  const first = candidate[0] as Record<string, unknown>;
  const content = first?.content as Record<string, unknown> | undefined;
  const parts = content?.parts;
  if (!Array.isArray(parts)) return '';

  return parts
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const text = (part as Record<string, unknown>).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function coercePlan(rawText: string, model: string): GeminiExecutionPlan {
  const warnings: string[] = [];
  const cleaned = stripCodeFences(rawText);

  let parsed: Record<string, unknown>;
  try {
    const json = JSON.parse(cleaned) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new Error('JSON root must be an object');
    }
    parsed = json as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error('Gemini returned invalid JSON payload.'), { status: 502 });
  }

  const assistantMessage = cleanText(parsed.assistant_message, 5000) ||
    cleanText(parsed.summary, 5000) ||
    'Execution plan created.';

  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions: GeminiPlannedAction[] = [];
  for (const item of rawActions.slice(0, MAX_ACTIONS)) {
    const action = parseAction(item, warnings);
    if (action) actions.push(action);
  }

  return {
    model,
    assistantMessage,
    actions,
    warnings,
    rawText,
  };
}

interface GeneratePlanInput {
  sourceMessage: string;
  sourceAuthor: string;
  instruction?: string;
  tripContext: unknown;
}

export async function generateGeminiExecutionPlan(input: GeneratePlanInput): Promise<GeminiExecutionPlan> {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    throw Object.assign(
      new Error('Gemini API key is not configured. Set GEMINI_API_KEY on the server.'),
      { status: 503 }
    );
  }

  const model = resolveGeminiModel();
  const endpoint = `${resolveGeminiBaseUrl()}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const systemInstruction = [
    'You are Gemini, an autonomous travel planning co-worker inside TREK.',
    'Return ONLY valid JSON (no markdown, no code fences).',
    'Schema:',
    '{"assistant_message":"string","actions":[action,...]}',
    'Allowed action types:',
    '1) {"type":"create_note","title":"string","content":"string","category":"string?","color":"#RRGGBB?"}',
    '2) {"type":"create_todo","name":"string","category":"string?","description":"string?","priority":0..5?}',
    '3) {"type":"search_trip","query":"string","max_results":1..30?}',
    '4) {"type":"maps_search","query":"string","max_results":1..10?}',
    'Rules:',
    '- Max 8 actions.',
    '- Prefer concise, concrete tasks.',
    '- If user asks to implement an idea, include at least one create_note or create_todo action.',
    '- Keep assistant_message practical and short.',
  ].join('\n');

  const userPrompt = [
    'Source chat message to execute:',
    `Author: ${input.sourceAuthor}`,
    input.sourceMessage,
    input.instruction ? `Additional instruction: ${input.instruction}` : null,
    '',
    'Trip context JSON:',
    JSON.stringify(input.tripContext),
  ].filter(Boolean).join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Request failed';
    throw Object.assign(new Error(`Gemini request failed: ${msg}`), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const errObj = payload?.error as Record<string, unknown> | undefined;
    const message = typeof errObj?.message === 'string' ? errObj.message : `HTTP ${response.status}`;
    throw Object.assign(new Error(`Gemini API error: ${message}`), { status: response.status });
  }

  const rawText = extractTextFromGeminiResponse(payload);
  if (!rawText) {
    throw Object.assign(new Error('Gemini returned no text output.'), { status: 502 });
  }

  return coercePlan(rawText, model);
}

function collectTripSearchHits(
  value: unknown,
  queryLower: string,
  path: string,
  hits: TripSearchHit[],
  maxResults: number
): void {
  if (hits.length >= maxResults || value === null || value === undefined) return;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const preview = String(value);
    if (preview.toLowerCase().includes(queryLower)) {
      hits.push({
        path,
        value: preview.length > 240 ? `${preview.slice(0, 237)}...` : preview,
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && hits.length < maxResults; i += 1) {
      collectTripSearchHits(value[i], queryLower, `${path}[${i}]`, hits, maxResults);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (hits.length >= maxResults) break;
      collectTripSearchHits(nested, queryLower, `${path}.${key}`, hits, maxResults);
    }
  }
}

export function searchTripSummary(summary: unknown, query: string, maxResults = 10): TripSearchHit[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed || !summary) return [];
  const capped = clampInt(maxResults, 1, 50, 10);
  const hits: TripSearchHit[] = [];
  collectTripSearchHits(summary, trimmed, 'summary', hits, capped);
  return hits;
}
