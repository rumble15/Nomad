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
import { searchPlaces } from '../services/mapsService';
import { generateGeminiExecutionPlan, searchTripSummary } from '../services/geminiCoWorkerService';

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

function buildGeminiTripContext(summary: unknown): Record<string, unknown> | null {
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
      day_number: day.day_number,
      date: day.date,
      title: day.title,
      assignment_count: assignments.length,
      assignments: assignments.slice(0, 12).map((a) => {
        const item = a as Record<string, unknown>;
        return {
          title: item.place_name || item.name,
          time: item.place_time || item.time,
          notes: shortenText(item.notes, 220),
        };
      }),
    };
  });

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
    trip: {
      id: trip.id,
      title: trip.title,
      description: shortenText(trip.description, 400),
      start_date: trip.start_date,
      end_date: trip.end_date,
      currency: trip.currency,
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
    days,
    reservations,
    collab_notes,
  };
}

function formatGeminiActionResultLine(result: Record<string, unknown>): string {
  const action = String(result.action || 'action');
  const status = String(result.status || 'ok');

  if (action === 'create_note' && status === 'ok') {
    return `create_note -> note #${result.id} (${shortenText(result.title, 80)})`;
  }
  if (action === 'create_todo' && status === 'ok') {
    return `create_todo -> todo #${result.id} (${shortenText(result.name, 80)})`;
  }
  if (action === 'search_trip' && status === 'ok') {
    return `search_trip -> ${result.hit_count || 0} hits for "${shortenText(result.query, 80)}"`;
  }
  if (action === 'maps_search' && status === 'ok') {
    return `maps_search -> ${result.count || 0} places for "${shortenText(result.query, 80)}"`;
  }
  if (status === 'skipped') {
    return `${action} -> skipped (${shortenText(result.reason, 100)})`;
  }
  return `${action} -> ${status}${result.error ? ` (${shortenText(result.error, 120)})` : ''}`;
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
  const socketId = req.headers['x-socket-id'] as string;

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
  const sourceAuthor = String((source as any).username || 'Unknown');
  const canCreateTodo = checkPermission('packing_edit', authReq.user.role, access.user_id, authReq.user.id, access.user_id !== authReq.user.id);

  let plan;
  try {
    plan = await generateGeminiExecutionPlan({
      sourceMessage: sourceText,
      sourceAuthor,
      instruction: instruction || undefined,
      tripContext: {
        message_id: Number(id),
        context: buildGeminiTripContext(summary),
      },
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : 'Gemini execution failed.';
    const botErrorText = [
      'I could not execute this idea directly via server-side Gemini.',
      `Reason: ${errMsg}`,
      'Set GEMINI_API_KEY (and optional GEMINI_MODEL) on the server, then retry.',
    ].join('\n');

    const botCreated = createMessage(tripId, authReq.user.id, encodeGeminiBotText(botErrorText), Number(id));
    if (botCreated.message) {
      broadcast(tripId, 'collab:message:created', { message: botCreated.message }, socketId);
    }

    return res.json({ success: false, error: errMsg, message: botCreated.message || null });
  }

  const executionResults: Record<string, unknown>[] = [];
  const createdNotes: Record<string, unknown>[] = [];
  const createdTodos: Record<string, unknown>[] = [];

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
      broadcast(tripId, 'collab:note:created', { note }, socketId);
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
        broadcast(tripId, 'todo:created', { item: todo }, socketId);
      } else {
        executionResults.push({ action: 'create_todo', status: 'error', error: 'Failed to create todo', name: action.name });
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
  }

  if (createdNotes.length === 0 && createdTodos.length === 0) {
    const fallbackNote = createNote(tripId, authReq.user.id, {
      title: `Gemini Result - Message #${id}`,
      content: plan.assistantMessage,
      category: 'Gemini',
      color: '#2563eb',
    });
    createdNotes.push(fallbackNote as Record<string, unknown>);
    executionResults.push({ action: 'create_note', status: 'ok', id: (fallbackNote as any).id, title: (fallbackNote as any).title });
    broadcast(tripId, 'collab:note:created', { note: fallbackNote }, socketId);
  }

  const resultLines = executionResults.slice(0, 8).map((entry, idx) => `${idx + 1}. ${formatGeminiActionResultLine(entry)}`);
  const warningLines = (plan.warnings || []).slice(0, 4).map((w: string) => `- ${shortenText(w, 180)}`);

  const botMessageText = [
    'Execution completed via server-side Gemini API.',
    `Model: ${plan.model}`,
    `Source: message #${id} by ${sourceAuthor}.`,
    instruction ? `Instruction: ${instruction}` : null,
    '',
    plan.assistantMessage,
    '',
    'Action results:',
    ...(resultLines.length > 0 ? resultLines : ['- No actions executed.']),
    warningLines.length > 0 ? '' : null,
    warningLines.length > 0 ? 'Warnings:' : null,
    ...warningLines,
  ].filter(Boolean).join('\n');

  const botCreated = createMessage(tripId, authReq.user.id, encodeGeminiBotText(botMessageText), Number(id));
  if (!botCreated.message) return res.status(500).json({ error: 'Failed to create Gemini response message' });

  broadcast(tripId, 'collab:message:created', { message: botCreated.message }, socketId);

  res.json({
    success: true,
    message: botCreated.message,
    model: plan.model,
    actions: plan.actions,
    execution: executionResults,
    notes: createdNotes,
    todos: createdTodos,
    warnings: plan.warnings,
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
