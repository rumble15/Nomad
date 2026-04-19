import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Mic, MicOff, PhoneCall, PhoneOff, Volume2, VolumeX, Users } from 'lucide-react'
import { addListener, removeListener } from '../../api/websocket'

interface Participant {
  socketId: number
  userId: number
  username: string
  muted?: boolean
  stream?: MediaStream
}

interface VoiceChatProps {
  tripId: number
  currentUser: { id: number; username: string } | null
  sendWsMessage: (msg: Record<string, unknown>) => void
}

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

export default function VoiceChat({ tripId, currentUser, sendWsMessage }: VoiceChatProps) {
  const [inCall, setInCall] = useState(false)
  const [muted, setMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  const localStreamRef = useRef<MediaStream | null>(null)
  const peerConnections = useRef<Map<number, RTCPeerConnection>>(new Map())
  const audioRefs = useRef<Map<number, HTMLAudioElement>>(new Map())
  const mySocketIdRef = useRef<number | null>(null)

  // Get our socket ID from the welcome message
  useEffect(() => {
    const handler = (event: Record<string, unknown>) => {
      if (event.type === 'welcome') mySocketIdRef.current = event.socketId as number
    }
    addListener(handler)
    return () => removeListener(handler)
  }, [])

  const createPeerConnection = useCallback((remoteSocketId: number, remoteUserId: number, remoteUsername: string) => {
    if (peerConnections.current.has(remoteSocketId)) return peerConnections.current.get(remoteSocketId)!

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendWsMessage({
          type: 'rtc:ice',
          tripId,
          targetSocketId: remoteSocketId,
          payload: e.candidate,
        })
      }
    }

    pc.ontrack = (e) => {
      const stream = e.streams[0]
      setParticipants(prev => prev.map(p =>
        p.socketId === remoteSocketId ? { ...p, stream } : p
      ))
      // Play audio
      let audio = audioRefs.current.get(remoteSocketId)
      if (!audio) {
        audio = new Audio()
        audio.autoplay = true
        audioRefs.current.set(remoteSocketId, audio)
      }
      audio.srcObject = stream
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        peerConnections.current.delete(remoteSocketId)
        setParticipants(prev => prev.filter(p => p.socketId !== remoteSocketId))
      }
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!)
      })
    }

    peerConnections.current.set(remoteSocketId, pc)
    return pc
  }, [tripId, sendWsMessage])

  const cleanupPeer = useCallback((socketId: number) => {
    const pc = peerConnections.current.get(socketId)
    if (pc) { pc.close(); peerConnections.current.delete(socketId) }
    const audio = audioRefs.current.get(socketId)
    if (audio) { audio.srcObject = null; audioRefs.current.delete(socketId) }
  }, [])

  // Handle incoming WebRTC signaling
  useEffect(() => {
    if (!inCall) return
    const handler = async (event: Record<string, unknown>) => {
      const tripIdStr = String(tripId)
      if (String(event.tripId) !== tripIdStr) return

      if (event.type === 'rtc:join') {
        // A new user joined - initiate offer to them
        const remoteSocketId = event.fromSocketId as number
        const remoteUserId = event.fromUserId as number
        const remoteUsername = event.fromUsername as string
        if (remoteSocketId === mySocketIdRef.current) return
        setParticipants(prev => prev.some(p => p.socketId === remoteSocketId) ? prev : [
          ...prev,
          { socketId: remoteSocketId, userId: remoteUserId, username: remoteUsername },
        ])
        const pc = createPeerConnection(remoteSocketId, remoteUserId, remoteUsername)
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        sendWsMessage({
          type: 'rtc:offer',
          tripId,
          targetSocketId: remoteSocketId,
          payload: offer,
        })
      }

      if (event.type === 'rtc:leave') {
        const remoteSocketId = event.fromSocketId as number
        cleanupPeer(remoteSocketId)
        setParticipants(prev => prev.filter(p => p.socketId !== remoteSocketId))
      }

      if (event.type === 'rtc:offer') {
        const remoteSocketId = event.fromSocketId as number
        const remoteUserId = event.fromUserId as number
        const remoteUsername = event.fromUsername as string
        setParticipants(prev => prev.some(p => p.socketId === remoteSocketId) ? prev : [
          ...prev,
          { socketId: remoteSocketId, userId: remoteUserId, username: remoteUsername },
        ])
        const pc = createPeerConnection(remoteSocketId, remoteUserId, remoteUsername)
        await pc.setRemoteDescription(event.payload as RTCSessionDescriptionInit)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        sendWsMessage({
          type: 'rtc:answer',
          tripId,
          targetSocketId: remoteSocketId,
          payload: answer,
        })
      }

      if (event.type === 'rtc:answer') {
        const remoteSocketId = event.fromSocketId as number
        const pc = peerConnections.current.get(remoteSocketId)
        if (pc && pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(event.payload as RTCSessionDescriptionInit)
        }
      }

      if (event.type === 'rtc:ice') {
        const remoteSocketId = event.fromSocketId as number
        const pc = peerConnections.current.get(remoteSocketId)
        if (pc) {
          try { await pc.addIceCandidate(event.payload as RTCIceCandidateInit) } catch {}
        }
      }
    }
    addListener(handler)
    return () => removeListener(handler)
  }, [inCall, tripId, createPeerConnection, cleanupPeer, sendWsMessage])

  const joinCall = useCallback(async () => {
    setError(null)
    setConnecting(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      localStreamRef.current = stream
      setInCall(true)
      setConnecting(false)
      sendWsMessage({ type: 'rtc:join', tripId })
    } catch (err: unknown) {
      setConnecting(false)
      setError('Mikrofon-Zugriff verweigert')
    }
  }, [tripId, sendWsMessage])

  const leaveCall = useCallback(() => {
    sendWsMessage({ type: 'rtc:leave', tripId })
    // Stop local stream
    localStreamRef.current?.getTracks().forEach(t => t.stop())
    localStreamRef.current = null
    // Close all peer connections
    for (const [sid] of peerConnections.current) cleanupPeer(sid)
    peerConnections.current.clear()
    setParticipants([])
    setInCall(false)
    setMuted(false)
    setDeafened(false)
  }, [tripId, sendWsMessage, cleanupPeer])

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return
    const enabled = !muted
    localStreamRef.current.getAudioTracks().forEach(t => { t.enabled = enabled })
    setMuted(!muted)
  }, [muted])

  const toggleDeafen = useCallback(() => {
    const next = !deafened
    setDeafened(next)
    for (const [, audio] of audioRefs.current) {
      audio.muted = next
    }
  }, [deafened])

  // Cleanup on unmount
  useEffect(() => () => { if (inCall) leaveCall() }, [])

  if (!inCall) {
    return (
      <div style={{
        padding: '12px 16px',
        borderTop: '1px solid var(--border-faint)',
        background: 'var(--bg-card)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <PhoneCall size={13} color="white" />
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>Voice Chat</div>
              {error && <div style={{ fontSize: 10, color: '#ef4444' }}>{error}</div>}
              {!error && <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>Klicke um beizutreten</div>}
            </div>
          </div>
          <button
            onClick={joinCall}
            disabled={connecting}
            style={{
              padding: '6px 14px', borderRadius: 16, border: 'none',
              background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
              color: 'white', cursor: connecting ? 'default' : 'pointer',
              fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
              opacity: connecting ? 0.7 : 1,
              display: 'flex', alignItems: 'center', gap: 5,
            }}
          >
            <Mic size={12} />
            {connecting ? 'Verbinde…' : 'Beitreten'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      padding: '10px 14px',
      borderTop: '1px solid var(--border-faint)',
      background: 'linear-gradient(135deg, rgba(34,197,94,0.08) 0%, rgba(22,163,74,0.06) 100%)',
      flexShrink: 0,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: '#22c55e',
            boxShadow: '0 0 0 3px rgba(34,197,94,0.25)',
            animation: 'pulse-green 2s infinite',
          }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: '#16a34a' }}>LIVE · Voice</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={toggleMute} title={muted ? 'Stummschaltung aufheben' : 'Stumm schalten'} style={{
            width: 28, height: 28, borderRadius: '50%', border: 'none', cursor: 'pointer',
            background: muted ? '#ef4444' : 'var(--bg-hover)',
            color: muted ? 'white' : 'var(--text-secondary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {muted ? <MicOff size={12} /> : <Mic size={12} />}
          </button>
          <button onClick={toggleDeafen} title={deafened ? 'Ton einschalten' : 'Ton ausschalten'} style={{
            width: 28, height: 28, borderRadius: '50%', border: 'none', cursor: 'pointer',
            background: deafened ? '#6366f1' : 'var(--bg-hover)',
            color: deafened ? 'white' : 'var(--text-secondary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {deafened ? <VolumeX size={12} /> : <Volume2 size={12} />}
          </button>
          <button onClick={leaveCall} title="Anruf beenden" style={{
            width: 28, height: 28, borderRadius: '50%', border: 'none', cursor: 'pointer',
            background: '#ef4444', color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <PhoneOff size={12} />
          </button>
        </div>
      </div>

      {/* Participants */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {/* Self */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 12, background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)' }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: muted ? '#9ca3af' : '#22c55e' }} />
          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-primary)' }}>{currentUser?.username}</span>
          {muted && <MicOff size={9} color="#9ca3af" />}
        </div>
        {/* Others */}
        {participants.map(p => (
          <div key={p.socketId} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px', borderRadius: 12, background: 'var(--bg-hover)', border: '1px solid var(--border-faint)' }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e' }} />
            <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-secondary)' }}>{p.username}</span>
          </div>
        ))}
        {participants.length === 0 && (
          <div style={{ fontSize: 10, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Users size={10} />Warte auf andere…
          </div>
        )}
      </div>
      <style>{`
        @keyframes pulse-green {
          0%, 100% { box-shadow: 0 0 0 3px rgba(34,197,94,0.25); }
          50% { box-shadow: 0 0 0 6px rgba(34,197,94,0.12); }
        }
      `}</style>
    </div>
  )
}
