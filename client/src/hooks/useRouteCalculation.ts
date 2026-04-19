import { useState, useCallback, useRef, useEffect } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { calculateRoute, calculateSegments } from '../components/Map/RouteCalculator'
import type { TripStoreState } from '../store/tripStore'
import type { RouteSegment, RouteResult } from '../types'

/**
 * Manages route calculation state for a selected day. Extracts geo-coded waypoints from
 * day assignments, draws the shortest-path road route via OSRM, and fetches per-segment
 * driving/walking durations. Aborts in-flight requests when the day changes.
 */
export function useRouteCalculation(tripStore: TripStoreState, selectedDayId: number | null) {
  const [route, setRoute] = useState<[number, number][] | null>(null)
  const [routeInfo, setRouteInfo] = useState<RouteResult | null>(null)
  const [routeSegments, setRouteSegments] = useState<RouteSegment[]>([])
  const routeCalcEnabled = useSettingsStore((s) => s.settings.route_calculation) !== false
  const routeAbortRef = useRef<AbortController | null>(null)
  // Keep a ref to the latest tripStore so updateRouteForDay never has a stale closure
  const tripStoreRef = useRef(tripStore)
  tripStoreRef.current = tripStore

  const updateRouteForDay = useCallback(async (dayId: number | null) => {
    if (routeAbortRef.current) routeAbortRef.current.abort()
    if (!dayId) { setRoute(null); setRouteSegments([]); return }
    const currentAssignments = tripStoreRef.current.assignments || {}
    const da = (currentAssignments[String(dayId)] || []).slice().sort((a, b) => a.order_index - b.order_index)
    const waypoints = da.map((a) => a.place).filter((p) => p?.lat && p?.lng)
    if (waypoints.length < 2) { setRoute(null); setRouteSegments([]); return }
    // Show straight-line immediately as a fallback
    setRoute(waypoints.map((p) => [p.lat!, p.lng!]))
    if (!routeCalcEnabled) { setRouteSegments([]); return }
    const controller = new AbortController()
    routeAbortRef.current = controller
    try {
      // Fetch actual road route and segment durations in parallel
      const [routeResult, segments] = await Promise.all([
        calculateRoute(waypoints as { lat: number; lng: number }[], 'driving', { signal: controller.signal }),
        calculateSegments(waypoints as { lat: number; lng: number }[], { signal: controller.signal }),
      ])
      if (!controller.signal.aborted) {
        setRoute(routeResult.coordinates)
        setRouteInfo(routeResult)
        setRouteSegments(segments)
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') setRouteSegments([])
      else if (!(err instanceof Error)) setRouteSegments([])
    }
  }, [routeCalcEnabled])

  // Only recalculate when assignments for the SELECTED day change
  const selectedDayAssignments = selectedDayId ? tripStore.assignments?.[String(selectedDayId)] : null
  useEffect(() => {
    if (!selectedDayId) { setRoute(null); setRouteSegments([]); return }
    updateRouteForDay(selectedDayId)
  }, [selectedDayId, selectedDayAssignments])

  return { route, routeSegments, routeInfo, setRoute, setRouteInfo, updateRouteForDay }
}
