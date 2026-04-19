import React, { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useTripStore } from '../store/tripStore'
import { tripsApi, daysApi, placesApi } from '../api/client'
import Navbar from '../components/Layout/Navbar'
import PhotoGallery from '../components/Photos/PhotoGallery'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from '../i18n'
import type { Trip, Day, Place, Photo } from '../types'

export default function PhotosPage(): React.ReactElement {
  const { t } = useTranslation()
  const { id: tripId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const tripStore = useTripStore()

  const [trip, setTrip] = useState<Trip | null>(null)
  const [days, setDays] = useState<Day[]>([])
  const [places, setPlaces] = useState<Place[]>([])
  const [photos, setPhotos] = useState<Photo[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)

  useEffect(() => {
    loadData()
  }, [tripId])

  const loadData = async (): Promise<void> => {
    setIsLoading(true)
    try {
      const [tripData, daysData, placesData] = await Promise.all([
        tripsApi.get(tripId),
        daysApi.list(tripId),
        placesApi.list(tripId),
      ])
      setTrip(tripData.trip)
      setDays(daysData.days)
      setPlaces(placesData.places)

      // Load photos
      await tripStore.loadPhotos(tripId)
    } catch (err: unknown) {
      navigate('/dashboard')
    } finally {
      setIsLoading(false)
    }
  }

  // Sync photos from store
  useEffect(() => {
    setPhotos(tripStore.photos)
  }, [tripStore.photos])

  const handleUpload = async (formData: FormData): Promise<void> => {
    await tripStore.addPhoto(tripId, formData)
  }

  const handleDelete = async (photoId: number): Promise<void> => {
    await tripStore.deletePhoto(tripId, photoId)
  }

  const handleUpdate = async (photoId: number, data: Record<string, string | number | null>): Promise<void> => {
    await tripStore.updatePhoto(tripId, photoId, data)
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
        <div className="w-10 h-10 border-4 rounded-full animate-spin" style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--text-primary)' }}></div>
      </div>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <Navbar tripTitle={trip?.name} tripId={tripId} showBack onBack={() => navigate(`/trips/${tripId}`)} />

      <div style={{ paddingTop: 'var(--nav-h)' }}>
        <div className="max-w-7xl mx-auto px-4 py-6">
          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <Link
              to={`/trips/${tripId}`}
              className="flex items-center gap-1 text-sm transition-colors"
              style={{ color: 'var(--text-muted)' }}
            >
              <ArrowLeft className="w-4 h-4" />
              {t('common.backToPlanning')}
            </Link>
          </div>

          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('photos.title')}</h1>
              <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>{photos.length === 1 ? t('photos.count', { count: photos.length }) : t('photos.countPlural', { count: photos.length })} — {trip?.name}</p>
            </div>
          </div>

          <PhotoGallery
            photos={photos}
            onUpload={handleUpload}
            onDelete={handleDelete}
            onUpdate={handleUpdate}
            places={places}
            days={days}
            tripId={tripId}
          />
        </div>
      </div>
    </div>
  )
}
