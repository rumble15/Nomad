import express, { Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { broadcast } from '../websocket';
import { AuthRequest } from '../types';
import { db, canAccessTrip } from '../db/database';

const router = express.Router({ mergeParams: true });

function requireTripAccess(req: Request, res: Response, next: express.NextFunction): void {
  const authReq = req as AuthRequest;
  const tripId = Number(req.params.tripId);
  if (!authReq.user || !canAccessTrip(tripId, authReq.user.id)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  next();
}

function getActivity(tripId: string | number, id: string | number) {
  return db.prepare('SELECT * FROM activities WHERE id = ? AND trip_id = ?').get(Number(id), Number(tripId)) as Record<string, unknown> | undefined;
}

/** GET /trips/:tripId/activities — list all activities for a trip */
router.get('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId } = req.params;
  const rows = db.prepare(`
    SELECT a.*, p.name AS place_name, p.lat, p.lng, p.address,
           c.color AS category_color, c.icon AS category_icon
    FROM activities a
    LEFT JOIN places p ON a.place_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE a.trip_id = ?
    ORDER BY a.priority DESC, a.created_at ASC
  `).all(Number(tripId));
  res.json(rows);
});

/** POST /trips/:tripId/activities — create a new activity */
router.post('/', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  const { tripId } = req.params;
  const { title, description, place_id, duration_minutes, status, priority, planned_date } = req.body;

  if (!title || typeof title !== 'string' || !title.trim()) {
    res.status(400).json({ error: 'Title is required' });
    return;
  }

  const result = db.prepare(`
    INSERT INTO activities (trip_id, place_id, title, description, duration_minutes, status, priority, planned_date, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(tripId),
    place_id ? Number(place_id) : null,
    title.trim(),
    description || null,
    duration_minutes ? Number(duration_minutes) : 60,
    status || 'planned',
    priority ? Number(priority) : 0,
    planned_date || null,
    authReq.user!.id,
  );

  const activity = db.prepare(`
    SELECT a.*, p.name AS place_name, p.lat, p.lng, p.address,
           c.color AS category_color, c.icon AS category_icon
    FROM activities a
    LEFT JOIN places p ON a.place_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE a.id = ?
  `).get(result.lastInsertRowid);

  broadcast(Number(tripId), 'activity:created', { activity }, req.headers['x-socket-id'] as string);
  res.status(201).json(activity);
});

/** PUT /trips/:tripId/activities/:id — update an activity */
router.put('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, id } = req.params;
  const existing = getActivity(tripId, id);
  if (!existing) { res.status(404).json({ error: 'Activity not found' }); return; }

  const { title, description, place_id, duration_minutes, status, priority, planned_date } = req.body;

  db.prepare(`
    UPDATE activities SET
      title = COALESCE(?, title),
      description = ?,
      place_id = ?,
      duration_minutes = COALESCE(?, duration_minutes),
      status = COALESCE(?, status),
      priority = COALESCE(?, priority),
      planned_date = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND trip_id = ?
  `).run(
    title?.trim() || null,
    description !== undefined ? description : existing.description,
    place_id !== undefined ? (place_id ? Number(place_id) : null) : existing.place_id,
    duration_minutes != null ? Number(duration_minutes) : null,
    status || null,
    priority != null ? Number(priority) : null,
    planned_date !== undefined ? planned_date : existing.planned_date,
    Number(id),
    Number(tripId),
  );

  const activity = db.prepare(`
    SELECT a.*, p.name AS place_name, p.lat, p.lng, p.address,
           c.color AS category_color, c.icon AS category_icon
    FROM activities a
    LEFT JOIN places p ON a.place_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE a.id = ?
  `).get(Number(id));

  broadcast(Number(tripId), 'activity:updated', { activity }, req.headers['x-socket-id'] as string);
  res.json(activity);
});

/** DELETE /trips/:tripId/activities/:id — delete an activity */
router.delete('/:id', authenticate, requireTripAccess, (req: Request, res: Response) => {
  const { tripId, id } = req.params;
  const existing = getActivity(tripId, id);
  if (!existing) { res.status(404).json({ error: 'Activity not found' }); return; }

  db.prepare('DELETE FROM activities WHERE id = ? AND trip_id = ?').run(Number(id), Number(tripId));
  broadcast(Number(tripId), 'activity:deleted', { activityId: Number(id) }, req.headers['x-socket-id'] as string);
  res.json({ success: true });
});

export default router;
