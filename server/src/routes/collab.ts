import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { validateStringLengths } from '../middleware/validate';
import { checkPermission } from '../services/permissions';
import { AuthRequest } from '../types';
import { db } from '../db/database';
import {
  verifyTripAccess,
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  addNoteFile,
  getFormattedNoteById,
  deleteNoteFile,
  listPolls,
  createPoll,
  votePoll,
  closePoll,
  deletePoll,
  listMessages,
  createMessage,
  getMessageById,
  encodeGeminiBotText,
  deleteMessage,
  addOrRemoveReaction,
  fetchLinkPreview,
} from '../services/collabService';
import { getTripSummary } from '../services/tripService';
import { createItem as createTodoItem } from '../services/todoService';
import { createItem as createPackingItem } from '../services/packingService';
import { createBudgetItem } from '../services/budgetService';
import { searchPlaces } from '../services/mapsService';
import { generateGeminiExecutionPlan, searchTripSummary } from '../services/geminiCoWorkerService';
import { createPlace } from '../services/placeService';
import { createAssignment } from '../services/assignmentService';
import { writeAudit, getClientIp } from '../services/auditLog';
import {
  classifyGeminiRisk,
  normalizeGeminiExecutionMode,
  normalizeGeminiActionStatus,
  persistGeminiExecution,
  type GeminiExecutionActionRecord,
} from '../services/geminiExecutionService';

const MAX_NOTE_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const filesDir = path.join(__dirname, '../../uploads/files');
const noteUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true }); cb(null, filesDir) },
    filename: (_req, file, cb) => { cb(null, `${uuidv4()}${path.extname(file.originalname)}`) },
  }),
  limits: { fileSize: MAX_NOTE_FILE_SIZE },
  defParamCharset: 'utf8',
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const BLOCKED = ['.svg', '.html', '.htm', '.xml', '.xhtml', '.js', '.jsx', '.ts', '.exe', '.bat', '.sh', '.cmd', '.msi', '.dll', '.com', '.vbs', '.ps1', '.php'];
    if (BLOCKED.includes(ext) || file.mimetype.includes('svg') || file.mimetype.includes('html') || file.mimetype.includes('javascript')) {
      const err: Error & { statusCode?: number } = new Error('File type not allowed');
      err.statusCode = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

const router = express.Router({ mergeParams: true });

function shortenText(value: unknown, maxLen = 160): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string | null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function addWebSearchResult(
  bucket: WebSearchResult[],
  seenUrls: Set<string>,
  titleRaw: unknown,
  urlRaw: unknown,
  snippetRaw: unknown,
  maxResults: number
): void {
  if (bucket.length >= maxResults) return;

  const url = shortenText(urlRaw, 800);
  if (!url || !/^https?:\/\//i.test(url) || seenUrls.has(url)) return;

  const titleSource = shortenText(titleRaw, 220);
  const snippetSource = shortenText(snippetRaw, 320);
  const title = decodeHtmlEntities(titleSource || snippetSource || url);
  const snippet = decodeHtmlEntities(snippetSource || '').trim() || null;

  seenUrls.add(url);
  bucket.push({ title, url, snippet });
}

function addDuckDuckGoTopics(
  topicsRaw: unknown,
  bucket: WebSearchResult[],
  seenUrls: Set<string>,
  maxResults: number
): void {
  if (bucket.length >= maxResults || !Array.isArray(topicsRaw)) return;

  for (const topic of topicsRaw) {
    if (bucket.length >= maxResults || !topic || typeof topic !== 'object') break;
    const row = topic as Record<string, unknown>;

    if (Array.isArray(row.Topics)) {
      addDuckDuckGoTopics(row.Topics, bucket, seenUrls, maxResults);
      continue;
    }

    const text = shortenText(row.Text, 320);
    const splitAt = text.indexOf(' - ');
    const topicTitle = splitAt > 0 ? text.slice(0, splitAt) : text;
    const topicSnippet = splitAt > 0 ? text.slice(splitAt + 3) : text;
    addWebSearchResult(bucket, seenUrls, topicTitle, row.FirstURL, topicSnippet, maxResults);
  }
}

async function runWebSearch(query: string, maxResults = 5): Promise<WebSearchResult[]> {
  const q = shortenText(query, 220);
  if (!q) return [];

  const capped = Math.max(1, Math.min(8, Math.trunc(maxResults || 5)));
  const endpoint = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TREK/1.0',
      },
      signal: controller.signal,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Request failed';
    throw new Error(`Web search request failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Web search failed (HTTP ${response.status}).`);
  }

  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload || typeof payload !== 'object') return [];

  const results: WebSearchResult[] = [];
  const seenUrls = new Set<string>();

  addWebSearchResult(results, seenUrls, payload.Heading, payload.AbstractURL, payload.AbstractText, capped);

  const direct = Array.isArray(payload.Results) ? payload.Results : [];
  for (const entry of direct) {
    if (results.length >= capped || !entry || typeof entry !== 'object') break;
    const row = entry as Record<string, unknown>;
    addWebSearchResult(results, seenUrls, row.Text, row.FirstURL, row.Text, capped);
  }

  addDuckDuckGoTopics(payload.RelatedTopics, results, seenUrls, capped);
  return results;
}

interface BuildGeminiContextOptions {
  activeDayId?: number | null;
  recentChat?: Record<string, unknown>[];
  sourceMessageId?: number;
}

function buildGeminiTripContext(summary: unknown, options?: BuildGeminiContextOptions): Record<string, unknown> | null {
  if (!summary || typeof summary !== 'object') return null;
  const src = summary as Record<string, unknown>;

  const trip = (src.trip || {}) as Record<string, unknown>;
  const daysRaw = Array.isArray(src.days) ? src.days : [];
  const reservationsRaw = Array.isArray(src.reservations) ? src.reservations : [];
  const collabNotesRaw = Array.isArray(src.collab_notes) ? src.collab_notes : [];

  const days = daysRaw.slice(0, 14).map((d) => {
    const day = d as Record<string, unknown>;
    const assignments = Array.isArray(day.assignments) ? day.assignments : [];
    return {
      id: day.id,
      day_number: day.day_number,
      date: day.date,
      title: day.title,
      assignment_count: assignments.length,
      assignments: assignments.slice(0, 12).map((a) => {
        const item = a as Record<string, unknown>;
        const place = (item.place || {}) as Record<string, unknown>;
        return {
          assignment_id: item.id,
          place_id: place.id || item.place_id || null,
          title: place.name || item.place_name || item.name || null,
          time: item.assignment_time || place.place_time || item.place_time || item.time || null,
          end_time: item.assignment_end_time || place.end_time || item.end_time || null,
          notes: shortenText(item.notes || place.notes, 220),
          address: place.address || item.address || null,
          lat: place.lat ?? item.lat ?? null,
          lng: place.lng ?? item.lng ?? null,
          google_place_id: place.google_place_id || item.google_place_id || null,
          osm_id: place.osm_id || item.osm_id || null,
        };
      }),
    };
  });

  let activeDay = null as Record<string, unknown> | null;
  if (options?.activeDayId) {
    activeDay = days.find((day) => Number((day as Record<string, unknown>).id) === Number(options.activeDayId)) || null;
  }
  if (!activeDay && days.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    activeDay = days.find((day) => String((day as Record<string, unknown>).date || '') === today)
      || days.find((day) => String((day as Record<string, unknown>).date || '') >= today)
      || days[0];
  }

  const placesByKey = new Map<string, Record<string, unknown>>();
  for (const day of days) {
    const dayEntry = day as Record<string, unknown>;
    const dayAssignments = Array.isArray(dayEntry.assignments) ? dayEntry.assignments : [];
    for (const a of dayAssignments) {
      const assignment = a as Record<string, unknown>;
      const key = String(
        assignment.google_place_id
        || assignment.osm_id
        || `${assignment.title || 'place'}|${assignment.lat || 'na'}|${assignment.lng || 'na'}`
      );
      if (placesByKey.has(key)) continue;
      placesByKey.set(key, {
        name: assignment.title || null,
        address: assignment.address || null,
        lat: assignment.lat ?? null,
        lng: assignment.lng ?? null,
        google_place_id: assignment.google_place_id || null,
        osm_id: assignment.osm_id || null,
        day_id: dayEntry.id || null,
        day_number: dayEntry.day_number || null,
      });
    }
  }
  const placesIndex = Array.from(placesByKey.values()).slice(0, 80);

  const reservations = reservationsRaw.slice(0, 20).map((r) => {
    const item = r as Record<string, unknown>;
    return {
      type: item.type,
      title: item.title,
      date: item.date,
      location: item.location,
      notes: shortenText(item.notes, 220),
    };
  });

  const collab_notes = collabNotesRaw.slice(0, 20).map((n) => {
    const item = n as Record<string, unknown>;
    return {
      title: item.title,
      category: item.category,
      content: shortenText(item.content, 220),
    };
  });

  const membersRaw = (src.members || {}) as Record<string, unknown>;
  const collaboratorsRaw = Array.isArray(membersRaw.collaborators) ? membersRaw.collaborators : [];
  const ownerRaw = (membersRaw.owner || {}) as Record<string, unknown>;

  return {
    meta: {
      source_message_id: options?.sourceMessageId || null,
      active_day_id: options?.activeDayId || (activeDay ? (activeDay.id as number) : null),
      context_generated_at: new Date().toISOString(),
    },
    trip: {
      id: trip.id,
      title: trip.title,
      description: shortenText(trip.description, 400),
      start_date: trip.start_date,
      end_date: trip.end_date,
      currency: trip.currency,
      place_count: trip.place_count || null,
    },
    members: {
      owner: ownerRaw.username || ownerRaw.email || null,
      collaborators: collaboratorsRaw.slice(0, 20).map((m) => {
        const member = m as Record<string, unknown>;
        return member.username || member.email || 'Unknown';
      }),
    },
    stats: {
      day_count: daysRaw.length,
      reservation_count: reservationsRaw.length,
      collab_note_count: collabNotesRaw.length,
      packing: src.packing || null,
      budget: src.budget || null,
    },
    active_day: activeDay,
    days,
    places_index: placesIndex,
    reservations,
    collab_notes,
    recent_chat: (options?.recentChat || []).slice(-24),
  };
}

function buildGeminiRecentChatContext(tripId: number, limit = 24): Record<string, unknown>[] {
  const all = listMessages(tripId) as Record<string, unknown>[];
  return all.slice(-limit).map((msg) => ({
    id: msg.id,
    author: msg.system_name || msg.username || 'Unknown',
    is_gemini: !!msg.is_gemini,
    reply_to_id: msg.reply_to_id || null,
    text: shortenText(msg.text, 320),
    created_at: msg.created_at,
  }));
}

function formatGeminiActionResultLine(result: Record<string, unknown>): string {
  const action = String(result.action || 'action');
  const status = String(result.status || 'ok');

  if (action === 'create_note' && status === 'ok') {
    return `create_note -> note #${result.id} (${shortenText(result.title, 80)})`;
  }
  if (action === 'create_packing_item' && status === 'ok') {
    return `create_packing_item -> packing #${result.id} (${shortenText(result.name, 80)})`;
  }
  if (action === 'create_todo' && status === 'ok') {
    return `create_todo -> todo #${result.id} (${shortenText(result.name, 80)})`;
  }
  if (action === 'create_budget_item' && status === 'ok') {
    return `create_budget_item -> budget #${result.id} (${shortenText(result.name, 80)}, ${result.total_price ?? 0})`;
  }
  if (action === 'create_place' && status === 'ok') {
    const daySuffix = result.assigned_day_id ? `, day #${result.assigned_day_id}` : '';
    return `create_place -> place #${result.id} (${shortenText(result.name, 80)}${daySuffix})`;
  }
  if (action === 'search_trip' && status === 'ok') {
    return `search_trip -> ${result.hit_count || 0} hits for "${shortenText(result.query, 80)}"`;
  }
  if (action === 'maps_search' && status === 'ok') {
    return `maps_search -> ${result.count || 0} places for "${shortenText(result.query, 80)}"`;
  }
  if (action === 'web_search' && status === 'ok') {
    return `web_search -> ${result.count || 0} results for "${shortenText(result.query, 80)}"`;
  }
  if (action === 'assign_place' && status === 'ok') {
    return `assign_place -> place #${result.place_id} assigned to day #${result.day_id}`;
  }
  if (status === 'skipped') {
    return `${action} -> skipped (${shortenText(result.reason, 100)})`;
  }
  return `${action} -> ${status}${result.error ? ` (${shortenText(result.error, 120)})` : ''}`;
}

function extractGeminiResourceId(result: Record<string, unknown>): string | null {
  const candidates = [
    result.id,
    result.place_id,
    result.assignment_id,
    result.message_id,
  ];

  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function summarizeGeminiExecutionResults(results: Record<string, unknown>[]): {
  successCount: number;
  skippedCount: number;
  errorCount: number;
} {
  let successCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const entry of results) {
    const status = normalizeGeminiActionStatus(entry.status);
    if (status === 'ok') successCount += 1;
    else if (status === 'skipped') skippedCount += 1;
    else errorCount += 1;
  }

  return { successCount, skippedCount, errorCount };
}

function toGeminiExecutionActionRecords(results: Record<string, unknown>[]): GeminiExecutionActionRecord[] {
  return results.map((entry, index) => ({
    actionIndex: index,
    actionType: String(entry.action || 'unknown'),
    status: normalizeGeminiActionStatus(entry.status),
    resourceId: extractGeminiResourceId(entry),
    summary: shortenText(formatGeminiActionResultLine(entry), 260),
    errorMessage: shortenText(entry.error, 260) || null,
    payload: entry,
  }));
}

function toGeminiPendingActionRecords(actions: Array<{ type: string }>): GeminiExecutionActionRecord[] {
  return actions.map((action, index) => ({
    actionIndex: index,
    actionType: String(action.type || 'unknown'),
    status: 'skipped',
    resourceId: null,
    summary: 'Pending approval before execution.',
    errorMessage: null,
    payload: action,
  }));
}

/* ------------------------------------------------------------------ */
/*  Notes                                                              */
/* ------------------------------------------------------------------ */

router.get('/notes', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  res.json({ notes: listNotes(tripId) });
});

router.post('/notes', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { title, content, category, color, website } = req.body;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const formatted = createNote(tripId, authReq.user.id, { title, content, category, color, website });
  res.status(201).json({ note: formatted });
  broadcast(tripId, 'collab:note:created', { note: formatted }, req.headers['x-socket-id'] as string);

  import('../services/notificationService').then(({ send }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    send({ event: 'collab_message', actorId: authReq.user.id, scope: 'trip', targetId: Number(tripId), params: { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, tripId: String(tripId) } }).catch(() => {});
  });
});

router.put('/notes/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { title, content, category, color, pinned, website } = req.body;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const formatted = updateNote(tripId, id, { title, content, category, color, pinned, website });
  if (!formatted) return res.status(404).json({ error: 'Note not found' });

  res.json({ note: formatted });
  broadcast(tripId, 'collab:note:updated', { note: formatted }, req.headers['x-socket-id'] as string);
});

router.delete('/notes/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!deleteNote(tripId, id)) return res.status(404).json({ error: 'Note not found' });

  res.json({ success: true });
  broadcast(tripId, 'collab:note:deleted', { noteId: Number(id) }, req.headers['x-socket-id'] as string);
});

/* ------------------------------------------------------------------ */
/*  Note files                                                         */
/* ------------------------------------------------------------------ */

router.post('/notes/:id/files', authenticate, noteUpload.single('file'), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = verifyTripAccess(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('file_upload', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission to upload files' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const result = addNoteFile(tripId, id, req.file);
  if (!result) return res.status(404).json({ error: 'Note not found' });

  res.status(201).json(result);
  broadcast(Number(tripId), 'collab:note:updated', { note: getFormattedNoteById(id) }, req.headers['x-socket-id'] as string);
});

router.delete('/notes/:id/files/:fileId', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id, fileId } = req.params;
  const access = verifyTripAccess(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!deleteNoteFile(id, fileId)) return res.status(404).json({ error: 'File not found' });

  res.json({ success: true });
  broadcast(Number(tripId), 'collab:note:updated', { note: getFormattedNoteById(id) }, req.headers['x-socket-id'] as string);
});

/* ------------------------------------------------------------------ */
/*  Polls                                                              */
/* ------------------------------------------------------------------ */

router.get('/polls', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  if (!verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  res.json({ polls: listPolls(tripId) });
});

router.post('/polls', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { question, options, multiple, multiple_choice, deadline } = req.body;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!question) return res.status(400).json({ error: 'Question is required' });
  if (!Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: 'At least 2 options are required' });
  }

  const poll = createPoll(tripId, authReq.user.id, { question, options, multiple, multiple_choice, deadline });
  res.status(201).json({ poll });
  broadcast(tripId, 'collab:poll:created', { poll }, req.headers['x-socket-id'] as string);
});

router.post('/polls/:id/vote', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { option_index } = req.body;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const result = votePoll(tripId, id, authReq.user.id, option_index);
  if (result.error === 'not_found') return res.status(404).json({ error: 'Poll not found' });
  if (result.error === 'closed') return res.status(400).json({ error: 'Poll is closed' });
  if (result.error === 'invalid_index') return res.status(400).json({ error: 'Invalid option index' });

  res.json({ poll: result.poll });
  broadcast(tripId, 'collab:poll:voted', { poll: result.poll }, req.headers['x-socket-id'] as string);
});

router.put('/polls/:id/close', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const updatedPoll = closePoll(tripId, id);
  if (!updatedPoll) return res.status(404).json({ error: 'Poll not found' });

  res.json({ poll: updatedPoll });
  broadcast(tripId, 'collab:poll:closed', { poll: updatedPoll }, req.headers['x-socket-id'] as string);
});

router.delete('/polls/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  if (!deletePoll(tripId, id)) return res.status(404).json({ error: 'Poll not found' });

  res.json({ success: true });
  broadcast(tripId, 'collab:poll:deleted', { pollId: Number(id) }, req.headers['x-socket-id'] as string);
});

/* ------------------------------------------------------------------ */
/*  Messages                                                           */
/* ------------------------------------------------------------------ */

router.get('/messages', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { before } = req.query;
  if (!verifyTripAccess(tripId, authReq.user.id)) return res.status(404).json({ error: 'Trip not found' });

  res.json({ messages: listMessages(tripId, before as string | undefined) });
});

router.post('/messages', authenticate, validateStringLengths({ text: 5000 }), (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { text, reply_to } = req.body;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text is required' });

  const result = createMessage(tripId, authReq.user.id, text, reply_to);
  if (result.error === 'reply_not_found') return res.status(400).json({ error: 'Reply target message not found' });

  res.status(201).json({ message: result.message });
  broadcast(tripId, 'collab:message:created', { message: result.message }, req.headers['x-socket-id'] as string);

  // Notify trip members about new chat message
  import('../services/notificationService').then(({ send }) => {
    const tripInfo = db.prepare('SELECT title FROM trips WHERE id = ?').get(tripId) as { title: string } | undefined;
    const preview = text.trim().length > 80 ? text.trim().substring(0, 80) + '...' : text.trim();
    send({ event: 'collab_message', actorId: authReq.user.id, scope: 'trip', targetId: Number(tripId), params: { trip: tripInfo?.title || 'Untitled', actor: authReq.user.email, preview, tripId: String(tripId) } }).catch(() => {});
  });
});

router.post('/messages/:id/gemini-execute', authenticate, validateStringLengths({ instruction: 1200 }), async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : '';
  const activeDayIdRaw = Number(req.body?.active_day_id);
  const activeDayId = Number.isFinite(activeDayIdRaw) && activeDayIdRaw > 0 ? Math.trunc(activeDayIdRaw) : null;
  const socketId = req.headers['x-socket-id'] as string;
  const executionId = uuidv4();
  const executionMode = normalizeGeminiExecutionMode(req.body?.execution_mode);
  const startedAt = Date.now();
  const clientIp = getClientIp(req);

  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id)) {
    return res.status(403).json({ error: 'No permission' });
  }

  const source = getMessageById(tripId, id);
  if (!source) return res.status(404).json({ error: 'Message not found' });

  const sourceText = (source.text || '').trim();
  if (!sourceText) return res.status(400).json({ error: 'Source message is empty' });

  const summary = getTripSummary(Number(tripId));
  const recentChat = buildGeminiRecentChatContext(Number(tripId), 24);
  const sourceAuthor = String((source as any).username || 'Unknown');
  const canEditPacking = checkPermission('packing_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id);
  const canCreateTodo = canEditPacking;
  const canEditBudget = checkPermission('budget_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id);
  const canCreatePlace = checkPermission('place_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id);
  const canEditDay = checkPermission('day_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id);

  let plan;
  let riskLevel = classifyGeminiRisk([]);
  let approvalRequired = false;
  try {
    plan = await generateGeminiExecutionPlan({
      sourceMessage: sourceText,
      sourceAuthor,
      instruction: instruction || undefined,
      tripContext: {
        message_id: Number(id),
        active_day_id: activeDayId,
        source_reply_to_id: (source as Record<string, unknown>).reply_to_id || null,
        capabilities: {
          create_note: true,
          create_packing_item: canEditPacking,
          create_todo: canCreateTodo,
          create_budget_item: canEditBudget,
          create_place: canCreatePlace,
          assign_place_to_day: canEditDay,
          search_trip: true,
          maps_search: true,
          web_search: true,
        },
        context: buildGeminiTripContext(summary, {
          activeDayId,
          recentChat,
          sourceMessageId: Number(id),
        }),
      },
    });
    riskLevel = classifyGeminiRisk(plan.actions || []);
    approvalRequired = executionMode === 'review'
      ? (!plan.needsClarification && (plan.actions || []).length > 0)
      : (executionMode !== 'force' && riskLevel === 'high' && !plan.needsClarification && (plan.actions || []).length > 0);
  } catch (err: unknown) {
    const status = typeof (err as { status?: unknown })?.status === 'number'
      ? ((err as { status?: number }).status as number)
      : null;
    const errMsg = err instanceof Error ? err.message : 'Gemini execution failed.';
    const keyRelatedError = status === 503 || /api[_\s-]?key|not configured/i.test(errMsg);
    const hintLine = keyRelatedError
      ? 'Set GEMINI_API_KEY (and optional GEMINI_MODEL) on the server, then retry.'
      : 'Please retry once. If this keeps happening, send one short concrete instruction and I will execute it safely.';
    const botErrorText = [
      'I could not execute this idea directly via server-side Gemini.',
      `Reason: ${errMsg}`,
      hintLine,
    ].join('\n');

    const botCreated = createMessage(tripId, authReq.user.id, encodeGeminiBotText(botErrorText), Number(id));
    if (botCreated.message) {
      broadcast(tripId, 'collab:message:created', { message: botCreated.message }, socketId);
    }

    const durationMs = Date.now() - startedAt;
    persistGeminiExecution({
      executionId,
      tripId: Number(tripId),
      userId: authReq.user.id,
      sourceMessageId: Number(id),
      instruction: instruction || null,
      model: null,
      executionMode,
      riskLevel,
      approvalRequired: false,
      needsClarification: false,
      status: 'failed',
      actionCount: 0,
      successCount: 0,
      skippedCount: 0,
      errorCount: 1,
      durationMs,
      warnings: [],
      errorMessage: errMsg,
      actionRecords: [],
    });

    writeAudit({
      userId: authReq.user.id,
      action: 'gemini.failed',
      resource: executionId,
      ip: clientIp,
      details: {
        trip_id: Number(tripId),
        source_message_id: Number(id),
        execution_mode: executionMode,
        stage: 'plan_generation',
        error: shortenText(errMsg, 260),
      },
    });

    return res.json({
      success: false,
      error: errMsg,
      message: botCreated.message || null,
      execution_id: executionId,
      execution_mode: executionMode,
      risk_level: riskLevel,
      approval_required: false,
      duration_ms: durationMs,
      execution_meta: {
        execution_id: executionId,
        execution_mode: executionMode,
        risk_level: riskLevel,
        approval_required: false,
        duration_ms: durationMs,
      },
    });
  }

  if (plan.needsClarification) {
    const thinkingLines = (plan.thinking || []).slice(0, 4).map((line) => `- ${shortenText(line, 180)}`);
    const questionLines = (plan.clarifyingQuestions || []).slice(0, 4).map((q, idx) => `${idx + 1}. ${shortenText(q, 180)}`);

    const botClarificationText = [
      'I need a quick clarification before I execute this safely.',
      `Model: ${plan.model}`,
      `Source: message #${id} by ${sourceAuthor}.`,
      activeDayId ? `Active day context: #${activeDayId}.` : null,
      instruction ? `Instruction: ${instruction}` : null,
      '',
      plan.assistantMessage,
      thinkingLines.length > 0 ? '' : null,
      thinkingLines.length > 0 ? 'What I considered:' : null,
      ...thinkingLines,
      '',
      'Please answer these questions:',
      ...(questionLines.length > 0 ? questionLines : ['1. Could you share one more detail so I can execute this exactly?']),
    ].filter(Boolean).join('\n');

    const clarificationMessage = createMessage(tripId, authReq.user.id, encodeGeminiBotText(botClarificationText), Number(id));
    if (!clarificationMessage.message) {
      const durationMs = Date.now() - startedAt;
      persistGeminiExecution({
        executionId,
        tripId: Number(tripId),
        userId: authReq.user.id,
        sourceMessageId: Number(id),
        instruction: instruction || null,
        model: plan.model,
        executionMode,
        riskLevel,
        approvalRequired,
        needsClarification: true,
        status: 'failed',
        actionCount: 0,
        successCount: 0,
        skippedCount: 0,
        errorCount: 1,
        durationMs,
        warnings: plan.warnings,
        errorMessage: 'Failed to create Gemini clarification message',
        actionRecords: [],
      });
      return res.status(500).json({ error: 'Failed to create Gemini clarification message' });
    }

    broadcast(tripId, 'collab:message:created', { message: clarificationMessage.message }, socketId);

    const durationMs = Date.now() - startedAt;
    persistGeminiExecution({
      executionId,
      tripId: Number(tripId),
      userId: authReq.user.id,
      sourceMessageId: Number(id),
      instruction: instruction || null,
      model: plan.model,
      executionMode,
      riskLevel,
      approvalRequired,
      needsClarification: true,
      status: 'clarification',
      actionCount: 0,
      successCount: 0,
      skippedCount: 0,
      errorCount: 0,
      durationMs,
      warnings: plan.warnings,
      errorMessage: null,
      actionRecords: [],
    });

    writeAudit({
      userId: authReq.user.id,
      action: 'gemini.clarification_requested',
      resource: executionId,
      ip: clientIp,
      details: {
        trip_id: Number(tripId),
        source_message_id: Number(id),
        model: plan.model,
        question_count: (plan.clarifyingQuestions || []).length,
        execution_mode: executionMode,
      },
    });

    return res.json({
      success: true,
      needs_clarification: true,
      questions: plan.clarifyingQuestions,
      thinking: plan.thinking,
      message: clarificationMessage.message,
      model: plan.model,
      actions: [],
      execution: [],
      notes: [],
      packing_items: [],
      todos: [],
      places: [],
      budget_items: [],
      web_results: [],
      warnings: plan.warnings,
      execution_id: executionId,
      execution_mode: executionMode,
      risk_level: riskLevel,
      approval_required: approvalRequired,
      duration_ms: durationMs,
      execution_meta: {
        execution_id: executionId,
        execution_mode: executionMode,
        risk_level: riskLevel,
        approval_required: approvalRequired,
        needs_clarification: true,
        duration_ms: durationMs,
      },
    });
  }

  if (approvalRequired) {
    const actionPreview = (plan.actions || []).slice(0, 6).map((action, index) => `${index + 1}. ${action.type}`);
    const warningLines = (plan.warnings || []).slice(0, 4).map((w: string) => `- ${shortenText(w, 180)}`);
    const approvalHeadline = executionMode === 'review'
      ? 'Review mode is active. Please approve before I execute this plan.'
      : 'This is a high-impact Gemini plan and needs your approval before I execute it.';

    const botApprovalText = [
      approvalHeadline,
      `Model: ${plan.model}`,
      `Execution mode: ${executionMode}`,
      `Risk: ${riskLevel}`,
      instruction ? `Instruction: ${instruction}` : null,
      '',
      plan.assistantMessage,
      '',
      'Planned actions:',
      ...(actionPreview.length > 0 ? actionPreview : ['- No executable actions.']),
      warningLines.length > 0 ? '' : null,
      warningLines.length > 0 ? 'Warnings:' : null,
      ...warningLines,
      '',
      'Approve by executing again with force mode.',
    ].filter(Boolean).join('\n');

    const approvalMessage = createMessage(tripId, authReq.user.id, encodeGeminiBotText(botApprovalText), Number(id));
    if (!approvalMessage.message) {
      const durationMs = Date.now() - startedAt;
      persistGeminiExecution({
        executionId,
        tripId: Number(tripId),
        userId: authReq.user.id,
        sourceMessageId: Number(id),
        instruction: instruction || null,
        model: plan.model,
        executionMode,
        riskLevel,
        approvalRequired,
        needsClarification: false,
        status: 'failed',
        actionCount: plan.actions.length,
        successCount: 0,
        skippedCount: plan.actions.length,
        errorCount: 1,
        durationMs,
        warnings: plan.warnings,
        errorMessage: 'Failed to create Gemini approval message',
        actionRecords: toGeminiPendingActionRecords((plan.actions || []) as Array<{ type: string }>),
      });
      return res.status(500).json({ error: 'Failed to create Gemini approval message' });
    }

    broadcast(tripId, 'collab:message:created', { message: approvalMessage.message }, socketId);

    const durationMs = Date.now() - startedAt;
    persistGeminiExecution({
      executionId,
      tripId: Number(tripId),
      userId: authReq.user.id,
      sourceMessageId: Number(id),
      instruction: instruction || null,
      model: plan.model,
      executionMode,
      riskLevel,
      approvalRequired: true,
      needsClarification: false,
      status: 'review',
      actionCount: plan.actions.length,
      successCount: 0,
      skippedCount: plan.actions.length,
      errorCount: 0,
      durationMs,
      warnings: plan.warnings,
      errorMessage: null,
      actionRecords: toGeminiPendingActionRecords((plan.actions || []) as Array<{ type: string }>),
    });

    writeAudit({
      userId: authReq.user.id,
      action: 'gemini.approval_requested',
      resource: executionId,
      ip: clientIp,
      details: {
        trip_id: Number(tripId),
        source_message_id: Number(id),
        model: plan.model,
        risk_level: riskLevel,
        action_count: plan.actions.length,
        execution_mode: executionMode,
      },
    });

    return res.json({
      success: true,
      needs_clarification: false,
      needs_approval: true,
      approval_required: true,
      risk_level: riskLevel,
      message: approvalMessage.message,
      model: plan.model,
      questions: [],
      thinking: plan.thinking,
      actions: plan.actions,
      execution: [],
      notes: [],
      packing_items: [],
      todos: [],
      places: [],
      budget_items: [],
      web_results: [],
      warnings: plan.warnings,
      execution_id: executionId,
      execution_mode: executionMode,
      duration_ms: durationMs,
      execution_meta: {
        execution_id: executionId,
        execution_mode: executionMode,
        risk_level: riskLevel,
        approval_required: true,
        needs_approval: true,
        duration_ms: durationMs,
      },
    });
  }

  const executionResults: Record<string, unknown>[] = [];
  const createdNotes: Record<string, unknown>[] = [];
  const createdPackingItems: Record<string, unknown>[] = [];
  const createdTodos: Record<string, unknown>[] = [];
  const createdPlaces: Record<string, unknown>[] = [];
  const createdBudgetItems: Record<string, unknown>[] = [];
  const createdWebResults: Record<string, unknown>[] = [];

  for (const action of plan.actions) {
    if (action.type === 'create_note') {
      const note = createNote(tripId, authReq.user.id, {
        title: action.title,
        content: action.content,
        category: action.category || 'Gemini',
        color: action.color || '#2563eb',
      });
      createdNotes.push(note as Record<string, unknown>);
      executionResults.push({ action: 'create_note', status: 'ok', id: (note as any).id, title: (note as any).title });
      broadcast(tripId, 'collab:note:created', { note });
      continue;
    }

    if (action.type === 'create_packing_item') {
      if (!canEditPacking) {
        executionResults.push({
          action: 'create_packing_item',
          status: 'skipped',
          reason: 'No packing edit permission',
          name: action.name,
        });
        continue;
      }

      const packing = createPackingItem(tripId, {
        name: action.name,
        category: action.category || 'Gemini',
        quantity: action.quantity ?? 1,
        checked: action.checked ?? false,
      }) as Record<string, unknown> | null;

      if (packing) {
        createdPackingItems.push(packing);
        executionResults.push({ action: 'create_packing_item', status: 'ok', id: packing.id, name: packing.name });
        broadcast(tripId, 'packing:created', { item: packing });
      } else {
        executionResults.push({ action: 'create_packing_item', status: 'error', error: 'Failed to create packing item', name: action.name });
      }
      continue;
    }

    if (action.type === 'create_todo') {
      if (!canCreateTodo) {
        executionResults.push({
          action: 'create_todo',
          status: 'skipped',
          reason: 'No todo edit permission',
          name: action.name,
        });
        continue;
      }

      const todo = createTodoItem(tripId, {
        name: action.name,
        category: action.category || 'Gemini',
        description: action.description || '',
        priority: action.priority ?? 1,
      }) as Record<string, unknown> | null;

      if (todo) {
        createdTodos.push(todo);
        executionResults.push({ action: 'create_todo', status: 'ok', id: todo.id, name: todo.name });
        broadcast(tripId, 'todo:created', { item: todo });
      } else {
        executionResults.push({ action: 'create_todo', status: 'error', error: 'Failed to create todo', name: action.name });
      }
      continue;
    }

    if (action.type === 'create_budget_item') {
      if (!canEditBudget) {
        executionResults.push({
          action: 'create_budget_item',
          status: 'skipped',
          reason: 'No budget edit permission',
          name: action.name,
        });
        continue;
      }

      const budgetName = shortenText(action.name, 180) || 'Budget item';
      const category = shortenText(action.category, 80) || 'Other';
      const totalPriceRaw = toFiniteNumber(action.total_price);
      const personsRaw = toFiniteNumber(action.persons);
      const daysRaw = toFiniteNumber(action.days);
      const note = shortenText(action.note, 1800) || null;
      const expenseDateCandidate = shortenText(action.expense_date, 20);
      const expenseDate = /^\d{4}-\d{2}-\d{2}$/.test(expenseDateCandidate) ? expenseDateCandidate : null;

      const item = createBudgetItem(String(tripId), {
        name: budgetName,
        category,
        total_price: totalPriceRaw !== null ? Math.max(0, Number(totalPriceRaw.toFixed(2))) : 0,
        persons: personsRaw !== null ? Math.max(1, Math.min(100, Math.round(personsRaw))) : null,
        days: daysRaw !== null ? Math.max(1, Math.min(365, Math.round(daysRaw))) : null,
        note,
        expense_date: expenseDate,
      }) as Record<string, unknown> | null;

      if (item && item.id !== undefined && item.id !== null) {
        createdBudgetItems.push(item);
        executionResults.push({
          action: 'create_budget_item',
          status: 'ok',
          id: item.id,
          name: item.name,
          total_price: item.total_price,
          category: item.category,
        });
        broadcast(tripId, 'budget:created', { item });
      } else {
        executionResults.push({
          action: 'create_budget_item',
          status: 'error',
          error: 'Failed to create budget item',
          name: budgetName,
        });
      }
      continue;
    }

    if (action.type === 'create_place') {
      if (!canCreatePlace) {
        executionResults.push({
          action: 'create_place',
          status: 'skipped',
          reason: 'No place edit permission',
          name: action.name || action.query || 'Unnamed place',
        });
        continue;
      }

      let selectedResult: Record<string, unknown> | null = null;
      let searchSource: string | null = null;

      if (action.query) {
        try {
          const searchResult = await searchPlaces(authReq.user.id, action.query);
          const candidates = (searchResult.places || []) as Record<string, unknown>[];
          const selectedIndex = Number.isFinite(action.selected_index as number)
            ? Math.max(0, Math.min(candidates.length - 1, Number(action.selected_index || 0)))
            : 0;
          selectedResult = candidates[selectedIndex] || null;
          searchSource = searchResult.source;
        } catch (err: unknown) {
          executionResults.push({
            action: 'maps_search',
            status: 'error',
            query: action.query,
            error: err instanceof Error ? err.message : 'Maps search failed',
          });
        }
      }

      const resolvedName = shortenText(action.name || selectedResult?.name || action.query || 'Gemini Place', 200) || 'Gemini Place';
      const resolvedLat = toFiniteNumber(action.lat ?? selectedResult?.lat);
      const resolvedLng = toFiniteNumber(action.lng ?? selectedResult?.lng);

      if (resolvedLat === null || resolvedLng === null) {
        executionResults.push({
          action: 'create_place',
          status: 'skipped',
          reason: 'Missing coordinates for place creation',
          name: resolvedName,
        });
        continue;
      }

      const resolvedAddress = shortenText(action.address || selectedResult?.address, 500) || undefined;
      const resolvedGooglePlaceId = shortenText(action.google_place_id || selectedResult?.google_place_id, 180) || undefined;
      const resolvedOsmId = shortenText(action.osm_id || selectedResult?.osm_id, 120) || undefined;
      const resolvedWebsite = shortenText(action.website || selectedResult?.website, 400) || undefined;
      const resolvedPhone = shortenText(action.phone || selectedResult?.phone, 80) || undefined;

      const place = createPlace(String(tripId), {
        name: resolvedName,
        address: resolvedAddress,
        lat: resolvedLat,
        lng: resolvedLng,
        notes: action.notes || '',
        place_time: action.place_time || undefined,
        end_time: action.end_time || undefined,
        google_place_id: resolvedGooglePlaceId,
        osm_id: resolvedOsmId,
        website: resolvedWebsite,
        phone: resolvedPhone,
      }) as Record<string, unknown> | null;

      if (!place || place.id === undefined || place.id === null) {
        executionResults.push({
          action: 'create_place',
          status: 'error',
          error: 'Failed to create place',
          name: resolvedName,
        });
        continue;
      }

      createdPlaces.push(place);
      const placeResult: Record<string, unknown> = {
        action: 'create_place',
        status: 'ok',
        id: place.id,
        name: place.name || resolvedName,
        lat: resolvedLat,
        lng: resolvedLng,
      };
      if (searchSource) placeResult.source = searchSource;
      executionResults.push(placeResult);
      broadcast(tripId, 'place:created', { place });

      const requestedDayId = action.day_id;
      const requestedDayNumber = action.day_number;
      let targetDayId: number | null = null;

      if (Number.isFinite(requestedDayId as number)) {
        const row = db.prepare('SELECT id FROM days WHERE id = ? AND trip_id = ?').get(Number(requestedDayId), Number(tripId)) as { id: number } | undefined;
        targetDayId = row?.id || null;
      } else if (Number.isFinite(requestedDayNumber as number)) {
        const row = db.prepare('SELECT id FROM days WHERE trip_id = ? AND day_number = ?').get(Number(tripId), Number(requestedDayNumber)) as { id: number } | undefined;
        targetDayId = row?.id || null;
      }

      const hasRequestedDayTarget = Number.isFinite(requestedDayId as number) || Number.isFinite(requestedDayNumber as number);
      if (hasRequestedDayTarget && targetDayId === null) {
        executionResults.push({
          action: 'assign_place',
          status: 'skipped',
          reason: 'Target day not found',
          place_id: place.id,
          day_id: requestedDayId || null,
          day_number: requestedDayNumber || null,
        });
      } else if (targetDayId !== null) {
        if (!canEditDay) {
          executionResults.push({
            action: 'assign_place',
            status: 'skipped',
            reason: 'No day edit permission',
            place_id: place.id,
            day_id: targetDayId,
          });
        } else {
          const placeIdNum = Number(place.id);
          if (Number.isFinite(placeIdNum)) {
            const assignment = createAssignment(targetDayId, placeIdNum, null) as Record<string, unknown> | null;
            if (assignment) {
              placeResult.assigned_day_id = targetDayId;
              executionResults.push({
                action: 'assign_place',
                status: 'ok',
                place_id: place.id,
                day_id: targetDayId,
                assignment_id: assignment.id,
              });
              broadcast(tripId, 'assignment:created', { assignment });
            } else {
              executionResults.push({
                action: 'assign_place',
                status: 'error',
                error: 'Failed to assign place to day',
                place_id: place.id,
                day_id: targetDayId,
              });
            }
          }
        }
      }
      continue;
    }

    if (action.type === 'search_trip') {
      const hits = searchTripSummary(summary, action.query, action.max_results || 10);
      executionResults.push({
        action: 'search_trip',
        status: 'ok',
        query: action.query,
        hit_count: hits.length,
        hits: hits.slice(0, 5),
      });
      continue;
    }

    if (action.type === 'maps_search') {
      try {
        const result = await searchPlaces(authReq.user.id, action.query);
        const places = (result.places || []).slice(0, action.max_results || 5).map((p) => {
          const place = p as Record<string, unknown>;
          return {
            name: place.name || null,
            address: place.address || null,
            lat: place.lat || null,
            lng: place.lng || null,
            source: place.source || result.source,
          };
        });
        executionResults.push({
          action: 'maps_search',
          status: 'ok',
          query: action.query,
          count: places.length,
          source: result.source,
          places,
        });
      } catch (err: unknown) {
        executionResults.push({
          action: 'maps_search',
          status: 'error',
          query: action.query,
          error: err instanceof Error ? err.message : 'Maps search failed',
        });
      }
      continue;
    }

    if (action.type === 'web_search') {
      try {
        const results = await runWebSearch(action.query, action.max_results || 5);
        createdWebResults.push({ query: action.query, results });
        executionResults.push({
          action: 'web_search',
          status: 'ok',
          query: action.query,
          count: results.length,
          results,
        });
      } catch (err: unknown) {
        executionResults.push({
          action: 'web_search',
          status: 'error',
          query: action.query,
          error: err instanceof Error ? err.message : 'Web search failed',
        });
      }
      continue;
    }
  }

  const thinkingLines = (plan.thinking || []).slice(0, 4).map((line) => `- ${shortenText(line, 180)}`);
  const resultLines = executionResults.slice(0, 8).map((entry, idx) => `${idx + 1}. ${formatGeminiActionResultLine(entry)}`);
  const warningLines = (plan.warnings || []).slice(0, 4).map((w: string) => `- ${shortenText(w, 180)}`);

  const botMessageText = [
    'Execution completed via server-side Gemini API.',
    `Model: ${plan.model}`,
    `Source: message #${id} by ${sourceAuthor}.`,
    activeDayId ? `Active day context: #${activeDayId}.` : null,
    instruction ? `Instruction: ${instruction}` : null,
    '',
    plan.assistantMessage,
    thinkingLines.length > 0 ? '' : null,
    thinkingLines.length > 0 ? 'Thinking:' : null,
    ...thinkingLines,
    '',
    'Action results:',
    ...(resultLines.length > 0 ? resultLines : ['- No actions executed.']),
    warningLines.length > 0 ? '' : null,
    warningLines.length > 0 ? 'Warnings:' : null,
    ...warningLines,
  ].filter(Boolean).join('\n');

  const botCreated = createMessage(tripId, authReq.user.id, encodeGeminiBotText(botMessageText), Number(id));
  if (!botCreated.message) {
    const counts = summarizeGeminiExecutionResults(executionResults);
    const durationMs = Date.now() - startedAt;
    persistGeminiExecution({
      executionId,
      tripId: Number(tripId),
      userId: authReq.user.id,
      sourceMessageId: Number(id),
      instruction: instruction || null,
      model: plan.model,
      executionMode,
      riskLevel,
      approvalRequired: false,
      needsClarification: false,
      status: 'failed',
      actionCount: plan.actions.length,
      successCount: counts.successCount,
      skippedCount: counts.skippedCount,
      errorCount: counts.errorCount + 1,
      durationMs,
      warnings: plan.warnings,
      errorMessage: 'Failed to create Gemini response message',
      actionRecords: toGeminiExecutionActionRecords(executionResults),
    });
    return res.status(500).json({ error: 'Failed to create Gemini response message' });
  }

  broadcast(tripId, 'collab:message:created', { message: botCreated.message }, socketId);

  const counts = summarizeGeminiExecutionResults(executionResults);
  const durationMs = Date.now() - startedAt;
  persistGeminiExecution({
    executionId,
    tripId: Number(tripId),
    userId: authReq.user.id,
    sourceMessageId: Number(id),
    instruction: instruction || null,
    model: plan.model,
    executionMode,
    riskLevel,
    approvalRequired: false,
    needsClarification: false,
    status: 'completed',
    actionCount: plan.actions.length,
    successCount: counts.successCount,
    skippedCount: counts.skippedCount,
    errorCount: counts.errorCount,
    durationMs,
    warnings: plan.warnings,
    errorMessage: null,
    actionRecords: toGeminiExecutionActionRecords(executionResults),
  });

  writeAudit({
    userId: authReq.user.id,
    action: 'gemini.execute',
    resource: executionId,
    ip: clientIp,
    details: {
      trip_id: Number(tripId),
      source_message_id: Number(id),
      model: plan.model,
      execution_mode: executionMode,
      risk_level: riskLevel,
      action_count: plan.actions.length,
      success_count: counts.successCount,
      skipped_count: counts.skippedCount,
      error_count: counts.errorCount,
      duration_ms: durationMs,
    },
  });

  res.json({
    success: true,
    message: botCreated.message,
    model: plan.model,
    needs_clarification: false,
    questions: [],
    thinking: plan.thinking,
    actions: plan.actions,
    execution: executionResults,
    notes: createdNotes,
    packing_items: createdPackingItems,
    todos: createdTodos,
    places: createdPlaces,
    budget_items: createdBudgetItems,
    web_results: createdWebResults,
    warnings: plan.warnings,
    execution_id: executionId,
    execution_mode: executionMode,
    risk_level: riskLevel,
    approval_required: false,
    duration_ms: durationMs,
    execution_meta: {
      execution_id: executionId,
      execution_mode: executionMode,
      risk_level: riskLevel,
      approval_required: false,
      duration_ms: durationMs,
      counts: {
        planned: plan.actions.length,
        success: counts.successCount,
        skipped: counts.skippedCount,
        error: counts.errorCount,
      },
    },
  });
});

/* ------------------------------------------------------------------ */
/*  Reactions                                                          */
/* ------------------------------------------------------------------ */

router.post('/messages/:id/react', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const { emoji } = req.body;
  const access = verifyTripAccess(Number(tripId), authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });
  if (!emoji) return res.status(400).json({ error: 'Emoji is required' });

  const result = addOrRemoveReaction(id, tripId, authReq.user.id, emoji);
  if (!result.found) return res.status(404).json({ error: 'Message not found' });

  res.json({ reactions: result.reactions });
  broadcast(Number(tripId), 'collab:message:reacted', { messageId: Number(id), reactions: result.reactions }, req.headers['x-socket-id'] as string);
});

/* ------------------------------------------------------------------ */
/*  Delete message                                                     */
/* ------------------------------------------------------------------ */

router.delete('/messages/:id', authenticate, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId, id } = req.params;
  const access = verifyTripAccess(tripId, authReq.user.id);
  if (!access) return res.status(404).json({ error: 'Trip not found' });
  if (!checkPermission('collab_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id))
    return res.status(403).json({ error: 'No permission' });

  const result = deleteMessage(tripId, id, authReq.user.id);
  if (result.error === 'not_found') return res.status(404).json({ error: 'Message not found' });
  if (result.error === 'not_owner') return res.status(403).json({ error: 'You can only delete your own messages' });

  res.json({ success: true });
  broadcast(tripId, 'collab:message:deleted', { messageId: Number(id), username: result.username || authReq.user.username }, req.headers['x-socket-id'] as string);
});

/* ------------------------------------------------------------------ */
/*  Link preview                                                       */
/* ------------------------------------------------------------------ */

router.get('/link-preview', authenticate, async (req: Request, res: Response) => {
  const { url } = req.query as { url?: string };
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const preview = await fetchLinkPreview(url);
    const asAny = preview as any;
    if (asAny.error) return res.status(400).json({ error: asAny.error });
    res.json(preview);
  } catch {
    res.json({ title: null, description: null, image: null, url });
  }
});

export default router;
