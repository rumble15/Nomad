import React, { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2, CheckCircle2, Circle, MapPin, Clock, Calendar, Sparkles, ChevronDown, ChevronUp, Edit2, X } from 'lucide-react'
import { activitiesApi } from '../../api/client'
import { useTranslation } from '../../i18n'
import { useCanDo } from '../../store/permissionsStore'
import { useTripStore } from '../../store/tripStore'
import { addListener, removeListener } from '../../api/websocket'
import type { Place } from '../../types'

interface Activity {
  trip_id: number
  place_id: number | null
  title: string
  description: string | null
  duration_minutes: number
  status: 'planned' | 'done' | 'skipped'
  priority: number
  planned_date: string | null
  place_name?: string | null
  lat?: number | null
  lng?: number | null
  category_color?: string | null
  category_icon?: string | null
  created_at: string
}

interface ActivityFormState {
  title: string
  description: string
  place_id: string
  duration_minutes: string
  planned_date: string
  priority: string
}

const STATUS_COLORS = {
  planned: '#6366f1',
  done: '#22c55e',
  skipped: '#9ca3af',
}

const STATUS_LABELS: Record<string, string> = {
  planned: 'Geplant',
  done: 'Erledigt',
  skipped: 'Übersprungen',
}

interface ActivitiesPanelProps {
  tripId: number
  places: Place[]
  onActivityClick?: (lat: number, lng: number, title: string) => void
}

export default function ActivitiesPanel({ tripId, places, onActivityClick }: ActivitiesPanelProps) {
  const { t } = useTranslation()
  const can = useCanDo()
  const trip = useTripStore(s => s.trip)
  const canEdit = can('place_edit', trip)
  const [activities, setActivities] = useState<Activity[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingActivity, setEditingActivity] = useState<Activity | null>(null)
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [form, setForm] = useState<ActivityFormState>({
    title: '',
    description: '',
    place_id: '',
    duration_minutes: '60',
    planned_date: '',
    priority: '0',
  })
  const [saving, setSaving] = useState(false)

  const loadActivities = useCallback(() => {
    activitiesApi.list(tripId).then(data => {
      setActivities(Array.isArray(data) ? data : [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [tripId])

  useEffect(() => { loadActivities() }, [loadActivities])

  // Realtime sync
  useEffect(() => {
    const handler = (event: { type: string; activity?: Activity; activityId?: number; tripId?: number | string }) => {
      if (String(event.tripId) !== String(tripId) && !event.activity?.trip_id) return
      if (event.type === 'activity:created' && event.activity) {
        setActivities(prev => prev.some(a => a.id === event.activity!.id) ? prev : [...prev, event.activity!])
      } else if (event.type === 'activity:updated' && event.activity) {
        setActivities(prev => prev.map(a => a.id === event.activity!.id ? event.activity! : a))
      } else if (event.type === 'activity:deleted' && event.activityId) {
        setActivities(prev => prev.filter(a => a.id !== event.activityId))
      }
    }
    addListener(handler as any)
    return () => removeListener(handler as any)
  }, [tripId])

  const resetForm = () => {
    setForm({ title: '', description: '', place_id: '', duration_minutes: '60', planned_date: '', priority: '0' })
    setEditingActivity(null)
    setShowForm(false)
  }

  const openEdit = (a: Activity) => {
    setForm({
      title: a.title,
      description: a.description || '',
      place_id: a.place_id ? String(a.place_id) : '',
      duration_minutes: String(a.duration_minutes || 60),
      planned_date: a.planned_date || '',
      priority: String(a.priority || 0),
    })
    setEditingActivity(a)
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!form.title.trim()) return
    setSaving(true)
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description || null,
        place_id: form.place_id ? Number(form.place_id) : null,
        duration_minutes: Number(form.duration_minutes) || 60,
        planned_date: form.planned_date || null,
        priority: Number(form.priority) || 0,
      }
      if (editingActivity) {
        await activitiesApi.update(tripId, editingActivity.id, payload)
      } else {
        await activitiesApi.create(tripId, payload)
      }
      loadActivities()
      resetForm()
    } catch {} finally { setSaving(false) }
  }

  const handleStatusToggle = async (a: Activity) => {
    if (!canEdit) return
    const next = a.status === 'done' ? 'planned' : 'done'
    await activitiesApi.update(tripId, a.id, { status: next }).catch(() => {})
    setActivities(prev => prev.map(x => x.id === a.id ? { ...x, status: next } : x))
  }

  const handleDelete = async (id: number) => {
    await activitiesApi.delete(tripId, id).catch(() => {})
    setActivities(prev => prev.filter(a => a.id !== id))
  }

  const filtered = activities.filter(a => filterStatus === 'all' ? true : a.status === filterStatus)
  const placeOptions = places.filter(p => p.lat && p.lng)
  const doneCount = activities.filter(a => a.status === 'done').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '16px 20px 12px',
        borderBottom: '1px solid var(--border-faint)',
        background: 'linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(168,85,247,0.06) 100%)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 34, height: 34, borderRadius: '50%',
              background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 8px rgba(99,102,241,0.35)',
            }}>
              <Sparkles size={16} color="white" />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Aktivitäten</div>
              <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                {doneCount}/{activities.length} erledigt
              </div>
            </div>
          </div>
          {canEdit && (
            <button
              onClick={() => { resetForm(); setShowForm(s => !s) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 14px', borderRadius: 20,
                background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                color: 'white', border: 'none', cursor: 'pointer',
                fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
                boxShadow: '0 2px 8px rgba(99,102,241,0.3)',
              }}
            >
              <Plus size={13} /> Neu
            </button>
          )}
        </div>

        {/* Filter tabs */}
        <div style={{ display: 'flex', gap: 4, marginTop: 12 }}>
          {(['all', 'planned', 'done', 'skipped'] as const).map(s => (
            <button key={s} onClick={() => setFilterStatus(s)} style={{
              padding: '4px 10px', borderRadius: 12, border: 'none', cursor: 'pointer',
              background: filterStatus === s ? 'var(--accent)' : 'var(--bg-hover)',
              color: filterStatus === s ? 'var(--accent-text)' : 'var(--text-secondary)',
              fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}>
              {s === 'all' ? 'Alle' : STATUS_LABELS[s]}
              {s !== 'all' && (
                <span style={{ marginLeft: 4, opacity: 0.7 }}>
                  {activities.filter(a => a.status === s).length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Add / Edit Form */}
      {showForm && (
        <div style={{
          padding: '14px 20px',
          borderBottom: '1px solid var(--border-faint)',
          background: 'var(--bg-hover)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
              {editingActivity ? 'Aktivität bearbeiten' : 'Neue Aktivität'}
            </span>
            <button onClick={resetForm} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', padding: 2 }}>
              <X size={14} />
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              placeholder="Titel *"
              value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              style={{
                padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-primary)',
                background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13,
                fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box',
              }}
            />
            <textarea
              placeholder="Beschreibung (optional)"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              rows={2}
              style={{
                padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-primary)',
                background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 12,
                fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box',
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <select
                value={form.place_id}
                onChange={e => setForm(f => ({ ...f, place_id: e.target.value }))}
                style={{
                  flex: 1, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-primary)',
                  background: 'var(--bg-card)', color: form.place_id ? 'var(--text-primary)' : 'var(--text-faint)',
                  fontSize: 12, fontFamily: 'inherit', outline: 'none',
                }}
              >
                <option value="">Ort verknüpfen…</option>
                {placeOptions.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <input
                type="number"
                placeholder="Min"
                value={form.duration_minutes}
                onChange={e => setForm(f => ({ ...f, duration_minutes: e.target.value }))}
                style={{
                  width: 70, padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-primary)',
                  background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 12,
                  fontFamily: 'inherit', outline: 'none',
                }}
              />
            </div>
            <input
              type="date"
              value={form.planned_date}
              onChange={e => setForm(f => ({ ...f, planned_date: e.target.value }))}
              style={{
                padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border-primary)',
                background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 12,
                fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={resetForm} style={{
                padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border-primary)',
                background: 'transparent', color: 'var(--text-secondary)', fontSize: 12,
                fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}>
                Abbrechen
              </button>
              <button onClick={handleSave} disabled={!form.title.trim() || saving} style={{
                padding: '6px 16px', borderRadius: 8, border: 'none',
                background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                color: 'white', fontSize: 12, fontWeight: 600, cursor: saving ? 'default' : 'pointer',
                fontFamily: 'inherit', opacity: saving ? 0.7 : 1,
              }}>
                {saving ? 'Speichern…' : 'Speichern'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-faint)', fontSize: 13 }}>Laden…</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <div style={{
              width: 52, height: 52, borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(99,102,241,0.12) 0%, rgba(168,85,247,0.1) 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px',
            }}>
              <Sparkles size={22} color="#8b5cf6" />
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
              {filterStatus === 'all' ? 'Noch keine Aktivitäten' : `Keine ${STATUS_LABELS[filterStatus]} Aktivitäten`}
            </div>
            {filterStatus === 'all' && canEdit && (
              <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Erstelle Aktivitäten und verknüpfe sie mit Orten auf deiner Karte</div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filtered.map(a => {
              const isExpanded = expandedId === a.id
              const statusColor = STATUS_COLORS[a.status] || '#6366f1'
              const isDone = a.status === 'done'
              return (
                <div key={a.id} style={{
                  borderRadius: 12,
                  border: '1px solid var(--border-faint)',
                  background: 'var(--bg-card)',
                  overflow: 'hidden',
                  transition: 'box-shadow 0.15s',
                  boxShadow: isExpanded ? '0 2px 12px rgba(0,0,0,0.08)' : 'none',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' }}>
                    {/* Status toggle */}
                    <button
                      onClick={() => handleStatusToggle(a)}
                      disabled={!canEdit}
                      style={{ background: 'none', border: 'none', cursor: canEdit ? 'pointer' : 'default', padding: 0, flexShrink: 0 }}
                    >
                      {isDone
                        ? <CheckCircle2 size={18} color={statusColor} />
                        : <Circle size={18} color={statusColor} strokeWidth={2} />
                      }
                    </button>

                    {/* Content */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{
                          fontSize: 13, fontWeight: 600,
                          color: isDone ? 'var(--text-faint)' : 'var(--text-primary)',
                          textDecoration: isDone ? 'line-through' : 'none',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{a.title}</span>
                        {a.priority > 0 && (
                          <span style={{
                            fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 6,
                            background: 'rgba(245,158,11,0.15)', color: '#d97706',
                          }}>★</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
                        {a.place_name && (
                          <button
                            onClick={() => a.lat && a.lng && onActivityClick?.(a.lat, a.lng, a.title)}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 3,
                              background: 'none', border: 'none', cursor: a.lat ? 'pointer' : 'default',
                              padding: 0, color: a.lat ? '#6366f1' : 'var(--text-faint)',
                            }}
                          >
                            <MapPin size={10} />
                            <span style={{ fontSize: 10, fontWeight: 500 }}>{a.place_name}</span>
                          </button>
                        )}
                        {a.duration_minutes > 0 && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 10, color: 'var(--text-faint)' }}>
                            <Clock size={10} />{a.duration_minutes} min
                          </span>
                        )}
                        {a.planned_date && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 10, color: 'var(--text-faint)' }}>
                            <Calendar size={10} />{new Date(a.planned_date + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      {a.description && (
                        <button onClick={() => setExpandedId(isExpanded ? null : a.id)} style={{
                          background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-faint)',
                        }}>
                          {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </button>
                      )}
                      {canEdit && (
                        <>
                          <button onClick={() => openEdit(a)} style={{
                            background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-faint)',
                          }}>
                            <Edit2 size={13} />
                          </button>
                          <button onClick={() => handleDelete(a.id)} style={{
                            background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-faint)',
                          }}>
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {isExpanded && a.description && (
                    <div style={{
                      padding: '0 12px 10px 40px',
                      fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5,
                      borderTop: '1px solid var(--border-faint)',
                      paddingTop: 8,
                    }}>
                      {a.description}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
