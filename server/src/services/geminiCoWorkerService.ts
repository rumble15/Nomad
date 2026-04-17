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
      type: 'create_packing_item';
      name: string;
      category?: string;
      quantity?: number;
      checked?: boolean;
    }
  | {
      type: 'create_todo';
      name: string;
      category?: string;
      description?: string;
      priority?: number;
    }
  | {
      type: 'create_budget_item';
      name: string;
      category?: string;
      total_price?: number;
      persons?: number;
      days?: number;
      note?: string;
      expense_date?: string;
    }
  | {
      type: 'create_place';
      name?: string;
      query?: string;
      selected_index?: number;
      address?: string;
      lat?: number;
      lng?: number;
      notes?: string;
      place_time?: string;
      end_time?: string;
      day_id?: number;
      day_number?: number;
      google_place_id?: string;
      osm_id?: string;
      website?: string;
      phone?: string;
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
    }
  | {
      type: 'web_search';
      query: string;
      max_results?: number;
    };

export interface GeminiExecutionPlan {
  model: string;
  assistantMessage: string;
  needsClarification: boolean;
  clarifyingQuestions: string[];
  thinking: string[];
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

function parseFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

function parseStringList(value: unknown, maxItems: number, maxLen: number): string[] {
  const items = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/\r?\n+/g) : []);

  return items
    .map((item) => cleanText(item, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function extractFirstJsonObject(raw: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === '\\') {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return raw.slice(start, i + 1);
      }
    }
  }

  return null;
}

function collectJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (value: string | null | undefined) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  pushCandidate(raw);
  pushCandidate(stripCodeFences(raw));

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(raw)) !== null) {
    pushCandidate(match[1]);
  }

  pushCandidate(extractFirstJsonObject(raw));

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    pushCandidate(raw.slice(firstBrace, lastBrace + 1));
  }

  return candidates;
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

  if (type === 'create_packing_item') {
    const name = cleanText(obj.name, 180);
    if (!name) {
      warnings.push('Dropped create_packing_item action with missing name.');
      return null;
    }

    const category = cleanText(obj.category, 80) || 'Gemini';
    const quantityRaw = parseFiniteNumber(obj.quantity);
    const checked = obj.checked === true
      || ['1', 'true', 'yes', 'ja'].includes(String(obj.checked || '').trim().toLowerCase());

    return {
      type: 'create_packing_item',
      name,
      category,
      quantity: quantityRaw !== null ? clampInt(Math.round(quantityRaw), 1, 999, 1) : undefined,
      checked: obj.checked !== undefined ? checked : undefined,
    };
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

  if (type === 'create_budget_item') {
    const name = cleanText(obj.name, 180);
    if (!name) {
      warnings.push('Dropped create_budget_item action with missing name.');
      return null;
    }

    const category = cleanText(obj.category, 80) || 'Other';
    const totalPriceRaw = parseFiniteNumber(obj.total_price);
    const total_price = totalPriceRaw !== null ? Math.max(0, Number(totalPriceRaw.toFixed(2))) : 0;
    const personsRaw = parseFiniteNumber(obj.persons);
    const daysRaw = parseFiniteNumber(obj.days);
    const note = cleanText(obj.note, 2000) || undefined;
    const expenseDateCandidate = cleanText(obj.expense_date, 20);
    const expense_date = /^\d{4}-\d{2}-\d{2}$/.test(expenseDateCandidate) ? expenseDateCandidate : undefined;

    return {
      type: 'create_budget_item',
      name,
      category,
      total_price,
      persons: personsRaw !== null ? clampInt(Math.round(personsRaw), 1, 100, 1) : undefined,
      days: daysRaw !== null ? clampInt(Math.round(daysRaw), 1, 365, 1) : undefined,
      note,
      expense_date,
    };
  }

  if (type === 'create_place') {
    const name = cleanText(obj.name, 200);
    const query = cleanText(obj.query, 220);
    const address = cleanText(obj.address, 500) || undefined;
    const notes = cleanText(obj.notes, 2000) || undefined;
    const place_time = cleanText(obj.place_time, 10) || undefined;
    const end_time = cleanText(obj.end_time, 10) || undefined;
    const google_place_id = cleanText(obj.google_place_id, 180) || undefined;
    const osm_id = cleanText(obj.osm_id, 120) || undefined;
    const website = cleanText(obj.website, 400) || undefined;
    const phone = cleanText(obj.phone, 80) || undefined;
    const lat = parseFiniteNumber(obj.lat) ?? undefined;
    const lng = parseFiniteNumber(obj.lng) ?? undefined;

    if (!name && !query) {
      warnings.push('Dropped create_place action with missing name/query.');
      return null;
    }
    if (!query && (lat === undefined || lng === undefined)) {
      warnings.push('Dropped create_place action without coordinates or query.');
      return null;
    }

    const selected_index = clampInt(obj.selected_index, 0, 9, 0);
    const day_id_raw = parseFiniteNumber(obj.day_id);
    const day_number_raw = parseFiniteNumber(obj.day_number);

    return {
      type: 'create_place',
      name: name || undefined,
      query: query || undefined,
      selected_index,
      address,
      lat,
      lng,
      notes,
      place_time,
      end_time,
      day_id: day_id_raw !== null ? clampInt(Math.round(day_id_raw), 1, 99999999, 1) : undefined,
      day_number: day_number_raw !== null ? clampInt(Math.round(day_number_raw), 1, 365, 1) : undefined,
      google_place_id,
      osm_id,
      website,
      phone,
    };
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

  if (type === 'web_search') {
    const query = cleanText(obj.query, 220);
    if (!query) {
      warnings.push('Dropped web_search action with missing query.');
      return null;
    }
    const max_results = clampInt(obj.max_results, 1, 8, 5);
    return { type: 'web_search', query, max_results };
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
  const jsonCandidates = collectJsonCandidates(rawText);

  let parsed: Record<string, unknown> | null = null;
  for (const candidate of jsonCandidates) {
    try {
      const json = JSON.parse(candidate) as unknown;
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        parsed = json as Record<string, unknown>;
        break;
      }
      if (Array.isArray(json)) {
        const first = json[0] as unknown;
        if (first && typeof first === 'object' && !Array.isArray(first)) {
          parsed = first as Record<string, unknown>;
          warnings.push('Gemini returned array root; used first object as execution plan.');
          break;
        }
      }
    } catch {
      // Try next candidate.
    }
  }

  if (!parsed) {
    return {
      model,
      assistantMessage: 'I could not parse the model output into executable JSON yet. Please confirm the exact action in one short sentence.',
      needsClarification: true,
      clarifyingQuestions: ['What is the one concrete action I should execute now?'],
      thinking: ['Model output was not valid strict JSON.'],
      actions: [],
      warnings: ['Gemini returned non-JSON output; skipped execution actions.'],
      rawText,
    };
  }

  const assistantMessage = cleanText(parsed.assistant_message, 5000) ||
    cleanText(parsed.summary, 5000) ||
    'Execution plan created.';

  const thinking = parseStringList(
    parsed.thinking ?? parsed.thoughts ?? parsed.reasoning,
    4,
    220
  );

  const clarifyingQuestions = parseStringList(
    parsed.clarifying_questions ?? parsed.questions ?? parsed.follow_up_questions,
    4,
    220
  );

  const needsClarification = parsed.needs_clarification === true || clarifyingQuestions.length > 0;

  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions: GeminiPlannedAction[] = [];
  for (const item of rawActions.slice(0, MAX_ACTIONS)) {
    const action = parseAction(item, warnings);
    if (action) actions.push(action);
  }

  if (needsClarification && actions.length > 0) {
    warnings.push('Dropped execution actions because clarification is required first.');
    actions.length = 0;
  }

  return {
    model,
    assistantMessage,
    needsClarification,
    clarifyingQuestions,
    thinking,
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
    'Think internally first, then output strict JSON only.',
    'Return ONLY valid JSON (no markdown, no code fences).',
    'Schema:',
    '{"assistant_message":"string","needs_clarification":boolean,"clarifying_questions":["string"],"thinking":["string"],"actions":[action,...]}',
    'Allowed action types:',
    '1) {"type":"create_note","title":"string","content":"string","category":"string?","color":"#RRGGBB?"}',
    '2) {"type":"create_packing_item","name":"string","category":"string?","quantity":number?,"checked":boolean?}',
    '3) {"type":"create_todo","name":"string","category":"string?","description":"string?","priority":0..5?}',
    '4) {"type":"create_budget_item","name":"string","category":"string?","total_price":number?,"persons":number?,"days":number?,"note":"string?","expense_date":"YYYY-MM-DD?"}',
    '5) {"type":"create_place","name":"string?","query":"string?","selected_index":0..9?,"address":"string?","lat":number?,"lng":number?,"notes":"string?","place_time":"HH:mm?","end_time":"HH:mm?","day_id":number?,"day_number":number?,"google_place_id":"string?","osm_id":"string?","website":"string?","phone":"string?"}',
    '6) {"type":"search_trip","query":"string","max_results":1..30?}',
    '7) {"type":"maps_search","query":"string","max_results":1..10?}',
    '8) {"type":"web_search","query":"string","max_results":1..8?}',
    'Rules:',
    '- Max 8 actions.',
    '- Use active day and recent chat context when available.',
    '- Respect tripContext.capabilities; do not emit actions whose capability is false.',
    '- Keep thinking to max 4 concise bullets for transparency.',
    '- If required details are missing, set needs_clarification=true, add 1-3 specific clarifying_questions, and keep actions empty.',
    '- Prefer concise, concrete tasks.',
    '- If user asks to implement or create something, include at least one write action (create_note/create_packing_item/create_todo/create_place/create_budget_item).',
    '- If user asks to search/research/find options, you may return search actions only (search_trip/maps_search/web_search).',
    '- If user asks for packing list changes, prefer create_packing_item (not create_todo).',
    '- If user asks to add expenses or plan costs in budget, prefer create_budget_item (not reminder todos).',
    '- You may use the built-in urlContext tool to open and read relevant websites when the user references URLs or web sources.',
    '- If external web context is needed for accuracy, use urlContext first, then decide actions or clarification.',
    '- If user asks to add a place to the map, include create_place with either lat/lng or query.',
    '- Keep assistant_message practical and short in the user language.',
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
        tools: [{ urlContext: {} }],
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
