import { useState, useEffect, useRef, useMemo } from 'react';
import type { Channel, ScheduleProgram } from '../../types';
import { useSchedule } from '../../hooks/useSchedule';
import { getProgramDetails, getBackgroundMusicList } from '../../services/api';
import type { ProgramDetails } from '../../services/api';
import './Player.css';

// Singleton: only one InterstitialScreen plays music at a time.
// When a new instance claims ownership, the previous one is stopped.
let activeAudio: HTMLAudioElement | null = null;
let activeOwnerId: number = 0;

function claimAudio(ownerId: number, audio: HTMLAudioElement): void {
  if (activeAudio && activeAudio !== audio) {
    activeAudio.pause();
    activeAudio.src = '';
  }
  activeAudio = audio;
  activeOwnerId = ownerId;
}

function releaseAudio(ownerId: number): void {
  if (activeOwnerId === ownerId) {
    activeAudio = null;
    activeOwnerId = 0;
  }
}

interface InterstitialScreenProps {
  channel: Channel;
  program: ScheduleProgram;
  nextProgram: ScheduleProgram | null;
  /** Disable background music (e.g. when embedded in Guide preview) */
  disableMusic?: boolean;
}

type Phase = 'ident' | 'hero' | 'lineup' | 'spotlight';

const PHASE_DURATIONS: Record<Phase, number> = {
  ident: 2000,
  hero: 8000,
  lineup: 8000,
  spotlight: 8000,
};

const CAROUSEL_INTERVAL = 5000;
const COUNTDOWN_INTERVAL = 1000;
const SHORT_THRESHOLD = 120000; // 2 min — hero only
const MINIMAL_THRESHOLD = 30000; // 30s — countdown only

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'NOW';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatRuntime(durationMs: number): string {
  const totalMinutes = Math.round(durationMs / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function getTimeOfDayContext(): { greeting: string; period: string } {
  const hour = new Date().getHours();
  if (hour < 5) return { greeting: 'LATE NIGHT', period: 'LATE NIGHT' };
  if (hour < 12) return { greeting: 'GOOD MORNING', period: 'THIS MORNING' };
  if (hour < 17) return { greeting: 'GOOD AFTERNOON', period: 'THIS AFTERNOON' };
  if (hour < 21) return { greeting: 'GOOD EVENING', period: 'THIS EVENING' };
  return { greeting: 'LATE NIGHT', period: 'TONIGHT' };
}

const GENRE_ICONS: Record<string, string> = {
  'Action': '\u2694',
  'Adventure': '\u2604',
  'Comedy': '\u263A',
  'Drama': '\u2606',
  'Horror': '\u2620',
  'Science Fiction': '\u2604',
  'Sci-Fi': '\u2604',
  'Romance': '\u2665',
  'Thriller': '\u26A1',
  'Documentary': '\u2139',
  'Mystery': '\u2623',
  'Fantasy': '\u2728',
  'Animation': '\u25C6',
  'Crime': '\u2622',
  'War': '\u2694',
  'Music': '\u266B',
  'Family': '\u2605',
  'Western': '\u2606',
};

// ─── Floating Particles ──────────────────────────────
function FloatingParticles() {
  const particles = useMemo(() =>
    Array.from({ length: 10 }, (_, i) => ({
      id: i,
      left: `${Math.random() * 100}%`,
      delay: `${Math.random() * 8}s`,
      duration: `${8 + Math.random() * 6}s`,
      size: `${1 + Math.random() * 2}px`,
    })), []);

  return (
    <div className="interstitial-particles" aria-hidden="true">
      {particles.map(p => (
        <div key={p.id} className="interstitial-particle"
          style={{
            left: p.left,
            animationDelay: p.delay,
            animationDuration: p.duration,
            width: p.size,
            height: p.size,
          }} />
      ))}
    </div>
  );
}

// ─── Channel Ident Scene ──────────────────────────────
function ChannelIdent({ channel }: { channel: Channel }) {
  return (
    <div className="interstitial-ident">
      <div className="interstitial-ident-number" style={{ animationDelay: '0s' }}>CH {channel.number}</div>
      <div className="interstitial-ident-name">{channel.name}</div>
    </div>
  );
}

// ─── Hero Countdown Scene ─────────────────────────────
function HeroCountdown({
  nextProgram,
  countdownMs,
  progressPercent,
}: {
  program: ScheduleProgram;
  nextProgram: ScheduleProgram | null;
  countdownMs: number;
  progressPercent: number;
}) {
  // Show the next real program's info, not the interstitial gap itself
  const hasRealNext = nextProgram && nextProgram.type === 'program';
  const [showDescription, setShowDescription] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowDescription(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  // SVG ring
  const radius = 80;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - progressPercent / 100);
  const ringColor =
    progressPercent > 95
      ? 'var(--text-gold)'
      : progressPercent > 80
        ? 'var(--text-gold)'
        : 'var(--accent-cyan)';

  // Label: show time of next program if available, otherwise generic
  const label = hasRealNext
    ? `UP NEXT AT ${formatTime(nextProgram.start_time)}`
    : 'COMING UP NEXT';

  return (
    <div className="interstitial-hero">
      <div className="interstitial-hero-label stagger-in" style={{ animationDelay: '0s' }}>{label}</div>
      {hasRealNext ? (
        <>
          <div className="interstitial-hero-title stagger-in" style={{ animationDelay: '0.15s' }}>{nextProgram.title}</div>
          {nextProgram.subtitle && (
            <div className="interstitial-hero-subtitle stagger-in" style={{ animationDelay: '0.25s' }}>{nextProgram.subtitle}</div>
          )}
          <div className="interstitial-hero-meta stagger-in" style={{ animationDelay: '0.35s' }}>
            {nextProgram.year && <span className="interstitial-badge">{nextProgram.year}</span>}
            {nextProgram.rating && <span className="interstitial-badge">{nextProgram.rating}</span>}
            {nextProgram.duration_ms > 0 && (
              <span className="interstitial-badge">{formatRuntime(nextProgram.duration_ms)}</span>
            )}
          </div>
          {showDescription && nextProgram.description && (
            <div className="interstitial-hero-description">{nextProgram.description}</div>
          )}
        </>
      ) : (
        <div className="interstitial-hero-title stagger-in" style={{ animationDelay: '0.15s' }}>Stay Tuned</div>
      )}

      {/* Countdown ring + timer */}
      <div className="interstitial-hero-countdown-wrap stagger-in" style={{ animationDelay: '0.5s' }}>
        <svg className="interstitial-ring" viewBox="0 0 200 200">
          <circle
            className="interstitial-ring-bg"
            cx="100"
            cy="100"
            r={radius}
          />
          <circle
            className="interstitial-ring-fg"
            cx="100"
            cy="100"
            r={radius}
            style={{
              strokeDasharray: circumference,
              strokeDashoffset: dashOffset,
              stroke: ringColor,
            }}
          />
        </svg>
        <div className="interstitial-hero-countdown">{formatCountdown(countdownMs)}</div>
      </div>
    </div>
  );
}

// ─── Lineup Carousel Scene ────────────────────────────
function LineupCarousel({
  programs,
  channelName,
}: {
  programs: ScheduleProgram[];
  channelName: string;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (programs.length <= 1) return;
    const timer = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % programs.length);
    }, CAROUSEL_INTERVAL);
    return () => clearInterval(timer);
  }, [programs.length]);

  if (programs.length === 0) return null;

  const { period } = getTimeOfDayContext();

  // Center active card in viewport
  const cardWidth = 220; // card width + gap
  const trackWidth = trackRef.current?.offsetWidth || 900;
  const centerOffset = (trackWidth / 2) - (cardWidth / 2);
  const translateX = centerOffset - (activeIndex * cardWidth);

  return (
    <div className="interstitial-lineup">
      <div className="interstitial-lineup-header stagger-in" style={{ animationDelay: '0s' }}>{period} ON {channelName.toUpperCase()}</div>
      <div className="interstitial-lineup-track" ref={trackRef}>
        <div
          className="interstitial-lineup-slider"
          style={{ transform: `translateX(${translateX}px)` }}
        >
          {programs.map((prog, i) => (
            <div
              key={`${prog.jellyfin_item_id}-${prog.start_time}`}
              className={`interstitial-lineup-card ${i === activeIndex ? 'active' : ''}`}
            >
              <div className="interstitial-lineup-thumb">
                {prog.thumbnail_url ? (
                  <img
                    src={prog.thumbnail_url}
                    alt=""
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <div className="interstitial-lineup-thumb-placeholder" />
                )}
              </div>
              <div className="interstitial-lineup-info">
                <div className="interstitial-lineup-time">{formatTime(prog.start_time)}</div>
                <div className="interstitial-lineup-title">{prog.title}</div>
                {prog.content_type && (
                  <div className="interstitial-lineup-type">
                    {prog.content_type === 'movie' ? 'MOVIE' : 'TV'}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Program Spotlight Scene ──────────────────────────
function ProgramSpotlight({
  programs,
}: {
  programs: ScheduleProgram[];
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [prevIndex, setPrevIndex] = useState(0);
  const [fade, setFade] = useState(true);
  const [fadeKey, setFadeKey] = useState(0);
  const [details, setDetails] = useState<Map<string, ProgramDetails>>(new Map());

  useEffect(() => {
    if (programs.length <= 1) return;
    const timer = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setActiveIndex((prev) => {
          setPrevIndex(prev);
          setFadeKey(k => k + 1);
          return (prev + 1) % programs.length;
        });
        setFade(true);
      }, 300);
    }, PHASE_DURATIONS.spotlight);
    return () => clearInterval(timer);
  }, [programs.length]);

  // Fetch details for the active program
  const activeProg = programs[activeIndex];
  useEffect(() => {
    if (!activeProg || details.has(activeProg.jellyfin_item_id)) return;
    getProgramDetails(activeProg.jellyfin_item_id)
      .then((d) => {
        setDetails((prev) => {
          const next = new Map(prev);
          next.set(activeProg.jellyfin_item_id, d);
          return next;
        });
      })
      .catch(() => { /* ignore */ });
  }, [activeProg, details]);

  if (!activeProg) return null;

  const progDetails = details.get(activeProg.jellyfin_item_id);

  return (
    <div className={`interstitial-spotlight ${fade ? 'visible' : ''}`}>
      {/* Cross-fading backdrops */}
      <div className="interstitial-spotlight-backdrop">
        {prevIndex !== activeIndex && programs[prevIndex]?.backdrop_url && (
          <img
            key={`prev-${fadeKey}`}
            src={programs[prevIndex].backdrop_url!}
            alt=""
            className="spotlight-backdrop-leaving"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        )}
        {activeProg.backdrop_url && (
          <img
            key={`curr-${fadeKey}`}
            src={activeProg.backdrop_url}
            alt=""
            className="spotlight-backdrop-entering"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        )}
      </div>
      <div className="interstitial-spotlight-panel">
        <div className="interstitial-spotlight-time stagger-in" style={{ animationDelay: '0s' }}>{formatTime(activeProg.start_time)}</div>
        <div className="interstitial-spotlight-title stagger-in" style={{ animationDelay: '0.12s' }}>{activeProg.title}</div>
        {activeProg.subtitle && (
          <div className="interstitial-spotlight-subtitle stagger-in" style={{ animationDelay: '0.2s' }}>{activeProg.subtitle}</div>
        )}
        <div className="interstitial-spotlight-meta stagger-in" style={{ animationDelay: '0.28s' }}>
          {activeProg.year && <span className="interstitial-badge">{activeProg.year}</span>}
          {activeProg.rating && <span className="interstitial-badge">{activeProg.rating}</span>}
          {activeProg.duration_ms > 0 && (
            <span className="interstitial-badge">{formatRuntime(activeProg.duration_ms)}</span>
          )}
          {progDetails?.communityRating != null && progDetails.communityRating > 0 && (
            <span className="interstitial-badge interstitial-badge-rating">
              &#9733; {progDetails.communityRating.toFixed(1)}
            </span>
          )}
        </div>
        {progDetails?.genres && progDetails.genres.length > 0 && (
          <div className="interstitial-spotlight-genres stagger-in" style={{ animationDelay: '0.36s' }}>
            {progDetails.genres.slice(0, 3).map(genre => (
              <span key={genre} className="interstitial-genre-pill">
                {GENRE_ICONS[genre] || '\u25CF'} {genre}
              </span>
            ))}
          </div>
        )}
        {progDetails?.cast && progDetails.cast.length > 0 && (
          <div className="interstitial-spotlight-cast stagger-in" style={{ animationDelay: '0.44s' }}>
            {progDetails.cast.join(' \u00B7 ')}
          </div>
        )}
        <div className="interstitial-spotlight-description stagger-in" style={{ animationDelay: '0.5s' }}>
          {progDetails?.overview || activeProg.description || ''}
        </div>
      </div>
    </div>
  );
}

// ─── Main InterstitialScreen Component ────────────────
export default function InterstitialScreen({ channel, program, nextProgram, disableMusic }: InterstitialScreenProps) {
  const { scheduleByChannel } = useSchedule();
  const [currentPhase, setCurrentPhase] = useState<Phase>('ident');
  const phaseStartRef = useRef(Date.now());
  const [countdownMs, setCountdownMs] = useState(0);
  const [progressPercent, setProgressPercent] = useState(0);
  const [phaseDirection, setPhaseDirection] = useState<'entering' | 'exiting'>('entering');
  const interstitialStartRef = useRef(Date.now());

  const displayProgram = nextProgram || program;

  // Calculate total interstitial duration
  const totalDuration = useMemo(() => {
    return Math.max(0, new Date(program.end_time).getTime() - interstitialStartRef.current);
  }, [program.end_time]);

  const isShort = totalDuration < SHORT_THRESHOLD;
  const isMinimal = totalDuration < MINIMAL_THRESHOLD;

  // Get upcoming programs for this channel (skip interstitials, only future programs)
  const upcomingPrograms = useMemo(() => {
    const allPrograms = scheduleByChannel.get(channel.id) || [];
    const now = Date.now();
    return allPrograms
      .filter((p) => p.type === 'program' && new Date(p.start_time).getTime() > now)
      .slice(0, 6);
  }, [scheduleByChannel, channel.id]);

  // Phase sequence depends on interstitial length
  const phaseSequence = useMemo<Phase[]>(() => {
    if (isMinimal) return ['hero'];
    if (isShort) return ['ident', 'hero'];
    if (upcomingPrograms.length === 0) return ['ident', 'hero'];
    return ['ident', 'hero', 'lineup', 'spotlight'];
  }, [isMinimal, isShort, upcomingPrograms.length]);

  // Phase cycling with directional choreography
  useEffect(() => {
    if (phaseSequence.length <= 1) return;

    const timer = setInterval(() => {
      const elapsed = Date.now() - phaseStartRef.current;
      const phaseDuration = PHASE_DURATIONS[currentPhase];

      if (elapsed >= phaseDuration) {
        setPhaseDirection('exiting');
        setTimeout(() => {
          const currentIdx = phaseSequence.indexOf(currentPhase);
          // Loop: after last phase, go back to second phase (skip ident on subsequent loops)
          let nextIdx = currentIdx + 1;
          if (nextIdx >= phaseSequence.length) {
            nextIdx = phaseSequence.length > 1 ? 1 : 0; // skip ident on loop
          }
          setCurrentPhase(phaseSequence[nextIdx]);
          phaseStartRef.current = Date.now();
          setPhaseDirection('entering');
        }, 400);
      }
    }, 500);

    return () => clearInterval(timer);
  }, [currentPhase, phaseSequence]);

  // Countdown + progress timer
  useEffect(() => {
    const timer = setInterval(() => {
      const endMs = new Date(program.end_time).getTime();
      const now = Date.now();
      const remaining = endMs - now;
      setCountdownMs(Math.max(0, remaining));

      const elapsed = now - interstitialStartRef.current;
      const pct = totalDuration > 0 ? Math.min(100, (elapsed / totalDuration) * 100) : 100;
      setProgressPercent(pct);
    }, COUNTDOWN_INTERVAL);

    return () => clearInterval(timer);
  }, [program.end_time, totalDuration]);

  // ─── Image Preloading ──────────────────────────────
  useEffect(() => {
    const urls = upcomingPrograms.flatMap(p =>
      [p.backdrop_url, p.thumbnail_url].filter(Boolean)
    ) as string[];
    if (displayProgram.backdrop_url) urls.push(displayProgram.backdrop_url);
    if (displayProgram.thumbnail_url) urls.push(displayProgram.thumbnail_url);
    urls.forEach(url => {
      const img = new Image();
      img.src = url;
    });
  }, [upcomingPrograms, displayProgram.backdrop_url, displayProgram.thumbnail_url]);

  // ─── Background Music ──────────────────────────────
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const [musicTracks, setMusicTracks] = useState<string[]>([]);
  const musicIndexRef = useRef(0);
  const ownerIdRef = useRef(++activeOwnerId);

  // Fetch available background music tracks on mount
  useEffect(() => {
    if (disableMusic) return;
    getBackgroundMusicList()
      .then((tracks) => {
        if (tracks.length > 0) {
          // Shuffle tracks for variety
          const shuffled = [...tracks].sort(() => Math.random() - 0.5);
          setMusicTracks(shuffled);
        }
      })
      .catch(() => { /* no music available, that's fine */ });
  }, [disableMusic]);

  // Play background music when tracks are available
  useEffect(() => {
    if (musicTracks.length === 0) return;

    const myId = ++activeOwnerId;
    ownerIdRef.current = myId;

    const audio = new Audio(musicTracks[0]);
    audioRef.current = audio;
    audio.loop = false;

    // Stop any other InterstitialScreen's music before starting ours
    claimAudio(myId, audio);

    // Respect user's volume setting — play background music at 20% of their chosen volume
    const storedVolume = parseFloat(localStorage.getItem('prevue_volume') || '1');
    const isMuted = localStorage.getItem('prevue_muted') === 'true';
    audio.volume = isMuted ? 0 : Math.min(1, storedVolume * 0.2);

    // When a track ends, play the next one
    const handleEnded = () => {
      musicIndexRef.current = (musicIndexRef.current + 1) % musicTracks.length;
      audio.src = musicTracks[musicIndexRef.current];
      audio.play().catch(() => {});
    };
    audio.addEventListener('ended', handleEnded);

    // Fade in over 2 seconds
    const targetVolume = audio.volume;
    audio.volume = 0;
    audio.play().catch(() => { /* autoplay may be blocked — that's ok */ });

    let fadeFrame: number;
    const fadeStartTime = Date.now();
    const FADE_IN_MS = 2000;
    const fadeIn = () => {
      const elapsed = Date.now() - fadeStartTime;
      const progress = Math.min(1, elapsed / FADE_IN_MS);
      audio.volume = targetVolume * progress;
      if (progress < 1) {
        fadeFrame = requestAnimationFrame(fadeIn);
      }
    };
    fadeFrame = requestAnimationFrame(fadeIn);

    // Audio-reactive pulse via Web Audio API
    let audioContext: AudioContext | null = null;
    let analyserAnimFrame: number;
    try {
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioContext.createMediaElementSource(audio);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 32;
      source.connect(analyser);
      analyser.connect(audioContext.destination);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const tickAnalyser = () => {
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        const pulse = 1 + (avg / 255) * 0.03; // subtle 0-3% scale
        document.documentElement.style.setProperty('--audio-pulse', String(pulse));
        analyserAnimFrame = requestAnimationFrame(tickAnalyser);
      };
      analyserAnimFrame = requestAnimationFrame(tickAnalyser);
    } catch {
      // Web Audio API not available or autoplay blocked — that's fine
    }

    // Listen for volume changes from the Player's volume controls
    const handleVolumeChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && audioRef.current) {
        const vol = typeof detail.volume === 'number' ? detail.volume : 1;
        const muted = !!detail.muted;
        audioRef.current.volume = muted ? 0 : Math.min(1, vol * 0.2);
      }
    };
    window.addEventListener('prevue_volume_change', handleVolumeChange);

    return () => {
      cancelAnimationFrame(fadeFrame);
      cancelAnimationFrame(analyserAnimFrame!);
      audio.removeEventListener('ended', handleEnded);
      window.removeEventListener('prevue_volume_change', handleVolumeChange);
      releaseAudio(myId);
      analyserRef.current = null;
      document.documentElement.style.removeProperty('--audio-pulse');

      if (audioContext) {
        audioContext.close().catch(() => {});
      }

      // Fade out over 500ms before cleanup
      const fadeOutStart = Date.now();
      const FADE_OUT_MS = 500;
      const startVol = audio.volume;
      const fadeOut = () => {
        const elapsed = Date.now() - fadeOutStart;
        const progress = Math.min(1, elapsed / FADE_OUT_MS);
        audio.volume = startVol * (1 - progress);
        if (progress < 1) {
          requestAnimationFrame(fadeOut);
        } else {
          audio.pause();
          audio.src = '';
        }
      };
      requestAnimationFrame(fadeOut);
    };
  }, [musicTracks]);

  // Determine background image
  const bgImage = displayProgram.backdrop_url || displayProgram.thumbnail_url;

  return (
    <div className="interstitial-screen">
      {/* Animated background with parallax layers */}
      <div className="interstitial-bg">
        {bgImage && (
          <img
            src={bgImage}
            alt=""
            className="interstitial-bg-image interstitial-bg-far"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
          />
        )}
        <div className="interstitial-bg-near" />
      </div>

      {/* Subtle video texture overlay — above background, below everything else */}
      <video
        className="interstitial-video-overlay"
        src="/api/assets/video/bg-vid.mp4"
        autoPlay
        loop
        muted
        playsInline
        preload="none"
      />

      {/* Floating particles */}
      <FloatingParticles />

      {/* Scanline + vignette overlay */}
      <div className="interstitial-crt-overlay" />

      {/* Scene content with directional transitions */}
      <div className={`interstitial-scene phase-${phaseDirection}`} key={currentPhase}>
        {currentPhase === 'ident' && <ChannelIdent channel={channel} />}
        {currentPhase === 'hero' && (
          <HeroCountdown
            program={program}
            nextProgram={nextProgram}
            countdownMs={countdownMs}
            progressPercent={progressPercent}
          />
        )}
        {currentPhase === 'lineup' && (
          <LineupCarousel programs={upcomingPrograms} channelName={channel.name} />
        )}
        {currentPhase === 'spotlight' && (
          <ProgramSpotlight programs={upcomingPrograms} />
        )}
      </div>

      {/* Persistent bottom progress bar with comet glow */}
      <div className="interstitial-progress-bar">
        <div
          className="interstitial-progress-fill"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Persistent mini countdown in corner */}
      <div className="interstitial-mini-countdown">
        {formatCountdown(countdownMs)}
      </div>
    </div>
  );
}
