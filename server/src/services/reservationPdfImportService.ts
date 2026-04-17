import { db } from '../db/database';
import { decrypt_api_key } from './apiKeyCrypto';

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const PDF_IMPORT_MODEL = 'gemini-3.1-pro-preview';

export interface ImportedReservation {
  title: string;
  type: string;
  reservation_time?: string | null;
  reservation_end_time?: string | null;
  location?: string | null;
  confirmation_number?: string | null;
  notes?: string | null;
  status?: 'pending' | 'confirmed';
  metadata?: Record<string, unknown> | null;
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

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : trimmed;
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
      if (ch === '"') inString = false;
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
      if (depth === 0 && start >= 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeIsoDateTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return v;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) return v.replace(' ', 'T');
  const parsed = Date.parse(v);
  if (Number.isNaN(parsed)) return null;
  const d = new Date(parsed);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseGeminiReservationImportResponse(rawText: string): ImportedReservation[] {
  const candidates = [rawText, stripCodeFences(rawText), extractFirstJsonObject(rawText)].filter((v): v is string => !!v);
  let parsed: any = null;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // try next candidate
    }
  }
  if (!parsed) return [];
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.reservations) ? parsed.reservations : [];
  const allowedTypes = new Set(['flight', 'hotel', 'restaurant', 'train', 'car', 'cruise', 'event', 'tour', 'other']);
  return rows
    .map((row: any): ImportedReservation | null => {
      const title = typeof row?.title === 'string' ? row.title.trim() : '';
      if (!title) return null;
      const typeRaw = typeof row?.type === 'string' ? row.type.trim().toLowerCase() : 'other';
      const type = allowedTypes.has(typeRaw) ? typeRaw : 'other';
      const status = row?.status === 'confirmed' ? 'confirmed' : 'pending';
      const reservation_time = normalizeIsoDateTime(row?.reservation_time ?? row?.date_time ?? row?.date);
      const reservation_end_time = normalizeIsoDateTime(row?.reservation_end_time ?? row?.end_time);
      const location = typeof row?.location === 'string' && row.location.trim() ? row.location.trim() : null;
      const confirmation_number = typeof row?.confirmation_number === 'string' && row.confirmation_number.trim() ? row.confirmation_number.trim() : null;
      const notes = typeof row?.notes === 'string' && row.notes.trim() ? row.notes.trim() : null;
      const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : null;
      return { title, type, status, reservation_time, reservation_end_time, location, confirmation_number, notes, metadata };
    })
    .filter((r): r is ImportedReservation => !!r);
}

export async function parseImportedReservationsFromPdf(pdfBuffer: Buffer): Promise<ImportedReservation[]> {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) throw new Error('Gemini API key not configured');

  const prompt = `You extract travel bookings from PDF tickets or confirmations.
Return JSON only with this shape:
{
  "reservations": [
    {
      "title": "short booking name",
      "type": "flight|hotel|restaurant|train|car|cruise|event|tour|other",
      "status": "pending|confirmed",
      "reservation_time": "YYYY-MM-DDTHH:mm",
      "reservation_end_time": "YYYY-MM-DDTHH:mm",
      "location": "city/airport/hotel",
      "confirmation_number": "PNR or booking code",
      "notes": "optional text",
      "metadata": {}
    }
  ]
}
Include only high-confidence bookings.`;

  const endpoint = `${resolveGeminiBaseUrl()}/v1beta/models/${encodeURIComponent(PDF_IMPORT_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
          ],
        },
      ],
      generationConfig: { temperature: 0.1 },
    }),
  });

  if (!response.ok) throw new Error(`Gemini request failed (${response.status})`);
  const data = await response.json();
  const rawText = (data?.candidates?.[0]?.content?.parts || [])
    .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
    .join('\n')
    .trim();
  if (!rawText) return [];
  return parseGeminiReservationImportResponse(rawText);
}
