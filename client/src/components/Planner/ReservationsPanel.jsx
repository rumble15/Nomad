import React, { useState, useMemo } from 'react'
import ReactDOM from 'react-dom'
import { useTripStore } from '../../store/tripStore'
import { useSettingsStore } from '../../store/settingsStore'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { CustomDateTimePicker } from '../shared/CustomDateTimePicker'
import CustomSelect from '../shared/CustomSelect'
import {
  Plane, Hotel, Utensils, Train, Car, Ship, Ticket, FileText, MapPin,
  Calendar, Hash, CheckCircle2, Circle, Pencil, Trash2, Plus, ChevronDown, ChevronRight, MapPinned, X, Users,
  ExternalLink, BookMarked, Lightbulb,
} from 'lucide-react'

const TYPE_OPTIONS = [
  { value: 'flight',      labelKey: 'reservations.type.flight',      Icon: Plane },
  { value: 'hotel',       labelKey: 'reservations.type.hotel',       Icon: Hotel },
  { value: 'restaurant',  labelKey: 'reservations.type.restaurant',  Icon: Utensils },
  { value: 'train',       labelKey: 'reservations.type.train',       Icon: Train },
  { value: 'car',         labelKey: 'reservations.type.car',         Icon: Car },
  { value: 'cruise',      labelKey: 'reservations.type.cruise',      Icon: Ship },
  { value: 'event',       labelKey: 'reservations.type.event',       Icon: Ticket },
  { value: 'tour',        labelKey: 'reservations.type.tour',        Icon: Users },
  { value: 'other',       labelKey: 'reservations.type.other',       Icon: FileText },
]

function typeIcon(type) {
  return (TYPE_OPTIONS.find(t => t.value === type) || TYPE_OPTIONS[TYPE_OPTIONS.length - 1]).Icon
}
function typeLabelKey(type) {
  return (TYPE_OPTIONS.find(t => t.value === type) || TYPE_OPTIONS[TYPE_OPTIONS.length - 1]).labelKey
}

function formatDateTimeWithLocale(str, locale, timeFormat) {
  if (!str) return null
  const d = new Date(str)
  if (isNaN(d)) return str
  const datePart = d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'long' })
  const h = d.getHours(), m = d.getMinutes()
  let timePart
  if (timeFormat === '12h') {
    const period = h >= 12 ? 'PM' : 'AM'
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
    timePart = `${h12}:${String(m).padStart(2, '0')} ${period}`
  } else {
    timePart = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    if (locale?.startsWith('de')) timePart += ' Uhr'
  }
  return `${datePart} · ${timePart}`
}

const inputStyle = {
  width: '100%', border: '1px solid var(--border-primary)', borderRadius: 10,
  padding: '8px 12px', fontSize: 13.5, fontFamily: 'inherit',
  outline: 'none', boxSizing: 'border-box', color: 'var(--text-primary)', background: 'var(--bg-card)',
}
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }

function PlaceReservationEditModal({ item, tripId, onClose }) {
  const { updatePlace } = useTripStore()
  const toast = useToast()
  const { t } = useTranslation()
  const [form, setForm] = useState({
    reservation_status: item.status === 'confirmed' ? 'confirmed' : 'pending',
    reservation_datetime: item.reservation_time ? item.reservation_time.slice(0, 16) : '',
    place_time: item.place_time || '',
    reservation_notes: item.notes || '',
  })
  const [saving, setSaving] = useState(false)

  const set = (f, v) => setForm(p => ({ ...p, [f]: v }))

  const handleSave = async () => {
    setSaving(true)
    try {
      await updatePlace(tripId, item.placeId, {
        reservation_status: form.reservation_status,
        reservation_datetime: form.reservation_datetime || null,
        place_time: form.place_time || null,
        reservation_notes: form.reservation_notes || null,
      })
      toast.success(t('reservations.toast.updated'))
      onClose()
    } catch {
      toast.error(t('reservations.toast.saveError'))
    } finally {
      setSaving(false)
    }
  }

  return ReactDOM.createPortal(
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-card)', borderRadius: 18, padding: 24, width: '100%', maxWidth: 420,
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{t('reservations.editTitle')}</h3>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>{item.title}</p>
          </div>
          <button onClick={onClose} style={{ background: 'var(--bg-tertiary)', border: 'none', borderRadius: '50%', width: 30, height: 30, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <X size={14} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>{t('reservations.status')}</label>
            <CustomSelect
              value={form.reservation_status}
              onChange={v => set('reservation_status', v)}
              options={[
                { value: 'pending', label: t('reservations.pending') },
                { value: 'confirmed', label: t('reservations.confirmed') },
              ]}
            />
          </div>

          <div>
            <label style={labelStyle}>{t('reservations.datetime')}</label>
            <CustomDateTimePicker value={form.reservation_datetime} onChange={v => set('reservation_datetime', v)} />
          </div>


          <div>
            <label style={labelStyle}>{t('reservations.notes')}</label>
            <textarea value={form.reservation_notes} onChange={e => set('reservation_notes', e.target.value)} rows={3} placeholder={t('reservations.notesPlaceholder')} style={{ ...inputStyle, resize: 'none', lineHeight: 1.5 }} />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-secondary)' }}>
          <button onClick={onClose} style={{ padding: '8px 16px', borderRadius: 10, border: '1px solid var(--border-primary)', background: 'var(--bg-card)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-secondary)' }}>
            {t('common.cancel')}
          </button>
          <button onClick={handleSave} disabled={saving} style={{ padding: '8px 20px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'white', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', opacity: saving ? 0.6 : 1 }}>
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function ReservationCard({ r, tripId, onEdit, onDelete, files = [], onNavigateToFiles }) {
  const { toggleReservationStatus } = useTripStore()
  const toast = useToast()
  const { t, locale } = useTranslation()
  const timeFormat = useSettingsStore(s => s.settings.time_format) || '24h'
  const TypeIcon = typeIcon(r.type)
  const confirmed = r.status === 'confirmed'
  const attachedFiles = files.filter(f => f.reservation_id === r.id)

  const handleToggle = async () => {
    try { await toggleReservationStatus(tripId, r.id) }
    catch { toast.error(t('reservations.toast.updateError')) }
  }
  const handleDelete = async () => {
    if (!confirm(t('reservations.confirm.delete', { name: r.title }))) return
    try { await onDelete(r.id) } catch { toast.error(t('reservations.toast.deleteError')) }
  }

  return (
    <div style={{ background: 'var(--bg-card)', borderRadius: 14, border: '1px solid var(--border-faint)', boxShadow: '0 1px 6px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        <div style={{
          width: 44, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: confirmed ? 'rgba(22,163,74,0.1)' : 'rgba(161,98,7,0.1)',
          borderRight: `1px solid ${confirmed ? 'rgba(22,163,74,0.2)' : 'rgba(161,98,7,0.2)'}`,
        }}>
          <TypeIcon size={16} style={{ color: confirmed ? '#16a34a' : '#a16207' }} />
        </div>

        <div style={{ flex: 1, padding: '11px 13px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text-primary)', lineHeight: 1.3 }}>{r.title}</div>
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 1 }}>{t(typeLabelKey(r.type))}</div>
            </div>
            <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
              <button onClick={handleToggle} style={{
                display: 'flex', alignItems: 'center', gap: 3, padding: '3px 8px', borderRadius: 99,
                border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 500,
                background: confirmed ? 'rgba(22,163,74,0.12)' : 'rgba(161,98,7,0.12)',
                color: confirmed ? '#16a34a' : '#a16207',
              }}>
                {confirmed ? <><CheckCircle2 size={11} /> {t('reservations.confirmed')}</> : <><Circle size={11} /> {t('reservations.pending')}</>}
              </button>
              <button onClick={() => onEdit(r)} style={{ padding: 5, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', borderRadius: 6, display: 'flex' }}><Pencil size={12} /></button>
              <button onClick={handleDelete} style={{ padding: 5, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', borderRadius: 6, display: 'flex' }}><Trash2 size={12} /></button>
            </div>
          </div>

          <div style={{ marginTop: 7, display: 'flex', flexWrap: 'wrap', gap: '3px 10px' }}>
            {r.reservation_time && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                <Calendar size={10} style={{ color: 'var(--text-faint)' }} />{formatDateTimeWithLocale(r.reservation_time, locale, timeFormat)}
              </div>
            )}
            {r.location && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                <MapPin size={10} style={{ color: 'var(--text-faint)' }} />
                <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.location}</span>
              </div>
            )}
          </div>

          <div style={{ marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {r.confirmation_number && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, color: '#16a34a', background: 'rgba(22,163,74,0.1)', border: '1px solid rgba(22,163,74,0.2)', borderRadius: 99, padding: '1px 7px', fontWeight: 600 }}>
                <Hash size={8} />{r.confirmation_number}
              </span>
            )}
            {r.day_number != null && <span style={{ fontSize: 10.5, color: 'var(--text-muted)', background: 'var(--bg-tertiary)', borderRadius: 99, padding: '1px 7px' }}>{t('dayplan.dayN', { n: r.day_number })}</span>}
            {r.place_name && <span style={{ fontSize: 10.5, color: 'var(--text-muted)', background: 'var(--bg-tertiary)', borderRadius: 99, padding: '1px 7px' }}>{r.place_name}</span>}
          </div>

          {r.notes && <p style={{ margin: '7px 0 0', fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5, borderTop: '1px solid var(--border-secondary)', paddingTop: 7 }}>{r.notes}</p>}

          {/* Attached files — read-only, upload only via edit modal */}
          {attachedFiles.length > 0 && (
            <div style={{ marginTop: 8, borderTop: '1px solid var(--border-secondary)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {attachedFiles.map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <FileText size={11} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                  <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.original_name}</span>
                  <a href={f.url} target="_blank" rel="noreferrer" style={{ display: 'flex', color: 'var(--text-faint)', flexShrink: 0 }} title={t('common.open')}>
                    <ExternalLink size={11} />
                  </a>
                </div>
              ))}
              <button onClick={onNavigateToFiles} style={{ alignSelf: 'flex-start', fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline', fontFamily: 'inherit' }}>
                {t('reservations.showFiles')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PlaceReservationCard({ item, tripId, files = [], onNavigateToFiles }) {
  const { updatePlace } = useTripStore()
  const toast = useToast()
  const { t, locale } = useTranslation()
  const timeFormat = useSettingsStore(s => s.settings.time_format) || '24h'
  const [editing, setEditing] = useState(false)
  const confirmed = item.status === 'confirmed'
  const placeFiles = files.filter(f => f.place_id === item.placeId)

  const handleDelete = async () => {
    if (!confirm(t('reservations.confirm.remove', { name: item.title }))) return
    try {
      await updatePlace(tripId, item.placeId, {
        reservation_status: 'none',
        reservation_datetime: null,
        place_time: null,
        reservation_notes: null,
      })
      toast.success(t('reservations.toast.removed'))
    } catch { toast.error(t('reservations.toast.deleteError')) }
  }

  return (
    <>
      {editing && <PlaceReservationEditModal item={item} tripId={tripId} onClose={() => setEditing(false)} />}
      <div style={{ background: 'var(--bg-card)', borderRadius: 14, border: '1px solid var(--border-faint)', boxShadow: '0 1px 6px rgba(0,0,0,0.05)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'stretch' }}>
          <div style={{
            width: 44, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: confirmed ? 'rgba(22,163,74,0.1)' : 'rgba(161,98,7,0.1)',
            borderRight: `1px solid ${confirmed ? 'rgba(22,163,74,0.2)' : 'rgba(161,98,7,0.2)'}`,
          }}>
            <MapPinned size={16} style={{ color: confirmed ? '#16a34a' : '#a16207' }} />
          </div>

          <div style={{ flex: 1, padding: '11px 13px', minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text-primary)', lineHeight: 1.3 }}>{item.title}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, flexWrap: 'nowrap', overflow: 'hidden' }}>
                  <span className="hidden sm:inline" style={{ fontSize: 10.5, color: 'var(--text-faint)', flexShrink: 0 }}>{t('reservations.fromPlan')}</span>
                  {item.dayLabel && <span style={{ fontSize: 10.5, color: 'var(--text-muted)', background: 'var(--bg-tertiary)', borderRadius: 99, padding: '0 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.dayLabel}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                <span style={{
                  display: 'flex', alignItems: 'center', gap: 3, padding: '3px 8px', borderRadius: 99,
                  fontSize: 11, fontWeight: 500,
                  background: confirmed ? 'rgba(22,163,74,0.12)' : 'rgba(161,98,7,0.12)',
                  color: confirmed ? '#16a34a' : '#a16207',
                }}>
                  {confirmed ? <><CheckCircle2 size={11} /> {t('reservations.confirmed')}</> : <><Circle size={11} /> {t('reservations.pending')}</>}
                </span>
                <button onClick={() => setEditing(true)} style={{ padding: 5, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', borderRadius: 6, display: 'flex' }}><Pencil size={12} /></button>
                <button onClick={handleDelete} style={{ padding: 5, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', borderRadius: 6, display: 'flex' }}><Trash2 size={12} /></button>
              </div>
            </div>

            <div style={{ marginTop: 7, display: 'flex', flexWrap: 'wrap', gap: '3px 10px' }}>
              {item.reservation_time && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  <Calendar size={10} style={{ color: 'var(--text-faint)' }} />{formatDateTimeWithLocale(item.reservation_time, locale, timeFormat)}
                </div>
              )}
              {item.place_time && !item.reservation_time && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  <Calendar size={10} style={{ color: 'var(--text-faint)' }} />{item.place_time}
                </div>
              )}
              {item.location && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  <MapPin size={10} style={{ color: 'var(--text-faint)' }} />
                  <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.location}</span>
                </div>
              )}
            </div>

            {item.notes && <p style={{ margin: '7px 0 0', fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5, borderTop: '1px solid var(--border-secondary)', paddingTop: 7 }}>{item.notes}</p>}

            {/* Files attached to the place */}
            {placeFiles.length > 0 && (
              <div style={{ marginTop: 8, borderTop: '1px solid var(--border-secondary)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {placeFiles.map(f => (
                  <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <FileText size={11} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
                    <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.original_name}</span>
                    <a href={f.url} target="_blank" rel="noreferrer" style={{ display: 'flex', color: 'var(--text-faint)', flexShrink: 0 }} title={t('common.open')}>
                      <ExternalLink size={11} />
                    </a>
                  </div>
                ))}
                {onNavigateToFiles && (
                  <button onClick={onNavigateToFiles} style={{ alignSelf: 'flex-start', fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline', fontFamily: 'inherit' }}>
                    {t('reservations.showFiles')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

function Section({ title, count, children, defaultOpen = true, accent }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ marginBottom: 24 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', marginBottom: 10,
      }}>
        {open ? <ChevronDown size={15} style={{ color: 'var(--text-faint)' }} /> : <ChevronRight size={15} style={{ color: 'var(--text-faint)' }} />}
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{title}</span>
        <span style={{
          fontSize: 11, fontWeight: 600, padding: '1px 8px', borderRadius: 99,
          background: accent === 'green' ? 'rgba(22,163,74,0.12)' : 'var(--bg-tertiary)',
          color: accent === 'green' ? '#16a34a' : 'var(--text-muted)',
        }}>{count}</span>
      </button>
      {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>}
    </div>
  )
}

export default function ReservationsPanel({ tripId, reservations, days, assignments, files = [], onAdd, onEdit, onDelete, onNavigateToFiles }) {
  const { t, locale } = useTranslation()
  const [showHint, setShowHint] = useState(() => !localStorage.getItem('hideReservationHint'))

  const placeReservations = useMemo(() => {
    const result = []
    for (const day of (days || [])) {
      const da = (assignments?.[String(day.id)] || []).slice().sort((a, b) => a.order_index - b.order_index)
      for (const assignment of da) {
        const place = assignment.place
        if (!place || !place.reservation_status || place.reservation_status === 'none') continue
        const dayLabel = day.title
          ? day.title
          : day.date
            ? `${t('dayplan.dayN', { n: day.day_number })} · ${new Date(day.date + 'T00:00:00').toLocaleDateString(locale, { day: 'numeric', month: 'short' })}`
            : t('dayplan.dayN', { n: day.day_number })
        result.push({
          _placeRes: true,
          id: `place_${day.id}_${place.id}`,
          placeId: place.id,
          title: place.name,
          status: place.reservation_status === 'confirmed' ? 'confirmed' : 'pending',
          reservation_time: place.reservation_datetime || null,
          place_time: place.place_time || null,
          location: place.address || null,
          notes: place.reservation_notes || null,
          dayLabel,
        })
      }
    }
    return result
  }, [days, assignments, locale])

  const allPending   = [...reservations.filter(r => r.status !== 'confirmed'), ...placeReservations.filter(r => r.status !== 'confirmed')]
  const allConfirmed = [...reservations.filter(r => r.status === 'confirmed'),  ...placeReservations.filter(r => r.status === 'confirmed')]
  const total = allPending.length + allConfirmed.length

  function renderCard(r) {
    if (r._placeRes) return <PlaceReservationCard key={r.id} item={r} tripId={tripId} files={files} onNavigateToFiles={onNavigateToFiles} />
    return <ReservationCard key={r.id} r={r} tripId={tripId} onEdit={onEdit} onDelete={onDelete} files={files} onNavigateToFiles={onNavigateToFiles} />
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif" }}>
      <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>{t('reservations.title')}</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-faint)' }}>
            {total === 0 ? t('reservations.empty') : t('reservations.summary', { confirmed: allConfirmed.length, pending: allPending.length })}
          </p>
        </div>
        <button onClick={onAdd} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 99,
          border: 'none', background: 'var(--accent)', color: 'var(--accent-text)',
          fontSize: 12.5, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
        }}>
          <Plus size={13} /> <span className="hidden sm:inline">{t('reservations.addManual')}</span>
        </button>
      </div>

      {/* Hinweis — einmalig wegklickbar */}
      {showHint && (
        <div style={{ margin: '12px 24px 8px', padding: '8px 12px', borderRadius: 10, background: 'var(--bg-hover)', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <Lightbulb size={13} style={{ flexShrink: 0, marginTop: 1, color: 'var(--text-faint)' }} />
          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5, flex: 1 }}>
            {t('reservations.placeHint')}
          </p>
          <button
            onClick={() => { setShowHint(false); localStorage.setItem('hideReservationHint', '1') }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', color: 'var(--text-faint)', fontSize: 16, lineHeight: 1, flexShrink: 0 }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-faint)'}
          >×</button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        {total === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <BookMarked size={40} style={{ marginBottom: 12, color: 'var(--text-faint)', display: 'block', margin: '0 auto 12px' }} />
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)', margin: '0 0 4px' }}>{t('reservations.empty')}</p>
            <p style={{ fontSize: 13, color: 'var(--text-faint)', margin: 0 }}>{t('reservations.emptyHint')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {allPending.length > 0 && (
              <Section title={t('reservations.pending')} count={allPending.length} defaultOpen={true} accent="gray">
                {allPending.map(renderCard)}
              </Section>
            )}
            {allConfirmed.length > 0 && (
              <Section title={t('reservations.confirmed')} count={allConfirmed.length} defaultOpen={true} accent="green">
                {allConfirmed.map(renderCard)}
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
