/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Trophy, Shield, Calendar, Plus, Trash2, Edit2, Share2, Lock, LogOut, 
  Download, Upload, Info, Users, Check, ArrowRight, Sparkles, RefreshCw, Smartphone,
  Star, Crown, Zap, Eye, EyeOff, Bell, Clock, MapPin, Wand2, Layers, Settings, ChevronRight
} from 'lucide-react';

import { auth, db } from './lib/firebase';
import { 
  onSnapshot, collection, getDocs, getDoc, doc, setDoc, deleteDoc, writeBatch 
} from 'firebase/firestore';
import { 
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, signInAnonymously 
} from 'firebase/auth';
import { INITIAL_TEAMS, INITIAL_TOURNAMENTS, INITIAL_MATCHES } from './initialData';
import { realtimeSync, SyncPayload, RealtimeAction } from './lib/realtimeSync';

// Dynamic API backend URL resolver (resolves central cloud server across Netlify, PC, and mobile)
export const getApiUrl = (endpoint: string): string => {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_BACKEND_URL) {
    return `${import.meta.env.VITE_BACKEND_URL.replace(/\/$/, '')}${cleanEndpoint}`;
  }
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host.includes('netlify.app') || host.includes('vercel.app') || host.includes('github.io')) {
      return `https://ais-pre-f64j2s5bwy6buw2nsa374i-194677430859.us-east1.run.app${cleanEndpoint}`;
    }
  }
  return cleanEndpoint;
};

// --- TYPES ---
export interface Team {
  id: string;
  name: string;
  primaryColor: string;
  secondaryColor: string;
  badgeSymbol: string; // 'ball' | 'star' | 'crown' | 'trophy' | 'shield' | 'flame' | 'zap'
  logoUrl?: string; // Base64 uploaded custom image
}

export type TournamentType = 'LIGA' | 'GRUPOS' | 'ELIMINACION_DIRECTA' | 'FASE_FINAL';

export interface TournamentTeam {
  teamId: string;
  group?: string; // 'A', 'B', 'C', 'D' etc.
}

export interface Tournament {
  id: string;
  name: string;
  type: TournamentType;
  numGroups?: number; // For GRUPOS
  numTeams?: number; // For LIGA / ELIMINACION_DIRECTA
  faseFinalType?: 'octavos' | 'cuartos' | 'semis'; // For FASE_FINAL
  teams: TournamentTeam[];
  logoUrl?: string; // Base64 uploaded custom image
  adminPassword?: string;
  visitorPassword?: string;
}

export interface Match {
  id: string;
  tournamentId: string;
  teamAId: string;
  teamBId: string;
  scoreA: number | null;
  scoreB: number | null;
  played: boolean;
  group?: string; // For GRUPOS
  round: string; // e.g., "Jornada 1", "Octavos", "Cuartos", "Semifinal", "Final"
  bracketSlot?: number; // Slot for brackets
  isLlave?: boolean;
  freeTeamId?: string;
  penaltiesA?: number | null;
  penaltiesB?: number | null;
  time?: string;
  venue?: string;
  overrideTeams?: any;
  label?: string; // Custom description of the matchup, e.g. "1ro Grupo A VS 4to Grupo C"
  sourceA?: string; // e.g. "A_1", "C_4", "BEST_3_1"
  sourceB?: string; // e.g. "C_4", "A_1"
}

export interface BracketPairingRule {
  id: string;
  sourceA: string; // e.g. 'A_1', 'C_4', 'BEST_3_1', 'LIGA_1', 'TEAM:123', 'TBD'
  sourceB: string; // e.g. 'C_4', 'A_1'
  customLabel?: string;
  time?: string;
  venue?: string;
}

export interface AppNotification {
  id: string;
  text: string;
  timestamp: number;
  tournamentId?: string;
}

export interface StandingRow {
  teamId: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
}

const BADGE_SYMBOLS = ['ball', 'star', 'crown', 'trophy', 'shield', 'flame', 'zap'];

// Helper to remove any undefined fields recursively for Firestore compatibility
function cleanForFirestore(obj: any): any {
  if (obj === null || obj === undefined) {
    return null;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => cleanForFirestore(item));
  }
  if (typeof obj === 'object') {
    const copy: any = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const val = obj[key];
        if (val !== undefined) {
          copy[key] = cleanForFirestore(val);
        }
      }
    }
    return copy;
  }
  return obj;
}

async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 3, delay = 1000): Promise<Response> {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    return res;
  } catch (err) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 2);
    }
    throw err;
  }
}

export default function App() {
  // --- STATE ---
  const [role, setRole] = useState<'admin' | 'visitor' | null>(() => {
    return (sessionStorage.getItem('playgol_role') as any) || null;
  });
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const [teams, setTeams] = useState<Team[]>(() => {
    try {
      const cached = localStorage.getItem('playgol_teams_cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return INITIAL_TEAMS;
  });
  const [tournaments, setTournaments] = useState<Tournament[]>(() => {
    try {
      const cached = localStorage.getItem('playgol_tournaments_cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return INITIAL_TOURNAMENTS;
  });
  const [matches, setMatches] = useState<Match[]>(() => {
    try {
      const cached = localStorage.getItem('playgol_matches_cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return INITIAL_MATCHES;
  });

  const [activeTab, setActiveTab] = useState<'tournaments' | 'teams' | 'share'>('tournaments');
  const [selectedTournamentId, setSelectedTournamentId] = useState<string | null>(null);
  const [tournamentSubTab, setTournamentSubTab] = useState<'table' | 'matches' | 'bracket' | 'keys'>('matches');

  // Tournament session access mapping (stores whether this tab has unlocked 'AdminTorneo' or 'Visitante' for a tournament)
  const [unlockedTournaments, setUnlockedTournaments] = useState<Record<string, 'AdminTorneo' | 'Visitante'>>(() => {
    try {
      const saved = sessionStorage.getItem('playgol_unlocked_tournaments');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const setTournamentAccess = (tourId: string, accessRole: 'AdminTorneo' | 'Visitante') => {
    setUnlockedTournaments(prev => {
      const updated = { ...prev, [tourId]: accessRole };
      sessionStorage.setItem('playgol_unlocked_tournaments', JSON.stringify(updated));
      return updated;
    });
  };

  const checkCanEdit = (tourId?: string | null) => {
    if (role === 'admin') return true;
    if (tourId && unlockedTournaments[tourId] === 'AdminTorneo') return true;
    return false;
  };

  // Tournament-specific password verification state
  const [passwordCheckingTourId, setPasswordCheckingTourId] = useState<string | null>(null);
  const [tourPasswordValue, setTourPasswordValue] = useState('');
  const [tourPasswordError, setTourPasswordError] = useState('');
  const [showTourPassword, setShowTourPassword] = useState(false);
  const [creatingMatchInLlaves, setCreatingMatchInLlaves] = useState(false);

  // Creation Modals / Forms
  const [showTeamModal, setShowTeamModal] = useState(false);
  const [newTeam, setNewTeam] = useState({
    name: '',
    primaryColor: '#10b981',
    secondaryColor: '#1f2937',
    badgeSymbol: 'ball',
    logoUrl: ''
  });

  const [showTournamentModal, setShowTournamentModal] = useState(false);
  const [newTournament, setNewTournament] = useState({
    name: '',
    type: 'LIGA' as TournamentType,
    numGroups: 2,
    numTeams: 8,
    faseFinalType: 'semis' as 'octavos' | 'cuartos' | 'semis',
    logoUrl: '',
    adminPassword: '',
    visitorPassword: ''
  });

  // Edit Modals / States
  const [editingTournament, setEditingTournament] = useState<Tournament | null>(null);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);

  // Assign Team or Match Modal
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignModalTab, setAssignModalTab] = useState<'match' | 'team'>('match');
  const [assignTeamState, setAssignTeamState] = useState({
    teamId: '',
    group: 'A'
  });
  const [newMatchState, setNewMatchState] = useState({
    teamAId: '',
    teamBId: '',
    round: 'Fecha 1',
    scoreA: '',
    scoreB: '',
    played: false,
    group: 'A',
    freeTeamId: '',
    time: '',
    venue: ''
  });

  // Manual Match creation modal
  const [showManualMatchModal, setShowManualMatchModal] = useState(false);

  // Auto Llaves creation states
  const [showAutoLlaveModal, setShowAutoLlaveModal] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [autoPhaseName, setAutoPhaseName] = useState('Octavos de Final');

  // Custom Llaves / Bracket Builder state
  const [showBracketBuilderModal, setShowBracketBuilderModal] = useState(false);
  const [bracketBuilderPhaseName, setBracketBuilderPhaseName] = useState('Octavos de Final');
  const [bracketBuilderRules, setBracketBuilderRules] = useState<BracketPairingRule[]>([]);
  const [bracketBuilderSelectedTemplate, setBracketBuilderSelectedTemplate] = useState<string>('');
  const [bracketTemplateCategoryFilter, setBracketTemplateCategoryFilter] = useState<string>('ALL');
  const [bracketBuilderReplaceExisting, setBracketBuilderReplaceExisting] = useState(false);

  // Bracket pairing modal states
  const [showBracketPairingModal, setShowBracketPairingModal] = useState(false);
  const [bracketPairingTour, setBracketPairingTour] = useState<Tournament | null>(null);
  const [bracketPairings, setBracketPairings] = useState<{ teamAId: string; teamBId: string }[]>([]);
  const [bracketRoundName, setBracketRoundName] = useState('');

  // Match Editor Modal
  const [editingMatch, setEditingMatch] = useState<Match | null>(null);
  const [editScoreA, setEditScoreA] = useState<string>('');
  const [editScoreB, setEditScoreB] = useState<string>('');
  const [editPenaltiesA, setEditPenaltiesA] = useState<string>('');
  const [editPenaltiesB, setEditPenaltiesB] = useState<string>('');

  // Match Details Editor Modal
  const [editingMatchDetails, setEditingMatchDetails] = useState<Match | null>(null);
  const [matchDetailsState, setMatchDetailsState] = useState({
    round: '',
    teamAId: '',
    teamBId: '',
    group: 'A',
    scoreA: '',
    scoreB: '',
    penaltiesA: '',
    penaltiesB: '',
    overrideTeams: false,
    freeTeamId: '',
    time: '',
    venue: ''
  });

  // Custom confirmation modal state
  const [confirmModalState, setConfirmModalState] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    onConfirm: () => void;
  } | null>(null);

  // Manual Llaves / Brackets creation state
  const [showAddManualLlaveModal, setShowAddManualLlaveModal] = useState(false);
  const [manualLlaveState, setManualLlaveState] = useState({
    phaseName: 'Segunda Fase',
    teamAId: '',
    teamBId: '',
    scoreA: '',
    scoreB: '',
    played: false
  });

  const showConfirm = (
    title: string,
    message: string,
    onConfirm: () => void,
    confirmText = 'Eliminar',
    cancelText = 'Cancelar'
  ) => {
    setConfirmModalState({
      isOpen: true,
      title,
      message,
      confirmText,
      cancelText,
      onConfirm: () => {
        onConfirm();
        setConfirmModalState(null);
      }
    });
  };

  // Notifications & PWA Installation States
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [activeCloudNotif, setActiveCloudNotif] = useState<AppNotification | null>(null);
  const previousNotifIdsRef = useRef<Set<string>>(new Set());
  const isFirstNotifLoadRef = useRef(true);
  const [showNotificationsModal, setShowNotificationsModal] = useState(false);
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [showNotifDropdown, setShowNotifDropdown] = useState(false);
  const [lastReadNotificationTimestamp, setLastReadNotificationTimestamp] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('playgol_last_read_notif');
      return saved ? Number(saved) : 0;
    } catch {
      return 0;
    }
  });
  const [deviceOS, setDeviceOS] = useState<'ios' | 'android' | 'other'>('other');
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

  // Auto-dismiss cloud notification after 8 seconds
  useEffect(() => {
    if (activeCloudNotif) {
      const timer = setTimeout(() => {
        setActiveCloudNotif(null);
      }, 8000);
      return () => clearTimeout(timer);
    }
  }, [activeCloudNotif]);

  // Request browser Web Push notification permissions
  const requestNotificationPermission = () => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(permission => {
        console.log('Notification permission:', permission);
      }).catch(err => console.error("Error requesting notification permission:", err));
    }
  };

  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    if (/iphone|ipad|ipod/.test(ua)) {
      setDeviceOS('ios');
    } else if (/android/.test(ua)) {
      setDeviceOS('android');
    } else {
      setDeviceOS('other');
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstallPWA = async () => {
    if (deferredPrompt) {
      try {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
          setDeferredPrompt(null);
          setShowInstallModal(false);
        }
      } catch (err) {
        console.error("Install prompt error:", err);
      }
    } else if (navigator.share) {
      try {
        await navigator.share({
          title: 'PlayGol',
          text: 'Instala el acceso directo de PlayGol en tu pantalla de inicio',
          url: window.location.href
        });
      } catch (e) {
        console.log('Share prompt dismissed', e);
      }
    } else {
      alert("Para crear el ícono de PlayGol en tu pantalla de inicio, abre el menú de tu navegador y selecciona 'Agregar a la pantalla principal' o 'Instalar aplicación'.");
    }
  };

  // Share message status
  const [copyStatus, setCopyStatus] = useState(false);
  const [importString, setImportString] = useState('');
  const [importStatus, setImportStatus] = useState<{ success?: boolean; msg?: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const editTeamFileInputRef = useRef<HTMLInputElement>(null);
  const tourFileInputRef = useRef<HTMLInputElement>(null);
  const editTourFileInputRef = useRef<HTMLInputElement>(null);

  // Monotonic timestamp tracker to prevent older/stale cache or peer syncs from overwriting newer state
  const lastStateTimestampRef = useRef<number>(() => {
    try {
      const s = localStorage.getItem('playgol_last_updated');
      return s ? Number(s) : 0;
    } catch {
      return 0;
    }
  });

  // --- INITIAL SEED DATA & REAL-TIME 1:1 SYNC ENGINE ---
  useEffect(() => {
    let isMounted = true;
    let eventSource: EventSource | null = null;

    // 1. Listen to Auth State changes in Firebase Auth (optional background sync)
    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      if (user && isMounted) {
        if (user.email === 'admin@playgol.com') {
          setRole('admin');
          sessionStorage.setItem('playgol_role', 'admin');
        } else if (user.email === 'visitor@playgol.com') {
          setRole('visitor');
          sessionStorage.setItem('playgol_role', 'visitor');
        }
      }
    });

    // Auto sign-in anonymously if not authenticated to ensure robust Firebase security clearance
    if (!auth.currentUser) {
      signInAnonymously(auth).catch(() => {});
    }

    // Unified function to apply incoming cloud updates to local state safely without data loss
    const applyIncomingState = (incoming: any, specificNotification?: any, source?: string) => {
      if (!incoming || !isMounted) return;

      const incomingTimestamp = Number(incoming.updatedAt || incoming.timestamp || 0);

      // If incoming payload is older than what we already know from a recent write/sync, ignore older peer state
      if (source !== 'firestore' && incomingTimestamp > 0 && lastStateTimestampRef.current > 0) {
        if (incomingTimestamp < lastStateTimestampRef.current - 1500) {
          return;
        }
      }

      if (incomingTimestamp > 0) {
        lastStateTimestampRef.current = Math.max(lastStateTimestampRef.current, incomingTimestamp);
        try {
          localStorage.setItem('playgol_last_updated', String(lastStateTimestampRef.current));
        } catch {}
      }

      if (Array.isArray(incoming.tournaments)) {
        setTournaments(prevTours => {
          let mergedTours: Tournament[];
          if (source === 'firestore') {
            mergedTours = incoming.tournaments;
          } else {
            // Non-destructive merge: preserve user-created tournaments
            const map = new Map<string, Tournament>(prevTours.map(t => [t.id, t]));
            incoming.tournaments.forEach((inTour: Tournament) => {
              const existing = map.get(inTour.id);
              if (existing && existing.logoUrl && !inTour.logoUrl) {
                map.set(inTour.id, { ...existing, ...inTour, logoUrl: existing.logoUrl });
              } else {
                map.set(inTour.id, { ...(existing || {} as Tournament), ...inTour });
              }
            });
            mergedTours = Array.from(map.values());
          }
          try {
            localStorage.setItem('playgol_tournaments_cache', JSON.stringify(mergedTours));
          } catch {}
          return mergedTours;
        });
      }

      if (Array.isArray(incoming.teams)) {
        setTeams(prevTeams => {
          let mergedTeams: Team[];
          if (source === 'firestore') {
            mergedTeams = incoming.teams;
          } else {
            // Non-destructive merge: preserve user-created clubs
            const map = new Map<string, Team>(prevTeams.map(t => [t.id, t]));
            incoming.teams.forEach((inTeam: Team) => {
              const existing = map.get(inTeam.id);
              if (existing && existing.logoUrl && !inTeam.logoUrl) {
                map.set(inTeam.id, { ...existing, ...inTeam, logoUrl: existing.logoUrl });
              } else {
                map.set(inTeam.id, { ...(existing || {} as Team), ...inTeam });
              }
            });
            mergedTeams = Array.from(map.values());
          }
          try {
            localStorage.setItem('playgol_teams_cache', JSON.stringify(mergedTeams));
          } catch {}
          return mergedTeams;
        });
      }

      if (Array.isArray(incoming.matches)) {
        setMatches(prevMatches => {
          let mergedMatches: Match[];
          if (source === 'firestore') {
            mergedMatches = incoming.matches;
          } else {
            // Non-destructive merge: preserve updated match scores
            const map = new Map<string, Match>(prevMatches.map(m => [m.id, m]));
            incoming.matches.forEach((inMatch: Match) => {
              map.set(inMatch.id, inMatch);
            });
            mergedMatches = Array.from(map.values());
          }
          try {
            localStorage.setItem('playgol_matches_cache', JSON.stringify(mergedMatches));
          } catch {}
          return mergedMatches;
        });
      }

      if (Array.isArray(incoming.notifications)) {
        const sorted = [...incoming.notifications].sort((a: any, b: any) => b.timestamp - a.timestamp);
        
        // Trigger floating Cloud Toast and native browser notification on new incoming updates
        if (!isFirstNotifLoadRef.current && (sorted.length > 0 || specificNotification)) {
          const newItems = sorted.filter((n: any) => !previousNotifIdsRef.current.has(n.id));
          const notifToShow = specificNotification || (newItems.length > 0 ? newItems[0] : null);
          
          if (notifToShow) {
            setActiveCloudNotif(notifToShow);

            if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
              try {
                new Notification('PlayGol - Actualización en Vivo', {
                  body: notifToShow.text,
                  icon: '/logo-pg.svg',
                  tag: notifToShow.id
                });
              } catch (e) {}
            }
          }
        } else {
          isFirstNotifLoadRef.current = false;
        }

        previousNotifIdsRef.current = new Set(sorted.map((n: any) => n.id));
        setNotifications(sorted);
      }
      setIsLoading(false);
    };

    // 1. PRIMARY CLOUD PERSISTENCE: Real-time Firestore Master Snapshot Listener
    let hasInitializedFirestoreSeed = false;
    const unsubscribeFirestore = onSnapshot(
      doc(db, 'app_state', 'main'),
      (docSnap) => {
        if (!isMounted) return;
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data && (Array.isArray(data.tournaments) || Array.isArray(data.teams))) {
            applyIncomingState({
              teams: data.teams || [],
              tournaments: data.tournaments || [],
              matches: data.matches || [],
              notifications: data.notifications || [],
              updatedAt: data.updatedAt || Date.now()
            }, data.lastNotification, 'firestore');
          }
        } else if (!hasInitializedFirestoreSeed) {
          hasInitializedFirestoreSeed = true;
          // Seed Firestore with initial state ONLY on brand new unseeded database
          const seedPayload = {
            teams: cleanForFirestore(teams),
            tournaments: cleanForFirestore(tournaments),
            matches: cleanForFirestore(matches),
            notifications: [],
            updatedAt: Date.now()
          };
          setDoc(doc(db, 'app_state', 'main'), seedPayload).catch(err => {
            console.warn("Firestore seed initial error:", err);
          });
        }
      },
      (err) => {
        console.warn("Firestore onSnapshot error:", err);
      }
    );

    // 2. Realtime Action Listener (Sub-15ms direct action delta updates)
    const unsubRealtimeAction = realtimeSync.subscribeAction((action: RealtimeAction) => {
      if (!isMounted || !action) return;

      lastStateTimestampRef.current = Date.now();
      try {
        localStorage.setItem('playgol_last_updated', String(lastStateTimestampRef.current));
      } catch {}

      if (action.type === 'REQUEST_SYNC') {
        setTournaments(currTours => {
          if (currTours.length > 0) {
            setTeams(currTeams => {
              setMatches(currMatches => {
                realtimeSync.publishState({
                  teams: currTeams,
                  tournaments: currTours,
                  matches: currMatches,
                  notifications: [],
                  timestamp: Date.now()
                });
                return currMatches;
              });
              return currTeams;
            });
          }
          return currTours;
        });
        return;
      }

      if (action.type === 'MATCH_SCORE_UPDATE') {
        setMatches(prevMatches => {
          let updated = prevMatches.map(m => {
            if (m.id === action.matchId) {
              return {
                ...m,
                scoreA: action.scoreA,
                scoreB: action.scoreB,
                penaltiesA: action.penaltiesA ?? m.penaltiesA,
                penaltiesB: action.penaltiesB ?? m.penaltiesB,
                played: action.played
              };
            }
            return m;
          });
          if (action.tournamentId) {
            updated = autoAdvanceLlaves(action.tournamentId, updated);
          }
          try { localStorage.setItem('playgol_matches_cache', JSON.stringify(updated)); } catch {}
          return updated;
        });
      } else if (action.type === 'MATCHES_UPDATE') {
        setMatches(prevMatches => {
          const updateMap = new Map(action.matches.map((m: any) => [m.id, m]));
          let updated = prevMatches.map(m => updateMap.get(m.id) || m);
          action.matches.forEach((m: any) => {
            if (!updated.some(um => um.id === m.id)) updated.push(m);
          });
          if (action.tournamentId) {
            updated = autoAdvanceLlaves(action.tournamentId, updated);
          }
          try { localStorage.setItem('playgol_matches_cache', JSON.stringify(updated)); } catch {}
          return updated;
        });
      } else if (action.type === 'MATCH_ADD') {
        setMatches(prev => {
          if (prev.some(m => m.id === action.match.id)) return prev;
          const updated = [...prev, action.match];
          try { localStorage.setItem('playgol_matches_cache', JSON.stringify(updated)); } catch {}
          return updated;
        });
      } else if (action.type === 'MATCH_DELETE') {
        setMatches(prev => {
          const updated = prev.filter(m => m.id !== action.matchId);
          try { localStorage.setItem('playgol_matches_cache', JSON.stringify(updated)); } catch {}
          return updated;
        });
      } else if (action.type === 'TOURNAMENT_CREATE') {
        setTournaments(prev => {
          if (prev.some(t => t.id === action.tournament.id)) return prev;
          const updated = [action.tournament, ...prev];
          try { localStorage.setItem('playgol_tournaments_cache', JSON.stringify(updated)); } catch {}
          return updated;
        });
        if (action.matches && action.matches.length > 0) {
          setMatches(prev => {
            const updated = [...prev, ...action.matches!];
            try { localStorage.setItem('playgol_matches_cache', JSON.stringify(updated)); } catch {}
            return updated;
          });
        }
      } else if (action.type === 'TOURNAMENT_UPDATE') {
        setTournaments(prev => {
          const updated = prev.map(t => t.id === action.tournament.id ? action.tournament : t);
          try { localStorage.setItem('playgol_tournaments_cache', JSON.stringify(updated)); } catch {}
          return updated;
        });
      } else if (action.type === 'TOURNAMENT_DELETE') {
        setTournaments(prev => {
          const updated = prev.filter(t => t.id !== action.tournamentId);
          try { localStorage.setItem('playgol_tournaments_cache', JSON.stringify(updated)); } catch {}
          return updated;
        });
        setMatches(prev => {
          const updated = prev.filter(m => m.tournamentId !== action.tournamentId);
          try { localStorage.setItem('playgol_matches_cache', JSON.stringify(updated)); } catch {}
          return updated;
        });
      } else if (action.type === 'TEAM_CREATE') {
        setTeams(prev => {
          if (prev.some(t => t.id === action.team.id)) return prev;
          const updated = [...prev, action.team];
          try { localStorage.setItem('playgol_teams_cache', JSON.stringify(updated)); } catch {}
          return updated;
        });
      } else if (action.type === 'TEAM_UPDATE') {
        setTeams(prev => {
          const updated = prev.map(t => t.id === action.team.id ? action.team : t);
          try { localStorage.setItem('playgol_teams_cache', JSON.stringify(updated)); } catch {}
          return updated;
        });
      } else if (action.type === 'TEAM_DELETE') {
        setTeams(prev => {
          const updated = prev.filter(t => t.id !== action.teamId);
          try { localStorage.setItem('playgol_teams_cache', JSON.stringify(updated)); } catch {}
          return updated;
        });
      }

      const notifText = (action as any).notifText;
      if (notifText) {
        const notifObj = {
          id: `notif-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          text: notifText,
          timestamp: Date.now(),
          tournamentId: (action as any).tournamentId
        };
        setActiveCloudNotif(notifObj);
        setNotifications(prev => [notifObj, ...prev.filter(n => n.id !== notifObj.id)].slice(0, 50));
      }
    });

    // 3. Realtime MQTT listener (Instant sub-100ms real-time 1:1 cross-device sync)
    const unsubRealtimeState = realtimeSync.subscribeState((payload: SyncPayload) => {
      if (isMounted && payload) {
        applyIncomingState(payload, payload.notification, 'mqtt');
      }
    });

    const unsubRealtimeNotif = realtimeSync.subscribeNotif((notif: any) => {
      if (isMounted && notif) {
        setActiveCloudNotif(notif);
        setNotifications(prev => [notif, ...prev.filter(n => n.id !== notif.id)].slice(0, 50));
      }
    });

    // 4. Real-time Server-Sent Events (SSE) stream for dual backup sync
    const connectSSE = () => {
      if (typeof EventSource === 'undefined') return;
      try {
        const sseUrl = getApiUrl('/api/events');
        eventSource = new EventSource(sseUrl);

        eventSource.onmessage = (event) => {
          try {
            const payload = JSON.parse(event.data);
            if (payload && payload.state) {
              applyIncomingState(payload.state, payload.notification, 'sse');
            }
          } catch (e) {}
        };

        eventSource.onerror = () => {
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          if (isMounted) {
            setTimeout(connectSSE, 5000);
          }
        };
      } catch (e) {
        console.warn("SSE connection notice:", e);
      }
    };

    connectSSE();

    return () => {
      isMounted = false;
      unsubscribeAuth();
      unsubscribeFirestore();
      unsubRealtimeAction();
      unsubRealtimeState();
      unsubRealtimeNotif();
      if (eventSource) {
        eventSource.close();
      }
    };
  }, []);

  // --- AUTOMATIC KNOCKOUT PROGRESSION (AUTO LLAVES ADVANCEMENT) ---
  const autoAdvanceLlaves = (currentTourId: string, currentMatches: Match[]): Match[] => {
    const tourLlaves = currentMatches.filter(m => m.tournamentId === currentTourId && m.isLlave === true);
    if (tourLlaves.length === 0) return currentMatches;

    const llavesByRound: Record<string, Match[]> = {};
    tourLlaves.forEach(m => {
      if (!llavesByRound[m.round]) llavesByRound[m.round] = [];
      llavesByRound[m.round].push(m);
    });

    let updatedMatches = [...currentMatches];
    let changed = false;

    for (const [roundName, roundMatches] of Object.entries(llavesByRound)) {
      const totalMatches = roundMatches.length;
      // We only advance standard knockout powers of 2 (1, 2, 4, 8, 16)
      if (totalMatches < 2 || (totalMatches & (totalMatches - 1)) !== 0) {
        continue;
      }

      const allPlayed = roundMatches.every(m => {
        if (!m.played || m.scoreA === null || m.scoreB === null) return false;
        if (m.scoreA === m.scoreB) {
          return m.penaltiesA !== undefined && m.penaltiesB !== undefined && m.penaltiesA !== null && m.penaltiesB !== null && m.penaltiesA !== m.penaltiesB;
        }
        return true;
      });
      if (!allPlayed) continue;

      const sortedMatches = [...roundMatches].sort((a, b) => a.id.localeCompare(b.id));

      const winners: string[] = sortedMatches.map(m => {
        if ((m.scoreA ?? 0) > (m.scoreB ?? 0)) return m.teamAId;
        if ((m.scoreB ?? 0) > (m.scoreA ?? 0)) return m.teamBId;
        const penA = m.penaltiesA ?? 0;
        const penB = m.penaltiesB ?? 0;
        if (penA > penB) return m.teamAId;
        if (penB > penA) return m.teamBId;
        return m.teamAId; // fallback
      }).filter(Boolean);

      if (winners.length !== totalMatches) continue;

      const nextMatchesCount = totalMatches / 2;
      let nextRoundName = '';
      if (nextMatchesCount === 4) nextRoundName = 'Cuartos de Final';
      else if (nextMatchesCount === 2) nextRoundName = 'Semifinales';
      else if (nextMatchesCount === 1) nextRoundName = 'Final';
      else nextRoundName = `Fase Siguiente (${nextMatchesCount})`;

      const existingNextRoundMatches = updatedMatches.filter(
        m => m.tournamentId === currentTourId && m.isLlave === true && m.round === nextRoundName
      );

      if (existingNextRoundMatches.length === nextMatchesCount) {
        const sortedNextMatches = [...existingNextRoundMatches].sort((a, b) => a.id.localeCompare(b.id));
        let modifiedNextRound = false;

        for (let i = 0; i < nextMatchesCount; i++) {
          const nextMatch = sortedNextMatches[i];
          const expectedTeamA = winners[i * 2];
          const expectedTeamB = winners[i * 2 + 1];

          if (nextMatch.teamAId !== expectedTeamA || nextMatch.teamBId !== expectedTeamB) {
            updatedMatches = updatedMatches.map(m => {
              if (m.id === nextMatch.id) {
                return {
                  ...m,
                  teamAId: expectedTeamA,
                  teamBId: expectedTeamB,
                  scoreA: m.teamAId !== expectedTeamA ? null : m.scoreA,
                  scoreB: m.teamBId !== expectedTeamB ? null : m.scoreB,
                  played: m.teamAId !== expectedTeamA || m.teamBId !== expectedTeamB ? false : m.played
                };
              }
              return m;
            });
            modifiedNextRound = true;
          }
        }

        if (modifiedNextRound) {
          changed = true;
        }
      } else if (existingNextRoundMatches.length === 0) {
        const newNextMatches: Match[] = [];
        for (let i = 0; i < nextMatchesCount; i++) {
          newNextMatches.push({
            id: `m-llave-auto-${Date.now()}-${nextRoundName.replace(/\s+/g, '-')}-${i}`,
            tournamentId: currentTourId,
            teamAId: winners[i * 2],
            teamBId: winners[i * 2 + 1],
            scoreA: null,
            scoreB: null,
            played: false,
            round: nextRoundName,
            isLlave: true
          });
        }

        updatedMatches = [...updatedMatches, ...newNextMatches];
        changed = true;
      }
    }

    if (changed) {
      return autoAdvanceLlaves(currentTourId, updatedMatches);
    }

    return updatedMatches;
  };

  // --- SERIALIZED & THROTTLED FIRESTORE WRITE STREAM MANAGER ---
  const pendingFirestorePayloadRef = useRef<any>(null);
  const isFirestoreSavingRef = useRef<boolean>(false);
  const firestoreDebounceTimerRef = useRef<any>(null);

  const executeQueuedFirestoreSave = async () => {
    if (isFirestoreSavingRef.current || !pendingFirestorePayloadRef.current) {
      return;
    }
    const payloadToSave = pendingFirestorePayloadRef.current;
    pendingFirestorePayloadRef.current = null;
    isFirestoreSavingRef.current = true;

    try {
      await setDoc(doc(db, 'app_state', 'main'), payloadToSave, { merge: true });
    } catch (err: any) {
      console.warn("Firestore queued write notice:", err?.message || err);
      // If temporary backend backoff/throttle occurs, keep payload to retry safely
      if (!pendingFirestorePayloadRef.current) {
        pendingFirestorePayloadRef.current = payloadToSave;
      }
    } finally {
      isFirestoreSavingRef.current = false;
      // If further state changes accumulated while save was in progress, execute next sync
      if (pendingFirestorePayloadRef.current) {
        setTimeout(executeQueuedFirestoreSave, 350);
      }
    }
  };

  const queueFirestoreSave = (payload: any) => {
    pendingFirestorePayloadRef.current = payload;
    if (firestoreDebounceTimerRef.current) {
      clearTimeout(firestoreDebounceTimerRef.current);
    }
    firestoreDebounceTimerRef.current = setTimeout(() => {
      executeQueuedFirestoreSave();
    }, 250);
  };

  // --- SAVE PERSISTENCE & REAL-TIME 1:1 CLOUD BROADCAST ---
  const saveState = async (
    updatedTeams: Team[], 
    updatedTournaments: Tournament[], 
    updatedMatches: Match[],
    optionalNotifText?: string,
    tournamentIdForNotif?: string
  ) => {
    // Auto-advance any LLAVES in the tournament if a phase has been completed
    let processedMatches = [...updatedMatches];
    updatedTournaments.forEach(tour => {
      processedMatches = autoAdvanceLlaves(tour.id, processedMatches);
    });

    // Recursively clean all collections for Firestore compatibility (removes undefined fields)
    const cleanTeams = cleanForFirestore(updatedTeams) as Team[];
    const cleanTournaments = cleanForFirestore(updatedTournaments) as Tournament[];
    const cleanMatches = cleanForFirestore(processedMatches) as Match[];

    const now = Date.now();
    lastStateTimestampRef.current = now;
    try {
      localStorage.setItem('playgol_last_updated', String(now));
    } catch {}

    // Snappy UI state updates locally
    setTeams(cleanTeams);
    setTournaments(cleanTournaments);
    setMatches(cleanMatches);

    // Save to local cache immediately to prevent loss on refresh
    try {
      localStorage.setItem('playgol_teams_cache', JSON.stringify(cleanTeams));
      localStorage.setItem('playgol_tournaments_cache', JSON.stringify(cleanTournaments));
      localStorage.setItem('playgol_matches_cache', JSON.stringify(cleanMatches));
    } catch {}

    let updatedNotifs = notifications;
    let createdNotif: AppNotification | undefined;

    if (optionalNotifText) {
      createdNotif = {
        id: `notif-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        text: optionalNotifText,
        timestamp: Date.now(),
        tournamentId: tournamentIdForNotif
      };
      updatedNotifs = [createdNotif, ...notifications].slice(0, 50);
      setNotifications(updatedNotifs);
    }

    // 1. Instant sub-100ms 1:1 real-time sync broadcast over MQTT
    realtimeSync.publishState({
      teams: cleanTeams,
      tournaments: cleanTournaments,
      matches: cleanMatches,
      notifications: updatedNotifs,
      notification: createdNotif,
      timestamp: Date.now()
    });

    // 2. Sync state to Cloud Server backend and broadcast via SSE as backup
    try {
      await fetch(getApiUrl('/api/state'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          teams: cleanTeams, 
          tournaments: cleanTournaments, 
          matches: cleanMatches,
          notifications: updatedNotifs,
          notification: createdNotif
        })
      });
    } catch (err) {
      console.warn("Could not post state to cloud:", err);
    }

    // 3. Guaranteed Master State Cloud Persistence in Firestore via queued single-document stream
    queueFirestoreSave({
      teams: cleanTeams,
      tournaments: cleanTournaments,
      matches: cleanMatches,
      notifications: updatedNotifs,
      lastNotification: createdNotif || null,
      updatedAt: Date.now()
    });
  };

  const sendNotification = async (text: string, tournamentId?: string) => {
    const newNotif: AppNotification = {
      id: `notif-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      text,
      timestamp: Date.now(),
      tournamentId
    };

    const updatedNotifications = [newNotif, ...notifications.filter(n => n.id !== newNotif.id)].slice(0, 50);
    setNotifications(updatedNotifications);
    setActiveCloudNotif(newNotif);

    // Instant broadcast via realtime MQTT
    realtimeSync.publishNotification(newNotif);

    // Broadcast through Cloud Server SSE endpoint
    try {
      await fetch(getApiUrl('/api/notify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notification: newNotif })
      });
    } catch (err) {
      console.warn("Error posting notification to cloud:", err);
    }

    // Queue in master state rather than unthrottled raw doc write
    queueFirestoreSave({
      notifications: updatedNotifications,
      lastNotification: newNotif,
      updatedAt: Date.now()
    });
  };

  const handleClearAllNotifications = async () => {
    setNotifications([]);
    setActiveCloudNotif(null);
    realtimeSync.publishState({
      teams,
      tournaments,
      matches,
      notifications: [],
      timestamp: Date.now()
    });
    try {
      await fetch(getApiUrl('/api/state'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teams,
          tournaments,
          matches,
          notifications: []
        })
      });
    } catch {}
    
    queueFirestoreSave({
      notifications: [],
      lastNotification: null,
      updatedAt: Date.now()
    });
  };

  // --- LOGIN LOGIC ---
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) {
      setLoginError('Por favor ingresa una contraseña.');
      return;
    }

    let targetEmail = '';
    let targetRole: 'admin' | 'visitor' = 'visitor';
    if (password === 'Admingol') {
      targetEmail = 'admin@playgol.com';
      targetRole = 'admin';
    } else if (password === 'Visitagol') {
      targetEmail = 'visitor@playgol.com';
      targetRole = 'visitor';
    } else {
      setLoginError('Contraseña incorrecta.');
      return;
    }

    // Set local state and session storage immediately so login is guaranteed to succeed and show the app instantly!
    setRole(targetRole);
    sessionStorage.setItem('playgol_role', targetRole);
    setLoginError('');

    // Always redirect to tournament list view upon login
    setActiveTab('tournaments');
    setSelectedTournamentId(null);

    try {
      // Background attempt to sign in to Firebase Auth
      await signInWithEmailAndPassword(auth, targetEmail, password);
    } catch (authErr: any) {
      // Background attempt to register user if not found
      if (authErr.code === 'auth/user-not-found' || authErr.code === 'auth/invalid-credential' || authErr.code === 'auth/invalid-email') {
        try {
          await createUserWithEmailAndPassword(auth, targetEmail, password);
        } catch (createErr: any) {
          console.log("Firebase Auth background registration info:", createErr.message || createErr);
        }
      } else {
        console.log("Firebase Auth background sign-in info (falling back to local session):", authErr.message || authErr);
      }
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setRole(null);
      sessionStorage.removeItem('playgol_role');
      sessionStorage.removeItem('playgol_unlocked_tournaments');
      setUnlockedTournaments({});
      setPassword('');
      setSelectedTournamentId(null);
      setActiveTab('tournaments');
    } catch (err) {
      console.error("Error signing out from Firebase Auth:", err);
    }
  };

  // --- IMAGE UPLOAD HELPER (downscales to optimal compact Base64 Data URL stored permanently in Firestore Cloud DB) ---
  const compressAndUploadImage = (file: File, callback: (imageUrl: string) => void) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_SIZE = 160; // Crisp resolution for club shields and tournament logos
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_SIZE) {
            height = Math.round(height * (MAX_SIZE / width));
            width = MAX_SIZE;
          }
        } else {
          if (height > MAX_SIZE) {
            width = Math.round(width * (MAX_SIZE / height));
            height = MAX_SIZE;
          }
        }

        canvas.width = Math.max(1, width);
        canvas.height = Math.max(1, height);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, width, height);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, width, height);

          // Try webp first for maximum compression quality with alpha channel (~6KB - 15KB)
          let dataUrl = canvas.toDataURL('image/webp', 0.88);
          if (!dataUrl.startsWith('data:image/webp') || dataUrl.length < 100) {
            dataUrl = canvas.toDataURL('image/png');
          }
          // The base64 data URI is stored directly in the Firestore database document,
          // which ensures 100% permanent persistence across cloud deployments, container restarts,
          // and all mobile/desktop devices without depending on ephemeral local disk files.
          callback(dataUrl);
        }
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      compressAndUploadImage(file, (base64) => {
        setNewTeam(prev => ({ ...prev, logoUrl: base64 }));
      });
    }
  };

  // --- EDIT ACTIONS ---
  const handleEditTournament = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTournament || !editingTournament.name.trim()) return;

    const updatedTour: Tournament = {
      ...editingTournament,
      name: editingTournament.name.trim(),
      numGroups: editingTournament.type === 'GRUPOS' ? Number(editingTournament.numGroups || 2) : undefined,
      numTeams: (editingTournament.type === 'LIGA' || editingTournament.type === 'ELIMINACION_DIRECTA') ? Number(editingTournament.numTeams || 8) : undefined,
      faseFinalType: editingTournament.type === 'FASE_FINAL' ? editingTournament.faseFinalType : undefined,
    };

    const updated = tournaments.map(t => {
      if (t.id === editingTournament.id) {
        return updatedTour;
      }
      return t;
    });

    const notif = `Se actualizaron los datos del torneo: ${editingTournament.name.trim()}`;
    realtimeSync.publishAction({
      type: 'TOURNAMENT_UPDATE',
      tournament: updatedTour,
      notifText: notif,
      timestamp: Date.now()
    });

    saveState(teams, updated, matches, notif, editingTournament.id);
    setEditingTournament(null);
  };

  const handleEditTeam = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTeam || !editingTeam.name.trim()) return;

    const updatedClub: Team = {
      ...editingTeam,
      name: editingTeam.name.trim()
    };

    const updated = teams.map(t => {
      if (t.id === editingTeam.id) {
        return updatedClub;
      }
      return t;
    });

    const notif = `Se actualizaron los datos del club: ${editingTeam.name.trim()}`;
    realtimeSync.publishAction({
      type: 'TEAM_UPDATE',
      team: updatedClub,
      notifText: notif,
      timestamp: Date.now()
    });

    saveState(updated, tournaments, matches, notif);
    setEditingTeam(null);
  };

  // --- MANUAL MATCH CREATION ---
  const handleCreateManualMatch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkCanEdit(selectedTournamentId)) {
      alert('No tienes permisos de administración para este torneo.');
      return;
    }
    if (!selectedTournamentId || !newMatchState.teamAId || !newMatchState.teamBId) {
      alert('Por favor selecciona ambos equipos.');
      return;
    }
    if (newMatchState.teamAId === newMatchState.teamBId) {
      alert('No puedes crear un partido con el mismo equipo.');
      return;
    }

    const created: Match = {
      id: `m-manual-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      tournamentId: selectedTournamentId,
      teamAId: newMatchState.teamAId,
      teamBId: newMatchState.teamBId,
      scoreA: null,
      scoreB: null,
      played: false,
      round: (newMatchState.round || '').trim() || 'Fecha 1',
      group: currentTour?.type === 'GRUPOS' ? newMatchState.group : undefined,
      freeTeamId: newMatchState.freeTeamId || undefined,
      time: newMatchState.time?.trim() || undefined,
      venue: newMatchState.venue?.trim() || undefined
    };

    // Auto-ensure selected teams are present in currentTour.teams
    let updatedTours = tournaments;
    if (currentTour) {
      const tourTeams = currentTour.teams || [];
      const hasA = tourTeams.some(tt => tt.teamId === newMatchState.teamAId);
      const hasB = tourTeams.some(tt => tt.teamId === newMatchState.teamBId);
      if (!hasA || !hasB) {
        const newTeams = [...tourTeams];
        if (!hasA) newTeams.push({ teamId: newMatchState.teamAId, group: currentTour.type === 'GRUPOS' ? newMatchState.group : undefined });
        if (!hasB) newTeams.push({ teamId: newMatchState.teamBId, group: currentTour.type === 'GRUPOS' ? newMatchState.group : undefined });
        updatedTours = tournaments.map(t => t.id === currentTour.id ? { ...t, teams: newTeams } : t);
      }
    }

    realtimeSync.publishAction({
      type: 'MATCH_ADD',
      match: created,
      timestamp: Date.now()
    });

    saveState(teams, updatedTours, [...matches, created]);
    
    // Trigger notification
    const tour = updatedTours.find(t => t.id === selectedTournamentId);
    const teamAName = teams.find(t => t.id === newMatchState.teamAId)?.name || 'Equipo A';
    const teamBName = teams.find(t => t.id === newMatchState.teamBId)?.name || 'Equipo B';
    if (tour) {
      sendNotification(`Actualización del torneo ${tour.name}: Se programó un nuevo enfrentamiento: ${teamAName} vs ${teamBName}`, tour.id);
    }

    setShowManualMatchModal(false);
    // Reset state
    setNewMatchState({
      teamAId: '',
      teamBId: '',
      round: 'Fecha 1',
      scoreA: '',
      scoreB: '',
      played: false,
      group: 'A',
      freeTeamId: '',
      time: '',
      venue: ''
    });
  };

  const handleDeleteMatch = (matchId: string) => {
    const match = matches.find(m => m.id === matchId);
    if (!checkCanEdit(match?.tournamentId)) return;
    showConfirm(
      '¿Eliminar Partido?',
      '¿Está seguro de querer eliminar este partido de la programación?',
      () => {
        realtimeSync.publishAction({
          type: 'MATCH_DELETE',
          matchId,
          timestamp: Date.now()
        });
        const updatedMatches = matches.filter(m => m.id !== matchId);
        saveState(teams, tournaments, updatedMatches);
      }
    );
  };

  const handleSaveBracketPairings = (e: React.FormEvent) => {
    e.preventDefault();
    if (!bracketPairingTour) return;

    // Validate pairings
    for (let i = 0; i < bracketPairings.length; i++) {
      if (!bracketPairings[i].teamAId || !bracketPairings[i].teamBId) {
        alert('Por favor complete la selección de equipos para todos los partidos.');
        return;
      }
      if (bracketPairings[i].teamAId === bracketPairings[i].teamBId) {
        alert(`El Partido ${i + 1} tiene el mismo equipo seleccionado para ambos lados.`);
        return;
      }
    }

    const generated: Match[] = [];
    bracketPairings.forEach((pair, i) => {
      generated.push({
        id: `m-${bracketPairingTour.id}-bracket-${bracketRoundName}-${i}`,
        tournamentId: bracketPairingTour.id,
        teamAId: pair.teamAId,
        teamBId: pair.teamBId,
        scoreA: null,
        scoreB: null,
        played: false,
        round: bracketRoundName,
        bracketSlot: i
      });
    });

    const otherMatches = matches.filter(m => m.tournamentId !== bracketPairingTour.id);
    saveState(teams, tournaments, [...otherMatches, ...generated]);
    sendNotification(`Actualización del torneo ${bracketPairingTour.name}: Se definieron los emparejamientos del árbol de eliminación (${bracketRoundName})`, bracketPairingTour.id);
    setShowBracketPairingModal(false);
    setBracketPairingTour(null);
    setTournamentSubTab('bracket');
  };

  // --- FIXTURE ROUND ROBIN SCHEDULER ---
  function generateRoundRobinMatches(tournamentId: string, teamIds: string[], group?: string): Match[] {
    let list = [...teamIds];
    if (list.length % 2 !== 0) {
      list.push('BYE');
    }
    const numTeams = list.length;
    const rounds = numTeams - 1;
    const half = numTeams / 2;
    const matchesList: Match[] = [];

    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < half; i++) {
        const a = list[i];
        const b = list[numTeams - 1 - i];
        if (a !== 'BYE' && b !== 'BYE') {
          matchesList.push({
            id: `m-${tournamentId}-${group || 'L'}-${r}-${i}-${Math.random().toString(36).substr(2, 4)}`,
            tournamentId,
            teamAId: a,
            teamBId: b,
            scoreA: null,
            scoreB: null,
            played: false,
            group,
            round: `Jornada ${r + 1}`
          });
        }
      }
      list = [list[0], list[numTeams - 1], ...list.slice(1, numTeams - 1)];
    }
    return matchesList;
  }

  // --- AUTOMATIC FIXTURE TRIGGER ---
  const handleGenerateFixture = (tour: Tournament) => {
    if (!checkCanEdit(tour.id)) return;
    
    showConfirm(
      'Generar Fixture Automático',
      '¿Deseas generar el fixture automático para este torneo? Esto borrará los partidos existentes de este torneo.',
      () => {
        let generated: Match[] = [];

        if (tour.type === 'LIGA') {
          const ids = tour.teams.map(t => t.teamId);
          if (ids.length < 2) {
            alert('Asigna al menos 2 equipos para poder generar el fixture.');
            return;
          }
          generated = generateRoundRobinMatches(tour.id, ids);
        } else if (tour.type === 'GRUPOS') {
          const groups = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].slice(0, tour.numGroups || 2);
          groups.forEach(g => {
            const ids = tour.teams.filter(t => t.group === g).map(t => t.teamId);
            if (ids.length >= 2) {
              generated.push(...generateRoundRobinMatches(tour.id, ids, g));
            }
          });
          if (generated.length === 0) {
            alert('Asegúrate de asignar al menos 2 equipos a cada grupo.');
            return;
          }
        } else if (tour.type === 'ELIMINACION_DIRECTA' || tour.type === 'FASE_FINAL') {
          // Determine starting round name and number of matches
          let stage: 'octavos' | 'cuartos' | 'semis' | 'final' = 'semis';
          if (tour.type === 'FASE_FINAL') {
            stage = tour.faseFinalType || 'semis';
          } else {
            // Direct elimination size based on assigned teams
            const n = tour.teams.length;
            if (n > 8) stage = 'octavos';
            else if (n > 4) stage = 'cuartos';
            else if (n > 2) stage = 'semis';
            else stage = 'final';
          }

          let matchesCount = 2;
          let roundName = 'Semifinal';
          if (stage === 'octavos') { matchesCount = 8; roundName = 'Octavos'; }
          else if (stage === 'cuartos') { matchesCount = 4; roundName = 'Cuartos'; }
          else if (stage === 'semis') { matchesCount = 2; roundName = 'Semifinal'; }
          else { matchesCount = 1; roundName = 'Final'; }

          const assignedIds = tour.teams.map(t => t.teamId);
          
          const initialPairings = [];
          for (let i = 0; i < matchesCount; i++) {
            initialPairings.push({
              teamAId: assignedIds[i * 2] || '',
              teamBId: assignedIds[i * 2 + 1] || ''
            });
          }

          setBracketPairingTour(tour);
          setBracketRoundName(roundName);
          setBracketPairings(initialPairings);
          setShowBracketPairingModal(true);
          return;
        }

        const otherMatches = matches.filter(m => m.tournamentId !== tour.id);
        saveState(teams, tournaments, [...otherMatches, ...generated]);
        sendNotification(`Actualización del torneo ${tour.name}: Se generó el fixture completo del torneo`, tour.id);
        setTournamentSubTab(tour.type === 'LIGA' || tour.type === 'GRUPOS' ? 'matches' : 'bracket');
      },
      'Generar Fixture',
      'Cancelar'
    );
  };

  // --- TEAM ACTIONS ---
  const handleCreateTeam = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTeam.name.trim()) return;

    const created: Team = {
      id: `team-${Date.now()}`,
      name: newTeam.name.trim(),
      primaryColor: newTeam.primaryColor,
      secondaryColor: newTeam.secondaryColor,
      badgeSymbol: newTeam.badgeSymbol,
      logoUrl: newTeam.logoUrl || undefined
    };

    const notif = `Nuevo club registrado en la plataforma: ${created.name}`;
    realtimeSync.publishAction({
      type: 'TEAM_CREATE',
      team: created,
      notifText: notif,
      timestamp: Date.now()
    });

    saveState([...teams, created], tournaments, matches, notif);
    setNewTeam({ name: '', primaryColor: '#10b981', secondaryColor: '#1f2937', badgeSymbol: 'ball', logoUrl: '' });
    setShowTeamModal(false);
  };

  const handleDeleteTeam = (id: string) => {
    if (role !== 'admin') return;
    const team = teams.find(t => t.id === id);
    const teamName = team ? `"${team.name}"` : "este club";
    showConfirm(
      '¿Eliminar Club?',
      `¿Está seguro de querer eliminar ${teamName}? Se eliminará de los torneos y partidos asociados de forma permanente.`,
      () => {
        const filteredTeams = teams.filter(t => t.id !== id);
        // Remove from tournaments
        const updatedTournaments = tournaments.map(tour => ({
          ...tour,
          teams: tour.teams.filter(tt => tt.teamId !== id)
        }));
        // Remove from matches
        const filteredMatches = matches.filter(m => m.teamAId !== id && m.teamBId !== id);

        realtimeSync.publishAction({
          type: 'TEAM_DELETE',
          teamId: id,
          timestamp: Date.now()
        });

        saveState(filteredTeams, updatedTournaments, filteredMatches);
      }
    );
  };

  // --- TOURNAMENT ACTIONS ---
  const handleCreateTournament = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTournament.name.trim()) return;

    const created: Tournament = {
      id: `tour-${Date.now()}`,
      name: newTournament.name.trim(),
      type: newTournament.type,
      numGroups: newTournament.type === 'GRUPOS' ? Number(newTournament.numGroups) : undefined,
      numTeams: (newTournament.type === 'LIGA' || newTournament.type === 'ELIMINACION_DIRECTA') ? Number(newTournament.numTeams) : undefined,
      faseFinalType: newTournament.type === 'FASE_FINAL' ? newTournament.faseFinalType : undefined,
      teams: [],
      logoUrl: newTournament.logoUrl || undefined,
      adminPassword: newTournament.adminPassword.trim() || undefined,
      visitorPassword: newTournament.visitorPassword.trim() || undefined
    };

    const notif = `Nuevo torneo creado: ${created.name}`;
    realtimeSync.publishAction({
      type: 'TOURNAMENT_CREATE',
      tournament: created,
      notifText: notif,
      timestamp: Date.now()
    });

    saveState(teams, [...tournaments, created], matches, notif, created.id);
    setSelectedTournamentId(created.id);
    setNewTournament({ name: '', type: 'LIGA', numGroups: 2, numTeams: 8, faseFinalType: 'semis', logoUrl: '', adminPassword: '', visitorPassword: '' });
    setShowTournamentModal(false);
    setTournamentSubTab('matches');
  };

  const handleDeleteTournament = (id: string) => {
    if (role !== 'admin') return;
    const tour = tournaments.find(t => t.id === id);
    const tourName = tour ? `"${tour.name}"` : "este torneo";
    showConfirm(
      '¿Eliminar Torneo?',
      `¿Está seguro de querer eliminar ${tourName}? Se borrarán también todos sus partidos de forma permanente.`,
      () => {
        const updatedTours = tournaments.filter(t => t.id !== id);
        const updatedMatches = matches.filter(m => m.tournamentId !== id);
        if (selectedTournamentId === id) {
          setSelectedTournamentId(null);
        }

        realtimeSync.publishAction({
          type: 'TOURNAMENT_DELETE',
          tournamentId: id,
          timestamp: Date.now()
        });

        saveState(teams, updatedTours, updatedMatches);
      }
    );
  };

  // --- TOURNAMENT PASSWORD ACCESS SYSTEM ---
  const handleSelectTournament = (tour: Tournament) => {
    // If general admin, bypass password check and give full admin privileges
    if (role === 'admin') {
      setSelectedTournamentId(tour.id);
      setTournamentSubTab('matches');
      return;
    }

    // If the tournament has no passwords set, anyone can view it as public visitor
    const hasAdminPass = !!tour.adminPassword;
    const hasVisitorPass = !!tour.visitorPassword;
    if (!hasAdminPass && !hasVisitorPass) {
      // Free public access
      setTournamentAccess(tour.id, 'Visitante');
      setSelectedTournamentId(tour.id);
      setTournamentSubTab('matches');
      return;
    }

    // If already unlocked in this session, enter directly
    if (unlockedTournaments[tour.id]) {
      setSelectedTournamentId(tour.id);
      setTournamentSubTab('matches');
      return;
    }

    // Otherwise, prompt for the tournament password
    setPasswordCheckingTourId(tour.id);
    setTourPasswordValue('');
    setTourPasswordError('');
    setShowTourPassword(false);
  };

  const handleVerifyTournamentPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordCheckingTourId) return;

    const tour = tournaments.find(t => t.id === passwordCheckingTourId);
    if (!tour) return;

    const inputPass = tourPasswordValue.trim();
    const adminPass = tour.adminPassword?.trim();
    const visitorPass = tour.visitorPassword?.trim();

    // Check matches
    if (adminPass && inputPass === adminPass) {
      setTournamentAccess(tour.id, 'AdminTorneo');
      setSelectedTournamentId(tour.id);
      setPasswordCheckingTourId(null);
      setTournamentSubTab('matches');
    } else if (visitorPass && inputPass === visitorPass) {
      setTournamentAccess(tour.id, 'Visitante');
      setSelectedTournamentId(tour.id);
      setPasswordCheckingTourId(null);
      setTournamentSubTab('matches');
    } else {
      setTourPasswordError('Contraseña de torneo incorrecta.');
    }
  };

  // --- MANUAL LLAVE CREATION ---
  const handleCreateManualLlave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkCanEdit(selectedTournamentId)) {
      alert('No tienes permisos de administración para este torneo.');
      return;
    }
    if (!selectedTournamentId || !manualLlaveState.teamAId || !manualLlaveState.teamBId) {
      alert('Por favor selecciona ambos equipos.');
      return;
    }
    if (manualLlaveState.teamAId === manualLlaveState.teamBId) {
      alert('El equipo local y visitante no pueden ser el mismo.');
      return;
    }

    const hasScores = manualLlaveState.scoreA !== '' && manualLlaveState.scoreB !== '';
    const created: Match = {
      id: `match-${Date.now()}`,
      tournamentId: selectedTournamentId,
      teamAId: manualLlaveState.teamAId,
      teamBId: manualLlaveState.teamBId,
      scoreA: hasScores ? Number(manualLlaveState.scoreA) : null,
      scoreB: hasScores ? Number(manualLlaveState.scoreB) : null,
      played: hasScores,
      round: manualLlaveState.phaseName.trim() || 'Segunda Fase',
      isLlave: true
    };

    // Auto-ensure selected teams are present in currentTour.teams
    let updatedTours = tournaments;
    if (currentTour) {
      const tourTeams = currentTour.teams || [];
      const hasA = tourTeams.some(tt => tt.teamId === manualLlaveState.teamAId);
      const hasB = tourTeams.some(tt => tt.teamId === manualLlaveState.teamBId);
      if (!hasA || !hasB) {
        const newTeams = [...tourTeams];
        if (!hasA) newTeams.push({ teamId: manualLlaveState.teamAId });
        if (!hasB) newTeams.push({ teamId: manualLlaveState.teamBId });
        updatedTours = tournaments.map(t => t.id === currentTour.id ? { ...t, teams: newTeams } : t);
      }
    }

    saveState(teams, updatedTours, [...matches, created]);
    const tourForLlave = updatedTours.find(t => t.id === selectedTournamentId);
    const teamAName = teams.find(t => t.id === manualLlaveState.teamAId)?.name || 'Equipo A';
    const teamBName = teams.find(t => t.id === manualLlaveState.teamBId)?.name || 'Equipo B';
    if (tourForLlave) {
      sendNotification(`Actualización del torneo ${tourForLlave.name}: Se programó un nuevo cruce de eliminación directa (${created.round}): ${teamAName} vs ${teamBName}`, tourForLlave.id);
    }
    setShowAddManualLlaveModal(false);
    setManualLlaveState({
      phaseName: 'Segunda Fase',
      teamAId: '',
      teamBId: '',
      scoreA: '',
      scoreB: '',
      played: false
    });
  };

  // --- ASSIGN TEAM TO TOURNAMENT ---
  const handleAssignTeam = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTournamentId || !assignTeamState.teamId) {
      alert('Por favor selecciona un equipo.');
      return;
    }

    const tour = tournaments.find(t => t.id === selectedTournamentId);
    if (!tour) return;

    // Check if already assigned
    if (tour.teams.some(t => t.teamId === assignTeamState.teamId)) {
      alert('Este equipo ya está asignado a este torneo.');
      return;
    }

    const updatedTours = tournaments.map(t => {
      if (t.id === selectedTournamentId) {
        return {
          ...t,
          teams: [...t.teams, {
            teamId: assignTeamState.teamId,
            group: t.type === 'GRUPOS' ? assignTeamState.group : undefined
          }]
        };
      }
      return t;
    });

    saveState(teams, updatedTours, matches);
    const assignedTeamObj = teams.find(t => t.id === assignTeamState.teamId);
    if (assignedTeamObj) {
      sendNotification(`Actualización del torneo ${tour.name}: Se integró a ${assignedTeamObj.name} a la competencia`, tour.id);
    }
    setShowAssignModal(false);
    setAssignTeamState({ teamId: '', group: 'A' });
  };

  const handleRemoveTeamFromTournament = (teamId: string) => {
    if (!checkCanEdit(selectedTournamentId) || !selectedTournamentId) return;
    const team = teams.find(t => t.id === teamId);
    const teamName = team ? `"${team.name}"` : "este equipo";
    showConfirm(
      '¿Desvincular Equipo?',
      `¿Está seguro de querer desvincular ${teamName} de este torneo?`,
      () => {
        const updatedTours = tournaments.map(t => {
          if (t.id === selectedTournamentId) {
            return {
              ...t,
              teams: t.teams.filter(tt => tt.teamId !== teamId)
            };
          }
          return t;
        });

        const updatedMatches = matches.filter(m => 
          !(m.tournamentId === selectedTournamentId && (m.teamAId === teamId || m.teamBId === teamId))
        );

        saveState(teams, updatedTours, updatedMatches);
      }
    );
  };

  // --- MATCH SCORE SUBMISSION & BRACKET AUTO-ADVANCEMENT ---
  const handleOpenEditMatchDetails = (match: Match) => {
    setEditingMatchDetails(match);
    setMatchDetailsState({
      round: match.round,
      teamAId: match.teamAId,
      teamBId: match.teamBId,
      group: match.group || 'A',
      scoreA: match.scoreA !== null ? String(match.scoreA) : '',
      scoreB: match.scoreB !== null ? String(match.scoreB) : '',
      penaltiesA: match.penaltiesA !== null && match.penaltiesA !== undefined ? String(match.penaltiesA) : '',
      penaltiesB: match.penaltiesB !== null && match.penaltiesB !== undefined ? String(match.penaltiesB) : '',
      overrideTeams: (match as any).overrideTeams || false,
      freeTeamId: match.freeTeamId || '',
      time: match.time || '',
      venue: match.venue || ''
    });
  };

  const handleSaveMatchDetails = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMatchDetails) return;

    const sA = matchDetailsState.scoreA.trim() !== '' ? Number(matchDetailsState.scoreA) : null;
    const sB = matchDetailsState.scoreB.trim() !== '' ? Number(matchDetailsState.scoreB) : null;
    const penA = matchDetailsState.penaltiesA.trim() !== '' ? Number(matchDetailsState.penaltiesA) : null;
    const penB = matchDetailsState.penaltiesB.trim() !== '' ? Number(matchDetailsState.penaltiesB) : null;
    const isPlayed = sA !== null && sB !== null;

    const exists = matches.some(m => m.id === editingMatchDetails.id);
    let updated: Match[];

    if (exists) {
      updated = matches.map(m => {
        if (m.id === editingMatchDetails.id) {
          return {
            ...m,
            round: matchDetailsState.round.trim() || m.round,
            teamAId: matchDetailsState.teamAId,
            teamBId: matchDetailsState.teamBId,
            scoreA: sA,
            scoreB: sB,
            penaltiesA: penA,
            penaltiesB: penB,
            played: isPlayed,
            group: currentTour?.type === 'GRUPOS' ? matchDetailsState.group : undefined,
            overrideTeams: matchDetailsState.overrideTeams,
            freeTeamId: matchDetailsState.freeTeamId || undefined,
            time: matchDetailsState.time.trim() || undefined,
            venue: matchDetailsState.venue.trim() || undefined
          } as any;
        }
        return m;
      });
    } else {
      const newMatch: Match = {
        ...editingMatchDetails,
        round: matchDetailsState.round.trim() || editingMatchDetails.round,
        teamAId: matchDetailsState.teamAId,
        teamBId: matchDetailsState.teamBId,
        scoreA: sA,
        scoreB: sB,
        penaltiesA: penA,
        penaltiesB: penB,
        played: isPlayed,
        group: undefined,
        overrideTeams: matchDetailsState.overrideTeams,
        freeTeamId: matchDetailsState.freeTeamId || undefined,
        time: matchDetailsState.time.trim() || undefined,
        venue: matchDetailsState.venue.trim() || undefined
      } as any;
      updated = [...matches, newMatch];
    }

    const tour = tournaments.find(t => t.id === editingMatchDetails.tournamentId);
    const teamA = teams.find(t => t.id === matchDetailsState.teamAId)?.name || 'Equipo A';
    const teamB = teams.find(t => t.id === matchDetailsState.teamBId)?.name || 'Equipo B';

    const notifText = tour ? (
      isPlayed ? (
        `Actualización del torneo ${tour.name}: Se actualizó el resultado: ${teamA} ${sA} - ${sB} ${teamB}${penA !== null && penB !== null ? ` (Pen: ${penA} - ${penB})` : ''}`
      ) : (
        `Actualización del torneo ${tour.name}: Se modificaron los detalles del partido ${teamA} vs ${teamB}`
      )
    ) : undefined;

    realtimeSync.publishAction({
      type: 'MATCHES_UPDATE',
      tournamentId: editingMatchDetails.tournamentId,
      matches: updated.filter(m => m.tournamentId === editingMatchDetails.tournamentId),
      notifText,
      timestamp: Date.now()
    });

    saveState(teams, tournaments, updated, notifText, editingMatchDetails.tournamentId);

    setEditingMatchDetails(null);
  };

  // --- RESOLVE ANY BRACKET SOURCE TO REAL-TIME STANDINGS TEAM ---
  const resolveBracketSource = (
    tourId: string,
    sourceKey: string
  ): { teamId: string; team?: Team; label: string; stats?: string; isQualified: boolean } => {
    if (!sourceKey || sourceKey === 'TBD') {
      return { teamId: '', label: 'Por definir (TBD)', isQualified: false };
    }

    if (sourceKey.startsWith('TEAM:')) {
      const tId = sourceKey.replace('TEAM:', '');
      const t = teams.find(x => x.id === tId);
      return { teamId: tId, team: t, label: t?.name || 'Equipo Asignado', isQualified: Boolean(t) };
    }

    if (sourceKey.startsWith('LIGA_')) {
      const rank = parseInt(sourceKey.replace('LIGA_', ''), 10);
      const standings = calculateStandings(tourId);
      const row = standings[rank - 1];
      const team = row ? teams.find(t => t.id === row.teamId) : undefined;
      const label = `${rank}º Lugar Liga`;
      const stats = row && row.played > 0 ? `${row.points} pts | DG: ${row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference}` : undefined;
      return {
        teamId: row?.teamId || '',
        team,
        label,
        stats,
        isQualified: Boolean(row && row.played > 0)
      };
    }

    if (sourceKey.startsWith('BEST_')) {
      // e.g. BEST_3_1 -> 1er Mejor 3ro
      const parts = sourceKey.split('_');
      const targetGroupPos = parseInt(parts[1], 10);
      const bestIndex = parseInt(parts[2], 10) - 1;

      const tour = tournaments.find(t => t.id === tourId);
      const numGroups = tour?.numGroups || 2;
      const groupsList = Array.from({ length: numGroups }, (_, i) => String.fromCharCode(65 + i));

      const candidates = groupsList.map(g => {
        const std = calculateStandings(tourId, g);
        return std && std.length >= targetGroupPos
          ? { group: g, teamId: std[targetGroupPos - 1].teamId, row: std[targetGroupPos - 1] }
          : null;
      }).filter((x): x is { group: string; teamId: string; row: StandingRow } => x !== null);

      candidates.sort((a, b) => {
        if (b.row.points !== a.row.points) return b.row.points - a.row.points;
        if (b.row.goalDifference !== a.row.goalDifference) return b.row.goalDifference - a.row.goalDifference;
        return b.row.goalsFor - a.row.goalsFor;
      });

      const targetCandidate = candidates[bestIndex];
      const team = targetCandidate ? teams.find(t => t.id === targetCandidate.teamId) : undefined;
      const ordinals = ['1er', '2do', '3er', '4to', '5to', '6to'];
      const label = `${ordinals[bestIndex] || `${bestIndex + 1}º`} Mejor ${targetGroupPos}º`;
      const stats = targetCandidate && targetCandidate.row.played > 0 
        ? `(Gr. ${targetCandidate.group} - ${targetCandidate.row.points} pts)` 
        : undefined;

      return {
        teamId: targetCandidate?.teamId || '',
        team,
        label,
        stats,
        isQualified: Boolean(targetCandidate && targetCandidate.row.played > 0)
      };
    }

    // Format: "A_1", "C_4", etc.
    const match = sourceKey.match(/^([A-H])_(\d+)$/);
    if (match) {
      const group = match[1];
      const rank = parseInt(match[2], 10);
      const standings = calculateStandings(tourId, group);
      const row = standings[rank - 1];
      const team = row ? teams.find(t => t.id === row.teamId) : undefined;
      const ordinals = ['1ro', '2do', '3ro', '4to', '5to', '6to', '7mo', '8vo'];
      const label = `${ordinals[rank - 1] || `${rank}º`} Grupo ${group}`;
      const stats = row && row.played > 0 
        ? `${row.points} pts (DG: ${row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference})` 
        : undefined;

      return {
        teamId: row?.teamId || '',
        team,
        label,
        stats,
        isQualified: Boolean(row && row.played > 0)
      };
    }

    return { teamId: '', label: sourceKey, isQualified: false };
  };

  // --- AVAILABLE SOURCES FOR CRUCES SELECTORS ---
  const getAvailableBracketSources = (tour: Tournament) => {
    const options: { value: string; label: string; group: string }[] = [];

    if (tour.type === 'GRUPOS') {
      const numGroups = tour.numGroups || 2;
      const groupsList = Array.from({ length: numGroups }, (_, i) => String.fromCharCode(65 + i));

      // 1. Group positions
      groupsList.forEach(g => {
        const groupTeamsCount = tour.teams.filter(tt => tt.group === g).length || 6;
        const maxPos = Math.min(Math.max(groupTeamsCount, 4), 8);
        const ordinals = ['1ro', '2do', '3ro', '4to', '5to', '6to', '7mo', '8vo'];
        for (let pos = 1; pos <= maxPos; pos++) {
          options.push({
            value: `${g}_${pos}`,
            label: `${ordinals[pos - 1] || `${pos}º`} Grupo ${g}`,
            group: `Posiciones Grupo ${g}`
          });
        }
      });

      // 2. Best Seconds
      options.push(
        { value: 'BEST_2_1', label: '1er Mejor 2do Lugar', group: 'Mejores Clasificados Globales' },
        { value: 'BEST_2_2', label: '2do Mejor 2do Lugar', group: 'Mejores Clasificados Globales' }
      );

      // 3. Best Thirds
      options.push(
        { value: 'BEST_3_1', label: '1er Mejor 3er Lugar', group: 'Mejores Clasificados Globales' },
        { value: 'BEST_3_2', label: '2do Mejor 3er Lugar', group: 'Mejores Clasificados Globales' },
        { value: 'BEST_3_3', label: '3er Mejor 3er Lugar', group: 'Mejores Clasificados Globales' },
        { value: 'BEST_3_4', label: '4to Mejor 3er Lugar', group: 'Mejores Clasificados Globales' }
      );

      // 4. Best Fourths
      options.push(
        { value: 'BEST_4_1', label: '1er Mejor 4to Lugar', group: 'Mejores Clasificados Globales' },
        { value: 'BEST_4_2', label: '2do Mejor 4to Lugar', group: 'Mejores Clasificados Globales' }
      );
    } else if (tour.type === 'LIGA') {
      const teamCount = tour.teams.length || tour.numTeams || 8;
      for (let i = 1; i <= Math.min(teamCount, 16); i++) {
        options.push({
          value: `LIGA_${i}`,
          label: `${i}º Lugar Tabla General`,
          group: 'Posiciones Liga'
        });
      }
    }

    // Direct club options
    const tourTeams = tour.teams || [];
    tourTeams.forEach(tt => {
      const team = teams.find(t => t.id === tt.teamId);
      if (team) {
        options.push({
          value: `TEAM:${team.id}`,
          label: `Club: ${team.name}`,
          group: 'Equipos Registrados'
        });
      }
    });

    options.push({
      value: 'TBD',
      label: 'Por definir (TBD)',
      group: 'Otro'
    });

    return options;
  };

  // --- BRACKET TEMPLATES ---
  const getBracketTemplates = (tour: Tournament) => {
    const templates: {
      id: string;
      category: 'OCTAVOS' | 'FINAL_DIRECTA' | 'SEGUNDA_FASE' | 'CUARTOS' | 'SEMIS';
      name: string;
      phaseName: string;
      description: string;
      rules: { sourceA: string; sourceB: string; customLabel?: string }[];
    }[] = [];

    const isGrupos = tour.type === 'GRUPOS';
    const numGroups = tour.numGroups || 2;

    // ==========================================
    // 1. OCTAVOS DE FINAL (8 LLAVES / 16 EQUIPOS)
    // ==========================================
    if (isGrupos && numGroups >= 4) {
      templates.push({
        id: 'octavos_ac_bd',
        category: 'OCTAVOS',
        name: 'Octavos de Final: Grupos A vs C y B vs D (8 Llaves)',
        phaseName: 'Octavos de Final',
        description: '1ro A vs 4to C, 2do A vs 3ro C, 3ro A vs 2do C, 4to A vs 1ro C | 1ro B vs 4to D, 2do B vs 3ro D...',
        rules: [
          { sourceA: 'A_1', sourceB: 'C_4', customLabel: '1ro Grupo A VS 4to Grupo C' },
          { sourceA: 'A_2', sourceB: 'C_3', customLabel: '2do Grupo A VS 3ro Grupo C' },
          { sourceA: 'A_3', sourceB: 'C_2', customLabel: '3ro Grupo A VS 2do Grupo C' },
          { sourceA: 'A_4', sourceB: 'C_1', customLabel: '4to Grupo A VS 1ro Grupo C' },
          { sourceA: 'B_1', sourceB: 'D_4', customLabel: '1ro Grupo B VS 4to Grupo D' },
          { sourceA: 'B_2', sourceB: 'D_3', customLabel: '2do Grupo B VS 3ro Grupo D' },
          { sourceA: 'B_3', sourceB: 'D_2', customLabel: '3ro Grupo B VS 2do Grupo D' },
          { sourceA: 'B_4', sourceB: 'D_1', customLabel: '4to Grupo B VS 1ro Grupo D' }
        ]
      });

      templates.push({
        id: 'octavos_ab_cd',
        category: 'OCTAVOS',
        name: 'Octavos de Final: Grupos A vs B y C vs D (8 Llaves)',
        phaseName: 'Octavos de Final',
        description: '1ro A vs 4to B, 2do A vs 3ro B, 3ro A vs 2do B, 4to A vs 1ro B | 1ro C vs 4to D, 2do C vs 3ro D...',
        rules: [
          { sourceA: 'A_1', sourceB: 'B_4', customLabel: '1ro Grupo A VS 4to Grupo B' },
          { sourceA: 'A_2', sourceB: 'B_3', customLabel: '2do Grupo A VS 3ro Grupo B' },
          { sourceA: 'A_3', sourceB: 'B_2', customLabel: '3ro Grupo A VS 2do Grupo B' },
          { sourceA: 'A_4', sourceB: 'B_1', customLabel: '4to Grupo A VS 1ro Grupo B' },
          { sourceA: 'C_1', sourceB: 'D_4', customLabel: '1ro Grupo C VS 4to Grupo D' },
          { sourceA: 'C_2', sourceB: 'D_3', customLabel: '2do Grupo C VS 3ro Grupo D' },
          { sourceA: 'C_3', sourceB: 'D_2', customLabel: '3ro Grupo C VS 2do Grupo D' },
          { sourceA: 'C_4', sourceB: 'D_1', customLabel: '4to Grupo C VS 1ro Grupo D' }
        ]
      });

      templates.push({
        id: 'octavos_3ro_4to',
        category: 'OCTAVOS',
        name: 'Octavos de Final: Con Mejores 3ros y 4tos (8 Llaves)',
        phaseName: 'Octavos de Final',
        description: '1ros vs Mejores 4tos y Mejores 3ros clasificados',
        rules: [
          { sourceA: 'A_1', sourceB: 'BEST_4_1', customLabel: '1ro Grupo A VS 1er Mejor 4to' },
          { sourceA: 'B_1', sourceB: 'BEST_4_2', customLabel: '1ro Grupo B VS 2do Mejor 4to' },
          { sourceA: 'C_1', sourceB: 'BEST_3_1', customLabel: '1ro Grupo C VS 1er Mejor 3ro' },
          { sourceA: 'D_1', sourceB: 'BEST_3_2', customLabel: '1ro Grupo D VS 2do Mejor 3ro' },
          { sourceA: 'A_2', sourceB: 'BEST_3_3', customLabel: '2do Grupo A VS 3er Mejor 3ro' },
          { sourceA: 'B_2', sourceB: 'BEST_3_4', customLabel: '2do Grupo B VS 4to Mejor 3ro' },
          { sourceA: 'C_2', sourceB: 'D_3', customLabel: '2do Grupo C VS 3ro Grupo D' },
          { sourceA: 'D_2', sourceB: 'C_3', customLabel: '2do Grupo D VS 3ro Grupo C' }
        ]
      });
    } else if (isGrupos && numGroups === 2) {
      templates.push({
        id: '2g_octavos',
        category: 'OCTAVOS',
        name: 'Octavos de Final: 8 Clasificados por Grupo (8 Llaves)',
        phaseName: 'Octavos de Final',
        description: '1ro A vs 8vo B, 2do A vs 7mo B, 3ro A vs 6to B, 4to A vs 5to B | 1ro B vs 8vo A...',
        rules: [
          { sourceA: 'A_1', sourceB: 'B_8', customLabel: '1ro Grupo A VS 8vo Grupo B' },
          { sourceA: 'A_2', sourceB: 'B_7', customLabel: '2do Grupo A VS 7mo Grupo B' },
          { sourceA: 'A_3', sourceB: 'B_6', customLabel: '3ro Grupo A VS 6to Grupo B' },
          { sourceA: 'A_4', sourceB: 'B_5', customLabel: '4to Grupo A VS 5to Grupo B' },
          { sourceA: 'B_1', sourceB: 'A_8', customLabel: '1ro Grupo B VS 8vo Grupo A' },
          { sourceA: 'B_2', sourceB: 'A_7', customLabel: '2do Grupo B VS 7mo Grupo A' },
          { sourceA: 'B_3', sourceB: 'A_6', customLabel: '3ro Grupo B VS 6to Grupo A' },
          { sourceA: 'B_4', sourceB: 'A_5', customLabel: '4to Grupo B VS 5to Grupo A' }
        ]
      });
    } else {
      templates.push({
        id: 'liga_octavos',
        category: 'OCTAVOS',
        name: 'Octavos de Final: Top 16 Tabla General (8 Llaves)',
        phaseName: 'Octavos de Final',
        description: '1ro vs 16vo, 2do vs 15vo, 3ro vs 14vo, 4to vs 13vo, 5to vs 12vo, 6to vs 11vo, 7mo vs 10mo, 8vo vs 9no',
        rules: [
          { sourceA: 'LIGA_1', sourceB: 'LIGA_16', customLabel: '1er Lugar VS 16º Lugar' },
          { sourceA: 'LIGA_2', sourceB: 'LIGA_15', customLabel: '2do Lugar VS 15º Lugar' },
          { sourceA: 'LIGA_3', sourceB: 'LIGA_14', customLabel: '3er Lugar VS 14º Lugar' },
          { sourceA: 'LIGA_4', sourceB: 'LIGA_13', customLabel: '4to Lugar VS 13º Lugar' },
          { sourceA: 'LIGA_5', sourceB: 'LIGA_12', customLabel: '5to Lugar VS 12º Lugar' },
          { sourceA: 'LIGA_6', sourceB: 'LIGA_11', customLabel: '6to Lugar VS 11º Lugar' },
          { sourceA: 'LIGA_7', sourceB: 'LIGA_10', customLabel: '7mo Lugar VS 10º Lugar' },
          { sourceA: 'LIGA_8', sourceB: 'LIGA_9', customLabel: '8vo Lugar VS 9no Lugar' }
        ]
      });
    }

    // ==========================================
    // 2. FINAL DIRECTA (1 O 2 LLAVES)
    // ==========================================
    if (isGrupos) {
      templates.push({
        id: 'final_directa_1partido',
        category: 'FINAL_DIRECTA',
        name: 'Gran Final Directa: 1ro Grupo A vs 1ro Grupo B (1 Llave)',
        phaseName: 'Final Directa',
        description: 'Campeón a partido único entre los punteros de grupo',
        rules: [
          { sourceA: 'A_1', sourceB: numGroups >= 2 ? 'B_1' : 'A_2', customLabel: '🏆 GRAN FINAL: 1ro Grupo A VS 1ro Grupo B' }
        ]
      });

      templates.push({
        id: 'final_directa_y_3ero',
        category: 'FINAL_DIRECTA',
        name: 'Final Directa y Partido por el 3er Puesto (2 Llaves)',
        phaseName: 'Final Directa',
        description: 'Gran Final por el título (1ros) y Partido por el 3er Lugar (2dos)',
        rules: [
          { sourceA: 'A_1', sourceB: numGroups >= 2 ? 'B_1' : 'A_2', customLabel: '🏆 GRAN FINAL: 1ro Grupo A VS 1ro Grupo B' },
          { sourceA: 'A_2', sourceB: numGroups >= 2 ? 'B_2' : 'A_3', customLabel: '🥉 3er PUESTO: 2do Grupo A VS 2do Grupo B' }
        ]
      });
    } else {
      templates.push({
        id: 'final_directa_liga',
        category: 'FINAL_DIRECTA',
        name: 'Gran Final Directa: 1er vs 2do Lugar (1 Llave)',
        phaseName: 'Final Directa',
        description: '1er Lugar Tabla General vs 2do Lugar Tabla General',
        rules: [
          { sourceA: 'LIGA_1', sourceB: 'LIGA_2', customLabel: '🏆 GRAN FINAL: 1er Lugar VS 2do Lugar' }
        ]
      });

      templates.push({
        id: 'final_directa_liga_top4',
        category: 'FINAL_DIRECTA',
        name: 'Final Directa y 3er Puesto: Top 4 (2 Llaves)',
        phaseName: 'Final Directa',
        description: 'Gran Final (1ro vs 2do) y Partido por el 3er Lugar (3ro vs 4to)',
        rules: [
          { sourceA: 'LIGA_1', sourceB: 'LIGA_2', customLabel: '🏆 GRAN FINAL: 1er Lugar VS 2do Lugar' },
          { sourceA: 'LIGA_3', sourceB: 'LIGA_4', customLabel: '🥉 3er PUESTO: 3er Lugar VS 4to Lugar' }
        ]
      });
    }

    // ==========================================
    // 3. SEGUNDA FASE (4 U 8 LLAVES)
    // ==========================================
    if (isGrupos && numGroups >= 4) {
      templates.push({
        id: 'segunda_fase_clasificados',
        category: 'SEGUNDA_FASE',
        name: 'Segunda Fase: Cruces Eliminatorios Directos (4 Llaves)',
        phaseName: 'Segunda Fase',
        description: '1ro A vs 2do B, 1ro B vs 2do A, 1ro C vs 2do D, 1ro D vs 2do C',
        rules: [
          { sourceA: 'A_1', sourceB: 'B_2', customLabel: 'Segunda Fase: 1ro Grupo A VS 2do Grupo B' },
          { sourceA: 'B_1', sourceB: 'A_2', customLabel: 'Segunda Fase: 1ro Grupo B VS 2do Grupo A' },
          { sourceA: 'C_1', sourceB: 'D_2', customLabel: 'Segunda Fase: 1ro Grupo C VS 2do Grupo D' },
          { sourceA: 'D_1', sourceB: 'C_2', customLabel: 'Segunda Fase: 1ro Grupo D VS 2do Grupo C' }
        ]
      });

      templates.push({
        id: 'segunda_fase_repechaje',
        category: 'SEGUNDA_FASE',
        name: 'Segunda Fase: Repechaje y Reclasificación (4 Llaves)',
        phaseName: 'Segunda Fase',
        description: '3ro A vs 4to B, 3ro B vs 4to A, 3ro C vs 4to D, 3ro D vs 4to C',
        rules: [
          { sourceA: 'A_3', sourceB: 'B_4', customLabel: 'Segunda Fase: 3ro Grupo A VS 4to Grupo B' },
          { sourceA: 'B_3', sourceB: 'A_4', customLabel: 'Segunda Fase: 3ro Grupo B VS 4to Grupo A' },
          { sourceA: 'C_3', sourceB: 'D_4', customLabel: 'Segunda Fase: 3ro Grupo C VS 4to Grupo D' },
          { sourceA: 'D_3', sourceB: 'C_4', customLabel: 'Segunda Fase: 3ro Grupo D VS 4to Grupo C' }
        ]
      });

      templates.push({
        id: 'segunda_fase_8llaves',
        category: 'SEGUNDA_FASE',
        name: 'Segunda Fase: Llaves de Ida Grupos A-C y B-D (8 Llaves)',
        phaseName: 'Segunda Fase',
        description: '1ro A vs 4to C, 2do A vs 3ro C, 3ro A vs 2do C, 4to A vs 1ro C | 1ro B vs 4to D...',
        rules: [
          { sourceA: 'A_1', sourceB: 'C_4', customLabel: 'Segunda Fase: 1ro Grupo A VS 4to Grupo C' },
          { sourceA: 'A_2', sourceB: 'C_3', customLabel: 'Segunda Fase: 2do Grupo A VS 3ro Grupo C' },
          { sourceA: 'A_3', sourceB: 'C_2', customLabel: 'Segunda Fase: 3ro Grupo A VS 2do Grupo C' },
          { sourceA: 'A_4', sourceB: 'C_1', customLabel: 'Segunda Fase: 4to Grupo A VS 1ro Grupo C' },
          { sourceA: 'B_1', sourceB: 'D_4', customLabel: 'Segunda Fase: 1ro Grupo B VS 4to Grupo D' },
          { sourceA: 'B_2', sourceB: 'D_3', customLabel: 'Segunda Fase: 2do Grupo B VS 3ro Grupo D' },
          { sourceA: 'B_3', sourceB: 'D_2', customLabel: 'Segunda Fase: 3ro Grupo B VS 2do Grupo D' },
          { sourceA: 'B_4', sourceB: 'D_1', customLabel: 'Segunda Fase: 4to Grupo B VS 1ro Grupo D' }
        ]
      });
    } else if (isGrupos && numGroups === 2) {
      templates.push({
        id: 'segunda_fase_2g_4llaves',
        category: 'SEGUNDA_FASE',
        name: 'Segunda Fase: Cruces Clasificados (4 Llaves)',
        phaseName: 'Segunda Fase',
        description: '1ro A vs 4to B, 2do A vs 3ro B, 1ro B vs 4to A, 2do B vs 3ro A',
        rules: [
          { sourceA: 'A_1', sourceB: 'B_4', customLabel: 'Segunda Fase: 1ro Grupo A VS 4to Grupo B' },
          { sourceA: 'A_2', sourceB: 'B_3', customLabel: 'Segunda Fase: 2do Grupo A VS 3ro Grupo B' },
          { sourceA: 'B_1', sourceB: 'A_4', customLabel: 'Segunda Fase: 1ro Grupo B VS 4to Grupo A' },
          { sourceA: 'B_2', sourceB: 'A_3', customLabel: 'Segunda Fase: 2do Grupo B VS 3ro Grupo A' }
        ]
      });
    } else {
      templates.push({
        id: 'segunda_fase_liga',
        category: 'SEGUNDA_FASE',
        name: 'Segunda Fase: Cruces Directos Top 8 (4 Llaves)',
        phaseName: 'Segunda Fase',
        description: '1ro vs 8vo, 2do vs 7mo, 3ro vs 6to, 4to vs 5to',
        rules: [
          { sourceA: 'LIGA_1', sourceB: 'LIGA_8', customLabel: 'Segunda Fase: 1er Lugar VS 8vo Lugar' },
          { sourceA: 'LIGA_2', sourceB: 'LIGA_7', customLabel: 'Segunda Fase: 2do Lugar VS 7mo Lugar' },
          { sourceA: 'LIGA_3', sourceB: 'LIGA_6', customLabel: 'Segunda Fase: 3er Lugar VS 6to Lugar' },
          { sourceA: 'LIGA_4', sourceB: 'LIGA_5', customLabel: 'Segunda Fase: 4to Lugar VS 5to Lugar' }
        ]
      });
    }

    // ==========================================
    // 4. CUARTOS DE FINAL (4 LLAVES)
    // ==========================================
    if (isGrupos && numGroups >= 4) {
      templates.push({
        id: 'cuartos_clasicos_4g',
        category: 'CUARTOS',
        name: 'Cuartos de Final Clásicos: 1ro vs 2do Cruzados (4 Llaves)',
        phaseName: 'Cuartos de Final',
        description: '1ro A vs 2do B, 1ro B vs 2do A, 1ro C vs 2do D, 1ro D vs 2do C',
        rules: [
          { sourceA: 'A_1', sourceB: 'B_2', customLabel: '1ro Grupo A VS 2do Grupo B' },
          { sourceA: 'B_1', sourceB: 'A_2', customLabel: '1ro Grupo B VS 2do Grupo A' },
          { sourceA: 'C_1', sourceB: 'D_2', customLabel: '1ro Grupo C VS 2do Grupo D' },
          { sourceA: 'D_1', sourceB: 'C_2', customLabel: '1ro Grupo D VS 2do Grupo C' }
        ]
      });

      templates.push({
        id: 'cuartos_mejores_3ros',
        category: 'CUARTOS',
        name: 'Cuartos de Final: 1ros vs 4 Mejores Terceros (4 Llaves)',
        phaseName: 'Cuartos de Final',
        description: '1ro A vs 4to Mejor 3ro, 1ro B vs 3er Mejor 3ro, 1ro C vs 2do Mejor 3ro, 1ro D vs 1er Mejor 3ro',
        rules: [
          { sourceA: 'A_1', sourceB: 'BEST_3_4', customLabel: '1ro Grupo A VS 4to Mejor 3ro' },
          { sourceA: 'B_1', sourceB: 'BEST_3_3', customLabel: '1ro Grupo B VS 3er Mejor 3ro' },
          { sourceA: 'C_1', sourceB: 'BEST_3_2', customLabel: '1ro Grupo C VS 2do Mejor 3ro' },
          { sourceA: 'D_1', sourceB: 'BEST_3_1', customLabel: '1ro Grupo D VS 1er Mejor 3ro' }
        ]
      });
    } else if (isGrupos && numGroups === 2) {
      templates.push({
        id: 'cuartos_clasicos_2g',
        category: 'CUARTOS',
        name: 'Cuartos de Final: 1ro vs 4to y 2do vs 3ro Cruzados (4 Llaves)',
        phaseName: 'Cuartos de Final',
        description: '1ro A vs 4to B, 2do A vs 3ro B, 1ro B vs 4to A, 2do B vs 3ro A',
        rules: [
          { sourceA: 'A_1', sourceB: 'B_4', customLabel: '1ro Grupo A VS 4to Grupo B' },
          { sourceA: 'A_2', sourceB: 'B_3', customLabel: '2do Grupo A VS 3ro Grupo B' },
          { sourceA: 'B_1', sourceB: 'A_4', customLabel: '1ro Grupo B VS 4to Grupo A' },
          { sourceA: 'B_2', sourceB: 'A_3', customLabel: '2do Grupo B VS 3ro Grupo A' }
        ]
      });
    } else {
      templates.push({
        id: 'cuartos_liga',
        category: 'CUARTOS',
        name: 'Cuartos de Final: Top 8 Cruzados (4 Llaves)',
        phaseName: 'Cuartos de Final',
        description: '1ro vs 8vo, 2do vs 7mo, 3ro vs 6to, 4to vs 5to',
        rules: [
          { sourceA: 'LIGA_1', sourceB: 'LIGA_8', customLabel: '1er Lugar VS 8vo Lugar' },
          { sourceA: 'LIGA_2', sourceB: 'LIGA_7', customLabel: '2do Lugar VS 7mo Lugar' },
          { sourceA: 'LIGA_3', sourceB: 'LIGA_6', customLabel: '3er Lugar VS 6to Lugar' },
          { sourceA: 'LIGA_4', sourceB: 'LIGA_5', customLabel: '4to Lugar VS 5to Lugar' }
        ]
      });
    }

    // ==========================================
    // 5. SEMIFINALES (2 LLAVES)
    // ==========================================
    if (isGrupos && numGroups >= 2) {
      templates.push({
        id: 'semis_cruzadas_grupos',
        category: 'SEMIS',
        name: 'Semifinales Cruzadas: 1ros vs 2dos (2 Llaves)',
        phaseName: 'Semifinales',
        description: '1ro Grupo A vs 2do Grupo B, 1ro Grupo B vs 2do Grupo A',
        rules: [
          { sourceA: 'A_1', sourceB: 'B_2', customLabel: '1ro Grupo A VS 2do Grupo B' },
          { sourceA: 'B_1', sourceB: 'A_2', customLabel: '1ro Grupo B VS 2do Grupo A' }
        ]
      });
    } else {
      templates.push({
        id: 'semis_liga',
        category: 'SEMIS',
        name: 'Semifinales: 1ro vs 4to y 2do vs 3ro (2 Llaves)',
        phaseName: 'Semifinales',
        description: '1er Lugar vs 4to Lugar, 2do Lugar vs 3er Lugar',
        rules: [
          { sourceA: 'LIGA_1', sourceB: 'LIGA_4', customLabel: '1er Lugar VS 4to Lugar' },
          { sourceA: 'LIGA_2', sourceB: 'LIGA_3', customLabel: '2do Lugar VS 3er Lugar' }
        ]
      });
    }

    return templates;
  };

  const handleOpenBracketBuilder = (tour: Tournament) => {
    if (!checkCanEdit(tour.id)) return;
    const templates = getBracketTemplates(tour);
    setBracketTemplateCategoryFilter('ALL');
    if (templates.length > 0) {
      const first = templates[0];
      setBracketBuilderSelectedTemplate(first.id);
      setBracketBuilderPhaseName(first.phaseName);
      setBracketBuilderRules(first.rules.map((r, idx) => ({
        id: `rule-${Date.now()}-${idx}`,
        sourceA: r.sourceA,
        sourceB: r.sourceB,
        customLabel: r.customLabel || '',
        time: '',
        venue: ''
      })));
    } else {
      setBracketBuilderSelectedTemplate('');
      setBracketBuilderPhaseName('Fase Eliminatoria');
      setBracketBuilderRules([
        { id: `rule-${Date.now()}-0`, sourceA: 'TBD', sourceB: 'TBD', customLabel: '' }
      ]);
    }
    setBracketBuilderReplaceExisting(false);
    setShowBracketBuilderModal(true);
  };

  const handleApplyBracketTemplate = (templateId: string, tour?: Tournament) => {
    const targetTour = tour || currentTour;
    if (!targetTour) return;
    const templates = getBracketTemplates(targetTour);
    const selected = templates.find(t => t.id === templateId);
    if (!selected) return;
    setBracketBuilderSelectedTemplate(selected.id);
    setBracketBuilderPhaseName(selected.phaseName);
    setBracketBuilderRules(selected.rules.map((r, idx) => ({
      id: `rule-${Date.now()}-${idx}`,
      sourceA: r.sourceA,
      sourceB: r.sourceB,
      customLabel: r.customLabel || '',
      time: '',
      venue: ''
    })));
  };

  const handleSelectPhaseNameQuick = (phase: string) => {
    setBracketBuilderPhaseName(phase);
    if (!currentTour) return;
    const templates = getBracketTemplates(currentTour);

    // Map phase name to category or template
    let matchedCategory: 'OCTAVOS' | 'FINAL_DIRECTA' | 'SEGUNDA_FASE' | 'CUARTOS' | 'SEMIS' | 'ALL' = 'ALL';
    const pLower = phase.toLowerCase();
    if (pLower.includes('octav')) matchedCategory = 'OCTAVOS';
    else if (pLower.includes('final') && !pLower.includes('semi') && !pLower.includes('cuart')) matchedCategory = 'FINAL_DIRECTA';
    else if (pLower.includes('segunda') || pLower.includes('2da')) matchedCategory = 'SEGUNDA_FASE';
    else if (pLower.includes('cuart')) matchedCategory = 'CUARTOS';
    else if (pLower.includes('semi')) matchedCategory = 'SEMIS';

    setBracketTemplateCategoryFilter(matchedCategory);

    const matchingTmpl = templates.find(t =>
      t.phaseName.toLowerCase() === pLower ||
      (matchedCategory !== 'ALL' && t.category === matchedCategory)
    );

    if (matchingTmpl) {
      handleApplyBracketTemplate(matchingTmpl.id, currentTour);
    }
  };

  const handleSaveCustomBracketMatches = () => {
    if (!currentTour || bracketBuilderRules.length === 0) return;

    const phase = bracketBuilderPhaseName.trim() || 'Fase Eliminatoria';

    const newMatches: Match[] = bracketBuilderRules.map((rule, idx) => {
      const resA = resolveBracketSource(currentTour.id, rule.sourceA);
      const resB = resolveBracketSource(currentTour.id, rule.sourceB);
      const label = rule.customLabel || `${resA.label} VS ${resB.label}`;

      return {
        id: `m-llave-${Date.now()}-${idx}`,
        tournamentId: currentTour.id,
        teamAId: resA.teamId || '',
        teamBId: resB.teamId || '',
        scoreA: null,
        scoreB: null,
        played: false,
        round: phase,
        isLlave: true,
        time: rule.time || undefined,
        venue: rule.venue || undefined,
        label,
        sourceA: rule.sourceA,
        sourceB: rule.sourceB
      };
    });

    let updatedMatches: Match[];
    if (bracketBuilderReplaceExisting) {
      // Remove any existing bracket matches for this phase
      updatedMatches = [
        ...matches.filter(m => !(m.tournamentId === currentTour.id && m.isLlave && m.round === phase)),
        ...newMatches
      ];
    } else {
      updatedMatches = [...matches, ...newMatches];
    }

    const notifText = `🏆 Nuevas llaves generadas para "${currentTour.name}": ${phase} (${newMatches.length} partidos)`;

    realtimeSync.publishAction({
      type: 'MATCHES_UPDATE',
      tournamentId: currentTour.id,
      matches: updatedMatches.filter(m => m.tournamentId === currentTour.id),
      notifText,
      timestamp: Date.now()
    });

    saveState(teams, tournaments, updatedMatches, notifText, currentTour.id);
    setShowBracketBuilderModal(false);
  };

  const handleSyncBracketStandings = (tour: Tournament) => {
    if (!checkCanEdit(tour.id)) return;
    let updatedCount = 0;
    const updatedMatches = matches.map(m => {
      if (m.tournamentId === tour.id && m.isLlave && !m.played && (m.sourceA || m.sourceB)) {
        let newTeamAId = m.teamAId;
        let newTeamBId = m.teamBId;
        if (m.sourceA) {
          const resA = resolveBracketSource(tour.id, m.sourceA);
          if (resA.teamId && resA.teamId !== m.teamAId) {
            newTeamAId = resA.teamId;
            updatedCount++;
          }
        }
        if (m.sourceB) {
          const resB = resolveBracketSource(tour.id, m.sourceB);
          if (resB.teamId && resB.teamId !== m.teamBId) {
            newTeamBId = resB.teamId;
            updatedCount++;
          }
        }
        return { ...m, teamAId: newTeamAId, teamBId: newTeamBId };
      }
      return m;
    });

    if (updatedCount > 0) {
      const notifText = `🔄 Equipos en llaves actualizados según las posiciones de los grupos (${updatedCount} cruces actualizados)`;
      realtimeSync.publishAction({
        type: 'MATCHES_UPDATE',
        tournamentId: tour.id,
        matches: updatedMatches.filter(m => m.tournamentId === tour.id),
        notifText,
        timestamp: Date.now()
      });
      saveState(teams, tournaments, updatedMatches, notifText, tour.id);
      setActiveCloudNotif({ id: Date.now(), text: notifText, timestamp: Date.now() });
    } else {
      setActiveCloudNotif({ id: Date.now(), text: '✅ Las llaves ya se encuentran al día con las tablas de posiciones.', timestamp: Date.now() });
    }
  };

  // --- AUTO LLAVES GENERATION SYSTEM FOR GROUPS (LEGACY PRESETS COMPATIBILITY) ---
  const getPairingTemplates = (numGroups: number) => {
    if (!currentTour) return [];
    return getBracketTemplates(currentTour);
  };

  const generateMatchupsFromTemplate = (tourId: string, templateId: string): { teamAId: string; teamBId: string; label: string }[] => {
    const tour = tournaments.find(t => t.id === tourId);
    if (!tour) return [];
    const templates = getBracketTemplates(tour);
    const selected = templates.find(t => t.id === templateId);
    if (!selected) return [];

    return selected.rules.map(r => {
      const resA = resolveBracketSource(tourId, r.sourceA);
      const resB = resolveBracketSource(tourId, r.sourceB);
      return {
        teamAId: resA.teamId,
        teamBId: resB.teamId,
        label: r.customLabel || `${resA.label} VS ${resB.label}`
      };
    });
  };

  const handleAutoCreateLlaves = () => {
    if (!currentTour || !selectedTemplateId) return;

    const pairings = generateMatchupsFromTemplate(currentTour.id, selectedTemplateId);
    
    // Create actual matches
    const createdMatches: Match[] = pairings.map((p, idx) => ({
      id: `m-llave-auto-${Date.now()}-${idx}`,
      tournamentId: currentTour.id,
      teamAId: p.teamAId || '',
      teamBId: p.teamBId || '',
      scoreA: null,
      scoreB: null,
      played: false,
      round: autoPhaseName.trim() || 'Fase Eliminatoria',
      isLlave: true,
      label: p.label
    }));

    // Add them to the existing matches
    saveState(teams, tournaments, [...matches, ...createdMatches]);
    setShowAutoLlaveModal(false);
  };

  const handleOpenScoreModal = (match: Match) => {
    if (!checkCanEdit(match.tournamentId)) return;
    setEditingMatch(match);
    setEditScoreA(match.scoreA !== null ? String(match.scoreA) : '');
    setEditScoreB(match.scoreB !== null ? String(match.scoreB) : '');
    setEditPenaltiesA(match.penaltiesA !== null && match.penaltiesA !== undefined ? String(match.penaltiesA) : '');
    setEditPenaltiesB(match.penaltiesB !== null && match.penaltiesB !== undefined ? String(match.penaltiesB) : '');
  };

  const handleSaveScore = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMatch || !checkCanEdit(editingMatch.tournamentId)) return;

    const scoreA = editScoreA.trim() !== '' ? Number(editScoreA) : null;
    const scoreB = editScoreB.trim() !== '' ? Number(editScoreB) : null;
    const penaltiesA = editPenaltiesA.trim() !== '' ? Number(editPenaltiesA) : null;
    const penaltiesB = editPenaltiesB.trim() !== '' ? Number(editPenaltiesB) : null;
    const played = scoreA !== null && scoreB !== null;

    const exists = matches.some(m => m.id === editingMatch.id);
    let updatedMatches: Match[];

    if (exists) {
      updatedMatches = matches.map(m => {
        if (m.id === editingMatch.id) {
          return {
            ...m,
            scoreA,
            scoreB,
            penaltiesA,
            penaltiesB,
            played
          };
        }
        return m;
      });
    } else {
      updatedMatches = [
        ...matches,
        {
          ...editingMatch,
          scoreA,
          scoreB,
          penaltiesA,
          penaltiesB,
          played
        }
      ];
    }

    const tour = tournaments.find(t => t.id === editingMatch.tournamentId);

    // --- BRACKET AUTO-PROGRESSION LOGIC ---
    if (played && tour && (tour.type === 'ELIMINACION_DIRECTA' || tour.type === 'FASE_FINAL') && editingMatch.bracketSlot !== undefined) {
      let winnerId = '';
      if (scoreA! > scoreB!) {
        winnerId = editingMatch.teamAId;
      } else if (scoreB! > scoreA!) {
        winnerId = editingMatch.teamBId;
      } else {
        const penA = penaltiesA !== null ? penaltiesA : 0;
        const penB = penaltiesB !== null ? penaltiesB : 0;
        winnerId = penA > penB ? editingMatch.teamAId : editingMatch.teamBId;
      }
      const currentRound = editingMatch.round;
      let nextRound = '';
      let nextSlot = -1;
      let isTeamA = false;

      if (currentRound === 'Octavos') {
        nextRound = 'Cuartos';
        nextSlot = Math.floor(editingMatch.bracketSlot / 2);
        isTeamA = editingMatch.bracketSlot % 2 === 0;
      } else if (currentRound === 'Cuartos') {
        nextRound = 'Semifinal';
        nextSlot = Math.floor(editingMatch.bracketSlot / 2);
        isTeamA = editingMatch.bracketSlot % 2 === 0;
      } else if (currentRound === 'Semifinal') {
        nextRound = 'Final';
        nextSlot = 0;
        isTeamA = editingMatch.bracketSlot % 2 === 0;
      }

      if (nextRound !== '' && nextSlot !== -1) {
        // Find or create the next match slot
        const nextMatchIndex = updatedMatches.findIndex(m => 
          m.tournamentId === tour.id && 
          m.round === nextRound && 
          m.bracketSlot === nextSlot
        );

        if (nextMatchIndex !== -1) {
          if (isTeamA) {
            updatedMatches[nextMatchIndex].teamAId = winnerId;
          } else {
            updatedMatches[nextMatchIndex].teamBId = winnerId;
          }
        } else {
          // Dynamically push a next stage match if it doesn't exist
          updatedMatches.push({
            id: `m-${tour.id}-bracket-${nextRound}-${nextSlot}`,
            tournamentId: tour.id,
            teamAId: isTeamA ? winnerId : '',
            teamBId: isTeamA ? '' : winnerId,
            scoreA: null,
            scoreB: null,
            played: false,
            round: nextRound,
            bracketSlot: nextSlot
          });
        }
      }
    }

    const scoreTour = tournaments.find(t => t.id === editingMatch.tournamentId);
    const teamA = teams.find(t => t.id === editingMatch.teamAId)?.name || 'Equipo A';
    const teamB = teams.find(t => t.id === editingMatch.teamBId)?.name || 'Equipo B';
    let notifText = '';
    if (scoreTour) {
      if (played) {
        let penText = "";
        if (penaltiesA !== null && penaltiesB !== null) {
          penText = ` (Pen: ${penaltiesA} - ${penaltiesB})`;
        }
        notifText = `Actualización del torneo ${scoreTour.name}: Se actualizó el resultado: ${teamA} ${scoreA} - ${scoreB} ${teamB}${penText}`;
      } else {
        notifText = `Actualización del torneo ${scoreTour.name}: Se reinició el marcador de ${teamA} vs ${teamB}`;
      }
    }

    // Instant delta action broadcast across all devices
    realtimeSync.publishAction({
      type: 'MATCHES_UPDATE',
      tournamentId: editingMatch.tournamentId,
      matches: updatedMatches.filter(m => m.tournamentId === editingMatch.tournamentId),
      notifText: notifText || undefined,
      timestamp: Date.now()
    });

    saveState(teams, tournaments, updatedMatches, notifText || undefined, scoreTour?.id);
    setEditingMatch(null);
  };

  // --- STANDINGS CALCULATOR ---
  const calculateStandings = (tournamentId: string, groupFilter?: string): StandingRow[] => {
    const tour = tournaments.find(t => t.id === tournamentId);
    if (!tour) return [];

    const standingsMap: Record<string, StandingRow> = {};
    const targetTeams = tour.teams.filter(t => !groupFilter || t.group === groupFilter);

    targetTeams.forEach(t => {
      standingsMap[t.teamId] = {
        teamId: t.teamId,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDifference: 0,
        points: 0
      };
    });

    const activeTeamIds = new Set(targetTeams.map(t => t.teamId));

    const tourPlayedMatches = matches.filter(m => 
      m.tournamentId === tournamentId && 
      m.played && 
      m.isLlave !== true &&
      activeTeamIds.has(m.teamAId) && 
      activeTeamIds.has(m.teamBId)
    );

    tourPlayedMatches.forEach(m => {
      const sA = m.scoreA ?? 0;
      const sB = m.scoreB ?? 0;
      const rowA = standingsMap[m.teamAId];
      const rowB = standingsMap[m.teamBId];

      if (!rowA || !rowB) return;

      rowA.played += 1;
      rowB.played += 1;

      rowA.goalsFor += sA;
      rowA.goalsAgainst += sB;
      rowB.goalsFor += sB;
      rowB.goalsAgainst += sA;

      if (sA > sB) {
        rowA.won += 1;
        rowA.points += 3;
        rowB.lost += 1;
      } else if (sA < sB) {
        rowB.won += 1;
        rowB.points += 3;
        rowA.lost += 1;
      } else {
        rowA.drawn += 1;
        rowA.points += 1;
        rowB.drawn += 1;
        rowB.points += 1;
      }
    });

    return Object.values(standingsMap).map(row => {
      row.goalDifference = row.goalsFor - row.goalsAgainst;
      return row;
    }).sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.goalDifference !== a.goalDifference) return b.goalDifference - a.goalDifference;
      return b.goalsFor - a.goalsFor;
    });
  };

  // --- LLAVES DYNAMIC GENERATION FOR GRUPOS ---
  const getLlavesDefaultTeams = (tourId: string) => {
    const get1st = (g: string) => calculateStandings(tourId, g)[0]?.teamId || '';
    const get2nd = (g: string) => calculateStandings(tourId, g)[1]?.teamId || '';
    const get3rd = (g: string) => calculateStandings(tourId, g)[2]?.teamId || '';
    
    // Mejor Perdedor: best 4th place among groups A, B, C, D, E
    const fourthPlaces = ['A', 'B', 'C', 'D', 'E'].map(g => {
      const standing = calculateStandings(tourId, g);
      return standing.length >= 4 ? { group: g, row: standing[3] } : null;
    }).filter((x): x is { group: string; row: StandingRow } => x !== null);

    // Sort fourthPlaces by points, goal diff, goals for
    fourthPlaces.sort((a, b) => {
      if (b.row.points !== a.row.points) return b.row.points - a.row.points;
      if (b.row.goalDifference !== a.row.goalDifference) return b.row.goalDifference - a.row.goalDifference;
      return b.row.goalsFor - a.row.goalsFor;
    });

    const mejorPerdedorId = fourthPlaces[0]?.row.teamId || '';

    return [
      { label: '1ro Grupo A VS Mejor Perdedor', teamAId: get1st('A'), teamBId: mejorPerdedorId, desc: '1ro Grupo A vs Mejor Perdedor (4to)' },
      { label: '2do Grupo C VS 3ro Grupo A', teamAId: get2nd('C'), teamBId: get3rd('A'), desc: '2do Grupo C vs 3ro Grupo A' },
      { label: '1ro Grupo C VS 3ro Grupo D', teamAId: get1st('C'), teamBId: get3rd('D'), desc: '1ro Grupo C vs 3ro Grupo D' },
      { label: '1ro Grupo D VS 3ro Grupo C', teamAId: get1st('D'), teamBId: get3rd('C'), desc: '1ro Grupo D vs 3ro Grupo C' },
      { label: '1ro Grupo E VS 3ro Grupo B', teamAId: get1st('E'), teamBId: get3rd('B'), desc: '1ro Grupo E vs 3ro Grupo B' },
      { label: '2do Grupo A VS 2do Grupo D', teamAId: get2nd('A'), teamBId: get2nd('D'), desc: '2do Grupo A vs 2do Grupo D' },
      { label: '2do Grupo B VS 2do Grupo E', teamAId: get2nd('B'), teamBId: get2nd('E'), desc: '2do Grupo B vs 2do Grupo E' },
      { label: '1ro Grupo B VS 3ro Grupo E', teamAId: get1st('B'), teamBId: get3rd('E'), desc: '1ro Grupo B vs 3ro Grupo E' },
    ];
  };

  const getLlaveMatch = (tourId: string, index: number): Match & { overrideTeams?: boolean } => {
    const existing = matches.find(m => m.tournamentId === tourId && m.round === 'LLAVES' && m.bracketSlot === index);
    const defaults = getLlavesDefaultTeams(tourId)[index];
    
    if (existing) {
      return {
        ...existing,
        teamAId: existing.overrideTeams ? existing.teamAId : defaults.teamAId,
        teamBId: existing.overrideTeams ? existing.teamBId : defaults.teamBId,
        round: existing.round || 'LLAVES',
      };
    }
    
    return {
      id: `m-${tourId}-llave-${index}`,
      tournamentId: tourId,
      teamAId: defaults.teamAId,
      teamBId: defaults.teamBId,
      scoreA: null,
      scoreB: null,
      played: false,
      round: 'LLAVES',
      bracketSlot: index,
      overrideTeams: false
    };
  };

  // --- WHATSAPP SHARE GENERATOR ---
  const handleShareWhatsApp = (tour: Tournament) => {
    let message = `🏆 *PlayGol - ${tour.name}* ⚽\n\n`;

    if (tour.type === 'LIGA') {
      message += `*TABLA DE POSICIONES*\n`;
      const rows = calculateStandings(tour.id);
      rows.forEach((r, idx) => {
        const team = teams.find(t => t.id === r.teamId);
        message += `${idx + 1}. ${team?.name || 'Equipo'} - ${r.points} Pts (${r.played}PJ | GD: ${r.goalDifference > 0 ? '+' : ''}${r.goalDifference})\n`;
      });
    } else if (tour.type === 'GRUPOS') {
      const groups = Array.from({ length: tour.numGroups || 2 }, (_, i) => String.fromCharCode(65 + i));
      groups.forEach(g => {
        message += `\n*GRUPO ${g}*\n`;
        const rows = calculateStandings(tour.id, g);
        rows.forEach((r, idx) => {
          const team = teams.find(t => t.id === r.teamId);
          message += `${idx + 1}. ${team?.name || 'Equipo'} - ${r.points} Pts (GD: ${r.goalDifference > 0 ? '+' : ''}${r.goalDifference})\n`;
        });
      });
    } else {
      message += `*PARTIDOS Y LLAVES DIRECTAS*\n`;
      const tourMatches = matches.filter(m => m.tournamentId === tour.id);
      tourMatches.forEach(m => {
        const tA = teams.find(t => t.id === m.teamAId)?.name || 'TBD';
        const tB = teams.find(t => t.id === m.teamBId)?.name || 'TBD';
        const result = m.played ? `${m.scoreA} - ${m.scoreB}` : 'vs';
        message += `• [${m.round}] ${tA} ${result} ${tB}\n`;
      });
    }

    message += `\n¡Sigue y administra este torneo con PlayGol! 📲`;
    const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
  };

  // --- PORTABILITY (JSON COPY & PASTE IMPORT/EXPORT) ---
  const handleExportState = () => {
    const backupObj = { teams, tournaments, matches };
    const jsonStr = JSON.stringify(backupObj);
    const base64Str = btoa(unescape(encodeURIComponent(jsonStr)));
    
    navigator.clipboard.writeText(base64Str).then(() => {
      setCopyStatus(true);
      setTimeout(() => setCopyStatus(false), 3000);
    });
  };

  const handleImportState = (e: React.FormEvent) => {
    e.preventDefault();
    if (!importString.trim()) return;

    try {
      const decodedStr = decodeURIComponent(escape(atob(importString.trim())));
      const parsed = JSON.parse(decodedStr);

      if (parsed.teams && parsed.tournaments && parsed.matches) {
        saveState(parsed.teams, parsed.tournaments, parsed.matches);
        setImportStatus({ success: true, msg: '¡Base de datos importada exitosamente!' });
        setImportString('');
        setTimeout(() => setImportStatus(null), 4000);
      } else {
        setImportStatus({ success: false, msg: 'Formato inválido. Asegúrese de copiar el código completo.' });
      }
    } catch (err) {
      setImportStatus({ success: false, msg: 'Error al decodificar. Verifique que el código copiado sea correcto.' });
    }
  };

  const handleResetData = () => {
    showConfirm(
      '¿Restablecer Datos?',
      '¿Está seguro de querer borrar todos los datos del torneo? Esta acción no se puede deshacer y reiniciará la base de datos en la nube.',
      async () => {
        try {
          const [teamSnap, tourSnap, matchSnap, notifSnap] = await Promise.all([
            getDocs(collection(db, 'teams')),
            getDocs(collection(db, 'tournaments')),
            getDocs(collection(db, 'matches')),
            getDocs(collection(db, 'notifications'))
          ]);
          const batch = writeBatch(db);
          teamSnap.forEach(d => batch.delete(d.ref));
          tourSnap.forEach(d => batch.delete(d.ref));
          matchSnap.forEach(d => batch.delete(d.ref));
          notifSnap.forEach(d => batch.delete(d.ref));
          batch.delete(doc(db, "metadata", "app_init"));
          await batch.commit();
        } catch (err) {
          console.error("Error resetting Firestore:", err);
        }
        window.location.reload();
      },
      'Borrar Todo',
      'Cancelar'
    );
  };

  // --- RENDER HEADING LOGO BADGE ---
  const renderTeamBadge = (team: Team, sizeClass = 'w-10 h-10') => {
    // Dynamic Symbol presets
    let symbolIcon = <Shield className="w-1/2 h-1/2 text-white" />;
    if (team.badgeSymbol === 'ball') symbolIcon = <span className="text-sm font-bold">⚽</span>;
    else if (team.badgeSymbol === 'star') symbolIcon = <Star className="w-1/2 h-1/2 text-white fill-white" />;
    else if (team.badgeSymbol === 'crown') symbolIcon = <Crown className="w-1/2 h-1/2 text-white" />;
    else if (team.badgeSymbol === 'trophy') symbolIcon = <Trophy className="w-1/2 h-1/2 text-white" />;
    else if (team.badgeSymbol === 'flame') symbolIcon = <span className="text-sm">🔥</span>;
    else if (team.badgeSymbol === 'zap') symbolIcon = <Zap className="w-1/2 h-1/2 text-white fill-white" />;

    if (team.logoUrl) {
      return (
        <img 
          src={team.logoUrl} 
          alt={team.name} 
          onError={(e) => {
            // If image fails to load, gracefully fallback to custom symbol badge
            e.currentTarget.style.display = 'none';
          }}
          className={`${sizeClass} rounded-full object-contain border border-slate-700 bg-slate-900 p-0.5 flex-shrink-0`}
        />
      );
    }

    return (
      <div 
        className={`${sizeClass} rounded-full flex items-center justify-center border-2 shadow-inner relative flex-shrink-0`}
        style={{ 
          backgroundColor: team.primaryColor || '#10b981', 
          borderColor: team.secondaryColor || '#334155' 
        }}
      >
        {symbolIcon}
      </div>
    );
  };

  // --- LOADING SCREEN ---
  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-8 h-8 text-emerald-400 animate-spin" />
          <p className="text-slate-400 text-sm font-semibold tracking-wide animate-pulse">
            Cargando Base de Datos en Tiempo Real...
          </p>
        </div>
      </div>
    );
  }

  // --- LOGIN WALL SCREEN ---
  if (!role) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md bg-slate-900 rounded-3xl border border-slate-800 p-8 shadow-2xl relative overflow-hidden">
          
          {/* Visual Soccer Pitch background detail */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 via-green-400 to-emerald-600" />
          <div className="absolute -top-16 -right-16 w-36 h-36 bg-emerald-500/10 rounded-full blur-3xl" />
          <div className="absolute -bottom-16 -left-16 w-36 h-36 bg-emerald-600/10 rounded-full blur-3xl" />

          {/* Logo Brand Header */}
          <div className="flex flex-col items-center mb-8">
            <div className="w-20 h-20 bg-slate-950 border border-slate-800 rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-950/35 mb-3 transform rotate-6 hover:rotate-12 transition-transform duration-300">
              <span className="text-3xl font-black tracking-tighter">
                <span className="text-white">P</span>
                <span className="text-emerald-400">G</span>
              </span>
            </div>
            <h1 className="text-4xl font-extrabold tracking-tight text-white flex items-center gap-1">
              Play<span className="text-emerald-400">Gol</span>
            </h1>
            <p className="text-slate-400 text-sm mt-1 text-center">
              Administración Profesional de Torneos de Fútbol
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2 text-center w-full">
                INGRESA TU CONTRASEÑA
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-slate-500">
                  <Lock className="w-5 h-5" />
                </span>
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Escribe la contraseña de acceso..."
                  className="w-full pl-10 pr-12 py-3 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 focus:outline-none transition text-white placeholder-slate-600"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 flex items-center pr-3.5 text-slate-500 hover:text-slate-300 transition focus:outline-none"
                  title={showPassword ? "Ocultar contraseña" : "Ver contraseña"}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
              {loginError && (
                <p className="text-red-400 text-xs mt-2 font-medium bg-red-950/30 py-1.5 px-3 rounded-lg border border-red-900/30">
                  {loginError}
                </p>
              )}
            </div>

            <button
              type="submit"
              className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl shadow-lg shadow-emerald-950/50 transition-all hover:-translate-y-0.5 active:translate-y-0 cursor-pointer"
            >
              Iniciar Sesión
            </button>
          </form>

          {/* Footer inside login card */}
          <div className="mt-8 pt-4 border-t border-slate-800/50 text-center text-slate-500 text-xs font-semibold">
            App By: Andrey Design / 2026
          </div>

        </div>
      </div>
    );
  }

  // --- SELECTED TOURNAMENT INSTANCE & ROLE CONTROLS ---
  const currentTour = tournaments.find(t => t.id === selectedTournamentId);
  const currentTourRole = selectedTournamentId ? unlockedTournaments[selectedTournamentId] : null;
  const canEditCurrentTour = role === 'admin' || currentTourRole === 'AdminTorneo';

  // --- MAIN APP APPLICATION SHELL ---
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-slate-950">
      
      {/* --- TOP NAV BAR --- */}
      <header className="bg-slate-900/80 backdrop-blur-md border-b border-slate-800 sticky top-0 z-40 px-4 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => setSelectedTournamentId(null)}>
            <div className="w-10 h-10 bg-slate-950 border border-slate-800 rounded-xl flex items-center justify-center shadow shadow-emerald-900">
              <span className="text-base font-black tracking-tighter">
                <span className="text-white">P</span>
                <span className="text-emerald-400">G</span>
              </span>
            </div>
            <div>
              <span className="text-xl font-extrabold text-white tracking-tight">
                Play<span className="text-emerald-400">Gol</span>
              </span>
              <span className="text-[10px] block text-slate-400 font-semibold uppercase tracking-wider">
                App Oficial
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Notification Bell Dropdown */}
            <div className="relative">
              <button
                onClick={() => {
                  requestNotificationPermission();
                  setShowNotifDropdown(!showNotifDropdown);
                  if (notifications.length > 0) {
                    const maxTimestamp = Math.max(...notifications.map(n => n.timestamp));
                    setLastReadNotificationTimestamp(maxTimestamp);
                    localStorage.setItem('playgol_last_read_notif', String(maxTimestamp));
                  }
                }}
                className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-xl transition relative cursor-pointer flex items-center justify-center"
                title="Notificaciones"
              >
                <Bell className="w-4 h-4" />
                {notifications.filter(n => n.timestamp > lastReadNotificationTimestamp).length > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white font-bold text-[9px] rounded-full flex items-center justify-center animate-pulse">
                    {notifications.filter(n => n.timestamp > lastReadNotificationTimestamp).length}
                  </span>
                )}
              </button>

              {/* Dropdown Card */}
              {showNotifDropdown && (
                <div className="absolute right-0 mt-2 w-72 sm:w-80 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl z-50 p-3.5 space-y-2.5 max-h-[340px] overflow-y-auto">
                  <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                    <span className="text-xs font-black text-slate-200">Notificaciones Recientes</span>
                    {notifications.length > 0 && (
                      <button
                        onClick={handleClearAllNotifications}
                        className="text-[10px] font-bold text-red-400 hover:text-red-300 transition cursor-pointer"
                      >
                        Limpiar todo
                      </button>
                    )}
                  </div>
                  {notifications.length === 0 ? (
                    <p className="text-xs text-slate-500 text-center py-5">No hay notificaciones</p>
                  ) : (
                    <div className="space-y-2 max-h-[240px] overflow-y-auto pr-0.5">
                      {notifications.map(n => (
                        <div key={n.id} className="p-2 bg-slate-950/70 border border-slate-850/80 rounded-xl text-[11px] leading-tight text-slate-300">
                          <p className="font-medium">{n.text}</p>
                          <span className="text-[9px] text-slate-500 block mt-1">
                            {new Date(n.timestamp).toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* "Crear Ícono" Green Button */}
            <button
              onClick={() => {
                if (deferredPrompt) {
                  handleInstallPWA();
                } else {
                  setShowInstallModal(true);
                }
              }}
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-slate-100 text-xs font-black rounded-xl flex items-center gap-1.5 transition shadow shadow-emerald-950 cursor-pointer"
              title="Crear acceso directo en pantalla"
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span>Crear Ícono</span>
            </button>

            {/* Role indicator badge */}
            <div className={`text-xs px-3 py-1.5 rounded-full font-bold flex items-center gap-1.5 border ${
              (role === 'admin' || (selectedTournamentId && unlockedTournaments[selectedTournamentId] === 'AdminTorneo'))
                ? 'bg-emerald-950/50 text-emerald-400 border-emerald-900' 
                : 'bg-blue-950/50 text-blue-400 border-blue-900'
            }`}>
              <span className="w-2 h-2 rounded-full bg-current animate-pulse" />
              {(role === 'admin' || (selectedTournamentId && unlockedTournaments[selectedTournamentId] === 'AdminTorneo')) ? 'Administrador' : 'Visitante'}
            </div>

            <button 
              onClick={handleLogout}
              className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-xl transition"
              title="Cerrar Sesión"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* --- MAIN PAGE CONTENT WRAPPER --- */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 md:py-6 grid grid-cols-1 gap-6">
        
        {/* If viewing tournament detail, render full dedicated tournament board. Else render standard home view tabs. */}
        {selectedTournamentId && currentTour ? (
          <div className="space-y-6">
            
            {/* Breadcrumb Navigation & Action bar */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button 
                onClick={() => setSelectedTournamentId(null)}
                className="text-xs text-slate-400 hover:text-white flex items-center gap-1 bg-slate-900 hover:bg-slate-800 px-3 py-2 rounded-lg transition"
              >
                ← Volver a todos los Torneos
              </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleShareWhatsApp(currentTour)}
                  className="bg-green-600 hover:bg-green-500 text-white text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-1.5 transition shadow shadow-green-950"
                >
                  <Share2 className="w-3.5 h-3.5" /> Compartir en WhatsApp
                </button>
              </div>
            </div>

            {/* Tournament Header banner */}
            <div className="bg-slate-900 rounded-3xl border border-slate-800 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />
              
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center text-3xl overflow-hidden p-0.5 flex-shrink-0">
                  {currentTour.logoUrl ? (
                    <img src={currentTour.logoUrl} alt={currentTour.name} className="w-full h-full object-cover rounded-xl" />
                  ) : (
                    currentTour.type === 'LIGA' ? '🏆' : currentTour.type === 'GRUPOS' ? '👥' : '⚔️'
                  )}
                </div>
                <div>
                  <h2 className="text-2xl font-extrabold text-white">{currentTour.name}</h2>
                  <div className="flex flex-wrap gap-2 mt-1">
                    <span className="text-[10px] font-bold uppercase bg-slate-800 text-slate-300 px-2.5 py-0.5 rounded border border-slate-700">
                      TIPO: {currentTour.type}
                    </span>
                    {currentTour.type === 'GRUPOS' && (
                      <span className="text-[10px] font-bold uppercase bg-emerald-950 text-emerald-400 px-2.5 py-0.5 rounded border border-emerald-900">
                        {currentTour.numGroups} Grupos
                      </span>
                    )}
                    {currentTour.type === 'FASE_FINAL' && (
                      <span className="text-[10px] font-bold uppercase bg-emerald-950 text-emerald-400 px-2.5 py-0.5 rounded border border-emerald-900">
                        Inicia en {currentTour.faseFinalType}
                      </span>
                    )}
                    <span className="text-[10px] font-bold uppercase bg-slate-800 text-slate-300 px-2.5 py-0.5 rounded border border-slate-700">
                      {currentTour.teams.length} Equipos inscritos
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Sub Tabs Selection */}
            <div className="flex border-b border-slate-800">
              <button
                onClick={() => setTournamentSubTab('matches')}
                className={`px-4 py-2.5 text-sm font-bold border-b-2 transition ${
                  tournamentSubTab === 'matches' 
                    ? 'border-emerald-500 text-white' 
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                Calendario de Partidos ({matches.filter(m => m.tournamentId === currentTour.id && m.isLlave !== true && m.round !== 'LLAVES').length})
              </button>
              {(currentTour.type === 'LIGA' || currentTour.type === 'GRUPOS') && (
                <button
                  onClick={() => setTournamentSubTab('table')}
                  className={`px-4 py-2.5 text-sm font-bold border-b-2 transition ${
                    tournamentSubTab === 'table' 
                      ? 'border-emerald-500 text-white' 
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Tabla de Posiciones
                </button>
              )}
              <button
                onClick={() => setTournamentSubTab('keys')}
                className={`px-4 py-2.5 text-sm font-bold border-b-2 transition ${
                  tournamentSubTab === 'keys' 
                    ? 'border-emerald-500 text-white' 
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                LLAVES
              </button>
              {(currentTour.type === 'ELIMINACION_DIRECTA' || currentTour.type === 'FASE_FINAL') && (
                <button
                  onClick={() => setTournamentSubTab('bracket')}
                  className={`px-4 py-2.5 text-sm font-bold border-b-2 transition ${
                    tournamentSubTab === 'bracket' 
                      ? 'border-emerald-500 text-white' 
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Llaves (Brackets)
                </button>
              )}
            </div>

            {/* SUB-VIEW: POSICIONES / STANDINGS */}
            {tournamentSubTab === 'table' && (currentTour.type === 'LIGA' || currentTour.type === 'GRUPOS') && (
              <div className="space-y-6">
                {currentTour.type === 'GRUPOS' ? (
                  // Multiple Group Standings
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {Array.from({ length: currentTour.numGroups || 2 }, (_, i) => String.fromCharCode(65 + i)).map(g => (
                      <div key={g} className="bg-slate-900 rounded-2xl border border-slate-800 p-4">
                        <h3 className="text-lg font-extrabold text-emerald-400 mb-3 border-b border-slate-800 pb-1 flex justify-between items-center">
                          <span>Grupo {g}</span>
                          <span className="text-xs text-slate-400 font-normal">Fase Regular</span>
                        </h3>
                        {renderStandingsTable(currentTour.id, g)}
                      </div>
                    ))}
                  </div>
                ) : (
                  // Single Ligue Standings
                  <div className="bg-slate-900 rounded-2xl border border-slate-800 p-4 overflow-hidden">
                    {renderStandingsTable(currentTour.id)}
                  </div>
                )}
              </div>
            )}

            {/* SUB-VIEW: MATCH SCHEDULE */}
            {tournamentSubTab === 'matches' && (
              <div className="bg-slate-900 rounded-2xl border border-slate-800 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3 mb-4">
                  <h3 className="text-lg font-bold text-white">Todos los Enfrentamientos</h3>
                  
                  {canEditCurrentTour && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => {
                          setNewMatchState({
                            teamAId: '',
                            teamBId: '',
                            round: 'Fecha 1',
                            scoreA: '',
                            scoreB: '',
                            played: false,
                            group: 'A',
                            freeTeamId: '',
                            time: '',
                            venue: ''
                          });
                          setShowManualMatchModal(true);
                        }}
                        className="bg-emerald-600 hover:bg-emerald-500 text-slate-100 text-xs font-bold px-3 py-1.5 rounded-lg flex items-center gap-1 transition"
                      >
                        <Plus className="w-3.5 h-3.5" /> Crear Partido Manual
                      </button>
                      <button
                        onClick={() => setShowAssignModal(true)}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-bold px-3 py-1.5 rounded-lg flex items-center gap-1 border border-slate-700 transition"
                      >
                        <Plus className="w-3.5 h-3.5" /> Inscribir / Asignar Equipo
                      </button>
                    </div>
                  )}
                </div>

                {/* Filter and Match list */}
                {renderMatchList(currentTour)}
              </div>
            )}

            {/* SUB-VIEW: BRACKETS */}
            {tournamentSubTab === 'bracket' && (
              <div className="bg-slate-900 rounded-2xl border border-slate-800 p-6 overflow-x-auto">
                <div className="min-w-[600px] flex items-stretch justify-around gap-4 py-8">
                  {renderBracketTree(currentTour)}
                </div>
              </div>
            )}

            {/* SUB-VIEW: LLAVES */}
            {tournamentSubTab === 'keys' && (
              <div className="space-y-6">
                {/* Header Banner & Organizer Controls */}
                <div className="bg-gradient-to-r from-emerald-950/50 via-slate-900/60 to-emerald-950/50 border border-emerald-900/40 p-6 rounded-3xl relative overflow-hidden shadow-xl">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1.5">
                        <div className="w-8 h-8 rounded-xl bg-emerald-950 border border-emerald-800/60 flex items-center justify-center text-emerald-400">
                          <Trophy className="w-4 h-4" />
                        </div>
                        <h3 className="text-lg font-black text-white uppercase tracking-wider">
                          Emparejamientos de Llaves y Fases Finales
                        </h3>
                      </div>
                      <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
                        Arma y personaliza las llaves según las tablas de posiciones (ej. 1ro Grupo A vs 4to Grupo C, 2do A vs 3ro C, etc.) o con cruces directos. Los equipos se resuelven en tiempo real.
                      </p>
                    </div>

                    {canEditCurrentTour && (
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleOpenBracketBuilder(currentTour)}
                          className="px-4 py-2.5 bg-gradient-to-r from-emerald-600 to-green-500 hover:from-emerald-500 hover:to-green-400 text-white text-xs font-black rounded-xl flex items-center gap-2 shadow-lg shadow-emerald-950/60 transition cursor-pointer"
                        >
                          <Wand2 className="w-4 h-4" />
                          <span>Armar y Configurar Cruces</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleSyncBracketStandings(currentTour)}
                          className="px-3 py-2 bg-slate-800 hover:bg-slate-750 text-slate-200 text-xs font-bold rounded-xl border border-slate-700 flex items-center gap-1.5 transition cursor-pointer"
                          title="Actualizar equipos en llaves según la tabla de posiciones actual"
                        >
                          <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="hidden sm:inline">Sincronizar con Tabla</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setManualLlaveState({
                              phaseName: 'Segunda Fase',
                              teamAId: '',
                              teamBId: '',
                              scoreA: '',
                              scoreB: '',
                              played: false
                            });
                            setShowAddManualLlaveModal(true);
                          }}
                          className="px-3 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl border border-slate-750 flex items-center gap-1.5 transition cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Llave Individual</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Match Lists for Llaves */}
                {(() => {
                  const tourLlaveMatches = matches.filter(
                    m => m.tournamentId === currentTour.id && (m.isLlave === true || m.round === 'LLAVES')
                  );

                  if (tourLlaveMatches.length === 0 && currentTour.name === 'INTERLIGA CANTONAL PORTOVIEJO 2026') {
                    // Default Fallback for Interliga Cantonal
                    return (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                          <h4 className="text-sm font-black text-emerald-400 uppercase tracking-wider flex items-center gap-2">
                            🏆 Octavos de Final (Clasificación por Grupos)
                          </h4>
                          {canEditCurrentTour && (
                            <button
                              type="button"
                              onClick={() => handleOpenBracketBuilder(currentTour)}
                              className="text-xs font-bold text-emerald-400 hover:text-emerald-300 transition"
                            >
                              Configurar Cruces →
                            </button>
                          )}
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {Array.from({ length: 8 }, (_, i) => {
                            const match = getLlaveMatch(currentTour.id, i);
                            const defaultTeams = getLlavesDefaultTeams(currentTour.id)[i];
                            const teamA = teams.find(t => t.id === match.teamAId);
                            const teamB = teams.find(t => t.id === match.teamBId);

                            return (
                              <div
                                key={match.id}
                                onClick={() => {
                                  if (canEditCurrentTour) {
                                    handleOpenScoreModal(match);
                                  }
                                }}
                                className={`p-4 bg-slate-900 rounded-2xl border ${
                                  match.played ? 'border-emerald-500/30 bg-emerald-950/5' : 'border-slate-800'
                                } hover:border-emerald-500/50 transition relative overflow-hidden flex flex-col justify-between ${
                                  canEditCurrentTour ? 'cursor-pointer' : ''
                                }`}
                              >
                                <div className="flex items-center justify-between border-b border-slate-800/80 pb-2 mb-3">
                                  <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest bg-emerald-950/60 border border-emerald-900/30 px-2 py-0.5 rounded-md">
                                    Llave {i + 1}
                                  </span>
                                  <span className="text-[10px] font-medium text-slate-400 flex items-center gap-1">
                                    {defaultTeams.desc}
                                    {match.overrideTeams && (
                                      <span className="text-[9px] font-bold text-amber-400 bg-amber-950/40 border border-amber-900/30 px-1 py-0.2 rounded">
                                        Manual
                                      </span>
                                    )}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2.5 flex-1 min-w-0">
                                    {teamA ? renderTeamBadge(teamA, 'w-8 h-8') : (
                                      <div className="w-8 h-8 rounded-full border border-dashed border-slate-700 bg-slate-950 flex items-center justify-center">
                                        <span className="text-[9px] font-bold text-slate-500">TBD</span>
                                      </div>
                                    )}
                                    <div className="min-w-0">
                                      <span className={`text-xs font-extrabold truncate block ${
                                        match.played && (match.scoreA ?? 0) > (match.scoreB ?? 0) ? 'text-white' : 'text-slate-300'
                                      }`}>
                                        {teamA ? teamA.name : 'Por clasificar'}
                                      </span>
                                      <span className="text-[9px] text-slate-500 block">Local</span>
                                    </div>
                                  </div>

                                  <div className="flex flex-col items-center gap-1 mx-3 px-3 py-1 bg-slate-950 rounded-xl border border-slate-850">
                                    {match.played ? (
                                      <div className="flex flex-col items-center gap-0.5">
                                        <div className="flex items-center gap-2">
                                          <span className="text-base font-black text-white">{match.scoreA}</span>
                                          <span className="text-slate-600 font-bold text-xs">-</span>
                                          <span className="text-base font-black text-white">{match.scoreB}</span>
                                        </div>
                                        {match.scoreA === match.scoreB && match.penaltiesA !== null && match.penaltiesB !== null && (
                                          <span className="text-[9px] text-amber-400 font-medium tracking-tight">
                                            ({match.penaltiesA} - {match.penaltiesB} Pen)
                                          </span>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="text-[9px] font-black text-slate-500 uppercase tracking-wider">VS</span>
                                    )}
                                  </div>

                                  <div className="flex items-center gap-2.5 flex-1 justify-end min-w-0 text-right">
                                    <div className="min-w-0">
                                      <span className={`text-xs font-extrabold truncate block ${
                                        match.played && (match.scoreB ?? 0) > (match.scoreA ?? 0) ? 'text-white' : 'text-slate-300'
                                      }`}>
                                        {teamB ? teamB.name : 'Por clasificar'}
                                      </span>
                                      <span className="text-[9px] text-slate-500 block">Visitante</span>
                                    </div>
                                    {teamB ? renderTeamBadge(teamB, 'w-8 h-8') : (
                                      <div className="w-8 h-8 rounded-full border border-dashed border-slate-700 bg-slate-950 flex items-center justify-center">
                                        <span className="text-[9px] font-bold text-slate-500">TBD</span>
                                      </div>
                                    )}
                                  </div>
                                </div>

                                {canEditCurrentTour && (
                                  <div className="flex items-center justify-end gap-1.5 mt-3 pt-2 border-t border-slate-800/50">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleOpenEditMatchDetails(match);
                                      }}
                                      className="text-[10px] font-bold text-emerald-400 hover:text-emerald-300 px-2.5 py-1 bg-emerald-950/40 border border-emerald-900/30 rounded-lg transition flex items-center gap-1"
                                    >
                                      <Edit2 className="w-3 h-3" /> Editar Cruce / Marcador
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }

                  if (tourLlaveMatches.length === 0) {
                    return (
                      <div className="bg-slate-900 border border-slate-800 p-10 rounded-3xl text-center space-y-4">
                        <div className="w-16 h-16 rounded-3xl bg-slate-950 border border-slate-800 flex items-center justify-center mx-auto text-emerald-400 shadow-inner">
                          <Trophy className="w-8 h-8" />
                        </div>
                        <div>
                          <h4 className="text-base font-extrabold text-white">Aún no se han configurado llaves para este torneo</h4>
                          <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
                            Puedes crear las llaves automáticamente usando las posiciones de los grupos o configurar tus propios cruces personalizados.
                          </p>
                        </div>

                        {canEditCurrentTour && (
                          <div className="flex flex-wrap justify-center gap-3 pt-2">
                            <button
                              type="button"
                              onClick={() => handleOpenBracketBuilder(currentTour)}
                              className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black rounded-xl transition cursor-pointer flex items-center gap-2 shadow-lg shadow-emerald-950"
                            >
                              <Wand2 className="w-4 h-4" />
                              <span>Armar Cruces de Llaves</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setManualLlaveState({
                                  phaseName: 'Segunda Fase',
                                  teamAId: '',
                                  teamBId: '',
                                  scoreA: '',
                                  scoreB: '',
                                  played: false
                                });
                                setShowAddManualLlaveModal(true);
                              }}
                              className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-xl border border-slate-700 transition cursor-pointer"
                            >
                              Crear Llave Individual
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  }

                  // Group matches by Phase / Round
                  const groupedPhases = tourLlaveMatches.reduce((acc, m) => {
                    const phase = m.round || 'Fase Eliminatoria';
                    if (!acc[phase]) acc[phase] = [];
                    acc[phase].push(m);
                    return acc;
                  }, {} as Record<string, Match[]>);

                  return (
                    <div className="space-y-8">
                      {(Object.entries(groupedPhases) as [string, Match[]][]).map(([phase, phaseMatches]) => (
                        <div key={phase} className="space-y-4">
                          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                            <h4 className="text-sm font-black text-emerald-400 uppercase tracking-wider flex items-center gap-2">
                              <span>🏆</span> {phase} ({phaseMatches.length} {phaseMatches.length === 1 ? 'partido' : 'partidos'})
                            </h4>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {phaseMatches.map((match, matchIdx) => {
                              // Dynamic resolution if match has source definitions and not yet locked
                              let teamA = teams.find(t => t.id === match.teamAId);
                              let teamB = teams.find(t => t.id === match.teamBId);

                              const sourceInfoA = match.sourceA ? resolveBracketSource(currentTour.id, match.sourceA) : null;
                              const sourceInfoB = match.sourceB ? resolveBracketSource(currentTour.id, match.sourceB) : null;

                              if (!teamA && sourceInfoA?.team) teamA = sourceInfoA.team;
                              if (!teamB && sourceInfoB?.team) teamB = sourceInfoB.team;

                              return (
                                <div
                                  key={match.id}
                                  onClick={() => {
                                    if (canEditCurrentTour) {
                                      handleOpenEditMatchDetails(match);
                                    }
                                  }}
                                  className={`p-4 bg-slate-900 border rounded-2xl transition relative overflow-hidden flex flex-col justify-between ${
                                    match.played ? 'border-emerald-500/30 bg-emerald-950/5' : 'border-slate-800'
                                  } ${canEditCurrentTour ? 'hover:border-emerald-500/50 cursor-pointer' : ''}`}
                                >
                                  {/* Match Header Bar */}
                                  <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-slate-800/80 pb-2 mb-3">
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest bg-emerald-950/60 border border-emerald-900/30 px-2 py-0.5 rounded-md">
                                        Llave {matchIdx + 1}
                                      </span>
                                      {match.label && (
                                        <span className="text-[10px] font-semibold text-slate-300 truncate max-w-[200px]" title={match.label}>
                                          {match.label}
                                        </span>
                                      )}
                                    </div>

                                    {(match.time || match.venue) && (
                                      <div className="flex items-center gap-1.5 text-[9px] font-bold">
                                        {match.time && (
                                          <span className="flex items-center gap-1 text-sky-400 bg-sky-950/60 border border-sky-900/40 px-1.5 py-0.5 rounded">
                                            <Clock className="w-2.5 h-2.5" /> {match.time}
                                          </span>
                                        )}
                                        {match.venue && (
                                          <span className="flex items-center gap-1 text-amber-400 bg-amber-950/60 border border-amber-900/40 px-1.5 py-0.5 rounded truncate max-w-[120px]" title={match.venue}>
                                            <MapPin className="w-2.5 h-2.5 flex-shrink-0" /> {match.venue}
                                          </span>
                                        )}
                                      </div>
                                    )}
                                  </div>

                                  {/* Teams & Score Row */}
                                  <div className="flex items-center justify-between">
                                    {/* Team A */}
                                    <div className="flex items-center gap-2.5 flex-1 min-w-0">
                                      {teamA ? renderTeamBadge(teamA, 'w-8 h-8 md:w-9 md:h-9') : (
                                        <div className="w-8 h-8 md:w-9 md:h-9 rounded-full border border-dashed border-slate-700 bg-slate-950 flex items-center justify-center flex-shrink-0">
                                          <span className="text-[9px] font-bold text-slate-500">TBD</span>
                                        </div>
                                      )}
                                      <div className="min-w-0">
                                        <span className={`text-xs md:text-sm font-black truncate block ${
                                          match.played && (match.scoreA ?? 0) > (match.scoreB ?? 0) ? 'text-white' : 'text-slate-300'
                                        }`}>
                                          {teamA ? teamA.name : (sourceInfoA ? sourceInfoA.label : 'Por clasificar')}
                                        </span>
                                        {sourceInfoA && (
                                          <span className="text-[9px] text-slate-500 block truncate">
                                            {sourceInfoA.label} {sourceInfoA.stats ? `(${sourceInfoA.stats})` : ''}
                                          </span>
                                        )}
                                      </div>
                                    </div>

                                    {/* Score */}
                                    <div className="flex flex-col items-center gap-0.5 mx-3 px-3 py-1 bg-slate-950 rounded-xl border border-slate-850 flex-shrink-0">
                                      {match.played ? (
                                        <div className="flex flex-col items-center gap-0.5">
                                          <div className="flex items-center gap-2">
                                            <span className="text-sm md:text-base font-black text-white">{match.scoreA}</span>
                                            <span className="text-slate-600 font-bold text-xs">-</span>
                                            <span className="text-sm md:text-base font-black text-white">{match.scoreB}</span>
                                          </div>
                                          {match.scoreA === match.scoreB && match.penaltiesA !== null && match.penaltiesB !== null && (
                                            <span className="text-[9px] text-amber-400 font-medium tracking-tight">
                                              ({match.penaltiesA} - {match.penaltiesB} Pen)
                                            </span>
                                          )}
                                        </div>
                                      ) : (
                                        <span className="text-[9px] font-black text-slate-500 uppercase tracking-wider">VS</span>
                                      )}
                                    </div>

                                    {/* Team B */}
                                    <div className="flex items-center gap-2.5 flex-1 justify-end min-w-0 text-right">
                                      <div className="min-w-0">
                                        <span className={`text-xs md:text-sm font-black truncate block ${
                                          match.played && (match.scoreB ?? 0) > (match.scoreA ?? 0) ? 'text-white' : 'text-slate-300'
                                        }`}>
                                          {teamB ? teamB.name : (sourceInfoB ? sourceInfoB.label : 'Por clasificar')}
                                        </span>
                                        {sourceInfoB && (
                                          <span className="text-[9px] text-slate-500 block truncate">
                                            {sourceInfoB.label} {sourceInfoB.stats ? `(${sourceInfoB.stats})` : ''}
                                          </span>
                                        )}
                                      </div>
                                      {teamB ? renderTeamBadge(teamB, 'w-8 h-8 md:w-9 md:h-9') : (
                                        <div className="w-8 h-8 md:w-9 md:h-9 rounded-full border border-dashed border-slate-700 bg-slate-950 flex items-center justify-center flex-shrink-0">
                                          <span className="text-[9px] font-bold text-slate-500">TBD</span>
                                        </div>
                                      )}
                                    </div>
                                  </div>

                                  {/* Admin Actions */}
                                  {canEditCurrentTour && (
                                    <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-800/50">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          showConfirm(
                                            '¿Eliminar Llave?',
                                            '¿Está seguro de querer eliminar este enfrentamiento permanentemente?',
                                            () => {
                                              const updatedMatches = matches.filter(m => m.id !== match.id);
                                              saveState(teams, tournaments, updatedMatches);
                                            }
                                          );
                                        }}
                                        className="text-[10px] font-bold text-red-400 hover:text-red-300 transition cursor-pointer"
                                      >
                                        Eliminar Llave
                                      </button>

                                      <div className="flex items-center gap-1.5">
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleOpenScoreModal(match);
                                          }}
                                          className="text-[10px] font-bold text-emerald-400 hover:text-emerald-300 px-2.5 py-1 bg-emerald-950/40 border border-emerald-900/30 rounded-lg transition flex items-center gap-1 cursor-pointer"
                                        >
                                          <Edit2 className="w-3 h-3" />
                                          <span>{match.played ? 'Editar Marcador' : 'Anotar Resultado'}</span>
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* TEAM ASSIGNMENT DRAWER */}
            <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5">
              <h3 className="text-lg font-extrabold text-white mb-4 flex items-center gap-2">
                <Users className="w-5 h-5 text-emerald-400" /> Equipos Participantes
              </h3>
              
              {currentTour.teams.length === 0 ? (
                <div className="text-center py-6 border border-dashed border-slate-800 rounded-xl">
                  <p className="text-sm text-slate-400">No hay equipos asignados a este torneo aún.</p>
                  {canEditCurrentTour && (
                    <button
                      onClick={() => setShowAssignModal(true)}
                      className="mt-3 bg-slate-800 hover:bg-slate-700 text-emerald-400 border border-slate-700 text-xs font-bold px-3 py-1.5 rounded-lg transition"
                    >
                      Asignar Primer Equipo
                    </button>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {currentTour.teams.map(tt => {
                    const team = teams.find(t => t.id === tt.teamId);
                    if (!team) return null;
                    return (
                      <div key={tt.teamId} className="bg-slate-950 border border-slate-800 p-3 rounded-xl flex items-center justify-between relative group">
                        <div className="flex items-center gap-2 overflow-hidden">
                          {renderTeamBadge(team, 'w-8 h-8')}
                          <div className="overflow-hidden">
                            <span className="font-bold text-xs block text-white truncate">{team.name}</span>
                            {tt.group && (
                              <span className="text-[9px] font-bold text-emerald-400 bg-emerald-950 px-1 py-0.2 rounded">
                                Grupo {tt.group}
                              </span>
                            )}
                          </div>
                        </div>

                        {canEditCurrentTour && (
                          <button
                            onClick={() => handleRemoveTeamFromTournament(tt.teamId)}
                            className="text-red-400 hover:text-red-300 p-1 rounded hover:bg-slate-900 transition md:opacity-0 group-hover:opacity-100"
                            title="Quitar del torneo"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

          </div>
        ) : (
          
          // --- HOME VIEW WITH STANDARD SECTIONS (TOURNEYS, TEAMS, SHARE) ---
          <div className="space-y-6">
            
            {/* Visual Home Stats Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center gap-3">
                <div className="p-3 bg-emerald-950 text-emerald-400 rounded-xl">
                  <Trophy className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xl font-black text-white">{tournaments.length}</span>
                  <p className="text-xs text-slate-400">Torneos Activos</p>
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center gap-3">
                <div className="p-3 bg-blue-950 text-blue-400 rounded-xl">
                  <Shield className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xl font-black text-white">{teams.length}</span>
                  <p className="text-xs text-slate-400">Clubes Registrados</p>
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center gap-3 col-span-2 sm:col-span-1">
                <div className="p-3 bg-indigo-950 text-indigo-400 rounded-xl">
                  <Calendar className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xl font-black text-white">
                    {matches.filter(m => m.played).length} / {matches.length}
                  </span>
                  <p className="text-xs text-slate-400">Partidos Completados</p>
                </div>
              </div>
            </div>

            {/* Navigation Tabs */}
            <div className="flex bg-slate-900 p-1.5 rounded-xl border border-slate-800 gap-1">
              <button
                onClick={() => setActiveTab('tournaments')}
                className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition flex items-center justify-center gap-1.5 ${
                  activeTab === 'tournaments' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Trophy className="w-4 h-4" /> Torneos
              </button>
              <button
                onClick={() => setActiveTab('teams')}
                className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition flex items-center justify-center gap-1.5 ${
                  activeTab === 'teams' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Shield className="w-4 h-4" /> Equipos / Clubes
              </button>
              <button
                onClick={() => setActiveTab('share')}
                className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition flex items-center justify-center gap-1.5 ${
                  activeTab === 'share' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Share2 className="w-4 h-4" /> COMPARTIR
              </button>
            </div>

            {/* TAB CONTENT: TOURNAMENTS */}
            {activeTab === 'tournaments' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-extrabold text-white">Torneos Registrados</h3>
                    <p className="text-xs text-slate-400">Selecciona un torneo para ver fixture, llaves o tabla</p>
                  </div>
                  {role === 'admin' && (
                    <button
                      onClick={() => setShowTournamentModal(true)}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-1 transition shadow shadow-emerald-900 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" /> Nuevo Torneo
                    </button>
                  )}
                </div>

                {tournaments.length === 0 ? (
                  <div className="bg-slate-900 border border-slate-800 p-8 rounded-2xl text-center">
                    <p className="text-slate-400 text-sm">No hay ningún torneo creado.</p>
                    {role === 'admin' && (
                      <button
                        onClick={() => setShowTournamentModal(true)}
                        className="mt-4 bg-emerald-600 text-white text-xs font-bold px-4 py-2 rounded-xl cursor-pointer"
                      >
                        Crear Primer Torneo
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {tournaments.map(tour => (
                      <div 
                        key={tour.id}
                        className="bg-slate-900 border border-slate-800 rounded-2xl p-5 hover:border-slate-700 transition flex flex-col justify-between gap-4 cursor-pointer relative"
                        onClick={() => {
                          handleSelectTournament(tour);
                        }}
                      >
                        <div>
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-900/40">
                                {tour.type}
                              </span>
                              {role !== 'admin' && (!!tour.adminPassword || !!tour.visitorPassword) && (
                                <span className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded flex items-center gap-1 border ${
                                  unlockedTournaments[tour.id]
                                    ? 'bg-slate-900 text-emerald-400 border-slate-800'
                                    : 'bg-slate-950 text-amber-500 border-amber-900/30'
                                }`}>
                                  <Lock className="w-2.5 h-2.5" />
                                  {unlockedTournaments[tour.id] ? unlockedTournaments[tour.id] : 'Bloqueado'}
                                </span>
                              )}
                            </div>
                            
                            {role === 'admin' && (
                              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingTournament(tour);
                                  }}
                                  className="text-slate-400 hover:text-emerald-400 p-1 bg-slate-950/80 hover:bg-slate-800 rounded-lg border border-slate-800 transition cursor-pointer"
                                  title="Editar Torneo"
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteTournament(tour.id);
                                  }}
                                  className="text-slate-400 hover:text-red-400 p-1 bg-slate-950/80 hover:bg-slate-800 rounded-lg border border-slate-800 transition cursor-pointer"
                                  title="Eliminar Torneo"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}
                          </div>

                          <div className="flex items-center gap-3">
                            {tour.logoUrl ? (
                              <img 
                                src={tour.logoUrl} 
                                alt={tour.name} 
                                className="w-12 h-12 rounded-xl object-contain border border-slate-800 bg-slate-950 p-1"
                              />
                            ) : (
                              <div className="w-12 h-12 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-center text-2xl">
                                {tour.type === 'LIGA' ? '🏆' : tour.type === 'GRUPOS' ? '👥' : '⚔️'}
                              </div>
                            )}
                            <h4 className="text-lg font-bold text-white transition">
                              {tour.name}
                            </h4>
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-xs text-slate-400 border-t border-slate-800 pt-3">
                          <span className="flex items-center gap-1">
                            <Users className="w-3.5 h-3.5" /> {tour.teams.length} Equipos
                          </span>
                          <span className="text-emerald-400 font-bold flex items-center gap-0.5">
                            Ver Detalles <ArrowRight className="w-3 h-3" />
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB CONTENT: TEAMS */}
            {activeTab === 'teams' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-extrabold text-white">Equipos de Fútbol</h3>
                    <p className="text-xs text-slate-400">Administra los clubes, escudos y colores representativos</p>
                  </div>
                  {role === 'admin' && (
                    <button
                      onClick={() => setShowTeamModal(true)}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-1 transition shadow shadow-emerald-900"
                    >
                      <Plus className="w-3.5 h-3.5" /> Crear Club
                    </button>
                  )}
                </div>

                {teams.length === 0 ? (
                  <div className="bg-slate-900 border border-slate-800 p-8 rounded-2xl text-center">
                    <p className="text-slate-400 text-sm">No hay ningún equipo registrado.</p>
                    {role === 'admin' && (
                      <button
                        onClick={() => setShowTeamModal(true)}
                        className="mt-4 bg-emerald-600 text-white text-xs font-bold px-4 py-2 rounded-xl"
                      >
                        Crear Primer Club
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                    {teams.map(team => (
                      <div 
                        key={team.id}
                        className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col items-center text-center gap-3 relative group"
                      >
                        {renderTeamBadge(team, 'w-16 h-16')}
                        <div>
                          <h4 className="font-bold text-sm text-slate-100">{team.name}</h4>
                          <div className="flex gap-1.5 justify-center mt-1">
                            <span 
                              className="w-3 h-3 rounded-full border border-slate-700" 
                              style={{ backgroundColor: team.primaryColor }}
                              title="Color Primario"
                            />
                            <span 
                              className="w-3 h-3 rounded-full border border-slate-700" 
                              style={{ backgroundColor: team.secondaryColor }}
                              title="Color Secundario"
                            />
                          </div>
                        </div>

                        {role === 'admin' && (
                          <div className="absolute top-2 right-2 flex items-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingTeam(team);
                              }}
                              className="text-slate-400 hover:text-emerald-400 p-1 bg-slate-950/80 hover:bg-slate-800 rounded-lg border border-slate-800 transition cursor-pointer"
                              title="Editar Club"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteTeam(team.id);
                              }}
                              className="text-slate-400 hover:text-red-400 p-1 bg-slate-950/80 hover:bg-slate-800 rounded-lg border border-slate-800 transition cursor-pointer"
                              title="Eliminar Club"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB CONTENT: COMPARTIR */}
            {activeTab === 'share' && (
              <div className="max-w-xl mx-auto bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6 text-center relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 via-green-400 to-emerald-600" />
                
                <div className="space-y-2">
                  <h3 className="text-2xl font-extrabold text-white">Compartir PlayGol</h3>
                  <p className="text-sm text-slate-400">Invita a otros a seguir el torneo, ver las tablas de posiciones y resultados en tiempo real.</p>
                </div>

                <div className="flex flex-col items-center justify-center gap-4 py-4">
                  {/* QR Code */}
                  <div className="bg-white p-4 rounded-2xl shadow-xl shadow-slate-950/50 border border-slate-200 transform hover:scale-105 transition duration-300">
                    <img 
                      src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=020617&data=${encodeURIComponent(window.location.href)}`}
                      alt="PlayGol QR Code"
                      className="w-44 h-44"
                      referrerPolicy="no-referrer"
                    />
                  </div>
                  <p className="text-xs text-slate-500 font-mono">Escanea este código QR con la cámara de tu móvil para abrir la app</p>
                </div>

                <div className="space-y-3 pt-4 border-t border-slate-800/60">
                  <button
                    onClick={() => {
                      const appUrl = window.location.href;
                      const message = `🏆 *¡Te invito a seguir los torneos de fútbol en PlayGol!* ⚽\n\nEntra aquí para ver tablas de posiciones, resultados y partidos en vivo:\n🔗 ${appUrl}`;
                      const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
                      window.open(url, '_blank');
                    }}
                    className="w-full sm:w-auto px-8 py-3 bg-green-600 hover:bg-green-500 text-white font-bold rounded-xl flex items-center justify-center gap-2 transition shadow-lg shadow-green-950/45 cursor-pointer mx-auto"
                  >
                    <Share2 className="w-5 h-5" /> Compartir Enlace por WhatsApp
                  </button>
                  <p className="text-[10px] text-slate-500">También puedes copiar la URL de tu navegador y compartirla directamente.</p>
                </div>
              </div>
            )}

          </div>
        )}

      </main>

      {/* --- FOOTER COLOFON --- */}
      <footer className="bg-slate-950 border-t border-slate-900 py-6 px-4 mt-12 text-center text-xs text-slate-500">
        <p>© 2026 PlayGol. Todos los derechos reservados.</p>
        <p className="mt-1">Creado con diseño deportivo de alta fidelidad para el control integral de ligas de fútbol.</p>
      </footer>

      {/* --- MODAL: TEAM CREATION --- */}
      {showTeamModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 relative overflow-hidden shadow-2xl">
            <h3 className="text-lg font-extrabold text-white mb-4">Registrar Nuevo Equipo</h3>
            
            <form onSubmit={handleCreateTeam} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Nombre del Club *</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: Barcelona SC, Deportivo Cali..."
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                  value={newTeam.name}
                  onChange={(e) => setNewTeam(prev => ({ ...prev, name: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Color Principal</label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent"
                      value={newTeam.primaryColor}
                      onChange={(e) => setNewTeam(prev => ({ ...prev, primaryColor: e.target.value }))}
                    />
                    <span className="text-xs text-slate-300 font-mono">{newTeam.primaryColor}</span>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Color Secundario</label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      className="w-8 h-8 rounded cursor-pointer border-0 bg-transparent"
                      value={newTeam.secondaryColor}
                      onChange={(e) => setNewTeam(prev => ({ ...prev, secondaryColor: e.target.value }))}
                    />
                    <span className="text-xs text-slate-300 font-mono">{newTeam.secondaryColor}</span>
                  </div>
                </div>
              </div>

              {/* Symbol selector gallery */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Símbolo del Escudo</label>
                <div className="flex flex-wrap gap-2">
                  {BADGE_SYMBOLS.map(sym => (
                    <button
                      key={sym}
                      type="button"
                      onClick={() => setNewTeam(prev => ({ ...prev, badgeSymbol: sym, logoUrl: '' }))}
                      className={`px-2.5 py-1.5 text-xs font-bold rounded-lg capitalize border transition ${
                        newTeam.badgeSymbol === sym && !newTeam.logoUrl
                          ? 'bg-emerald-600 text-white border-emerald-500' 
                          : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      {sym === 'ball' ? '⚽ Balón' : sym === 'star' ? '⭐ Estrella' : sym === 'crown' ? '👑 Corona' : sym === 'trophy' ? '🏆 Copa' : sym === 'shield' ? '🛡️ Escudo' : sym === 'flame' ? '🔥 Fuego' : '⚡ Rayo'}
                    </button>
                  ))}
                </div>
              </div>

              {/* File upload section */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">O Subir Escudo Personalizado</label>
                <input
                  type="file"
                  ref={fileInputRef}
                  accept="image/*"
                  className="hidden"
                  onChange={handleImageChange}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-2 bg-slate-950 border border-slate-800 text-slate-300 text-xs font-bold rounded-xl hover:bg-slate-900 transition flex items-center justify-center gap-1.5"
                >
                  <Upload className="w-4 h-4 text-emerald-400" /> Subir Imagen desde Galería
                </button>
                {newTeam.logoUrl && (
                  <div className="mt-3 flex items-center justify-between p-2 bg-slate-950 rounded-lg border border-slate-800">
                    <div className="flex items-center gap-2">
                      <img src={newTeam.logoUrl} alt="Preview" className="w-10 h-10 rounded-full object-contain bg-slate-900 p-0.5 border border-slate-700" />
                      <span className="text-xs text-emerald-400 font-semibold">Escudo personalizado ✓</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setNewTeam(prev => ({ ...prev, logoUrl: '' }))}
                      className="text-xs text-red-400 hover:text-red-300 px-2 py-1 bg-red-950/40 border border-red-900/50 rounded-lg transition"
                    >
                      Quitar
                    </button>
                  </div>
                )}
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowTeamModal(false)}
                  className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition"
                >
                  Crear Equipo
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: TOURNAMENT CREATION --- */}
      {showTournamentModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 relative overflow-hidden shadow-2xl">
            <h3 className="text-lg font-extrabold text-white mb-4">Crear Nuevo Torneo</h3>

            <form onSubmit={handleCreateTournament} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Nombre del Torneo *</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: Copa de Verano, Torneo Relámpago..."
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                  value={newTournament.name}
                  onChange={(e) => setNewTournament(prev => ({ ...prev, name: e.target.value }))}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Formato del Torneo</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'LIGA', label: 'LIGA (Todos vs Todos)' },
                    { id: 'GRUPOS', label: 'GRUPOS' },
                    { id: 'ELIMINACION_DIRECTA', label: 'Eliminación Directa' },
                    { id: 'FASE_FINAL', label: 'FASE FINAL (Directa)' }
                  ].map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setNewTournament(prev => ({ ...prev, type: opt.id as TournamentType }))}
                      className={`p-2.5 text-xs font-bold rounded-xl border text-center transition ${
                        newTournament.type === opt.id
                          ? 'bg-emerald-600 text-white border-emerald-500 shadow-md'
                          : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Conditionally render inputs based on selection */}
              {newTournament.type === 'LIGA' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Cantidad de Equipos (LIGA)</label>
                  <input
                    type="number"
                    min={2}
                    max={64}
                    required
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                    value={newTournament.numTeams}
                    onChange={(e) => setNewTournament(prev => ({ ...prev, numTeams: Number(e.target.value) }))}
                  />
                </div>
              )}

              {newTournament.type === 'GRUPOS' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Cantidad de Grupos</label>
                  <input
                    type="number"
                    min={2}
                    max={8}
                    required
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                    value={newTournament.numGroups}
                    onChange={(e) => setNewTournament(prev => ({ ...prev, numGroups: Number(e.target.value) }))}
                  />
                </div>
              )}

              {newTournament.type === 'ELIMINACION_DIRECTA' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Cantidad de Equipos (Eliminación Directa)</label>
                  <input
                    type="number"
                    min={2}
                    max={64}
                    required
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                    value={newTournament.numTeams}
                    onChange={(e) => setNewTournament(prev => ({ ...prev, numTeams: Number(e.target.value) }))}
                  />
                </div>
              )}

              {newTournament.type === 'FASE_FINAL' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Fase de Inicio</label>
                  <select
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none"
                    value={newTournament.faseFinalType}
                    onChange={(e) => setNewTournament(prev => ({ ...prev, faseFinalType: e.target.value as any }))}
                  >
                    <option value="octavos">Octavos de Final (16 equipos)</option>
                    <option value="cuartos">Cuartos de Final (8 equipos)</option>
                    <option value="semis">Semifinal (4 equipos)</option>
                  </select>
                </div>
              )}

              {/* Tournament logo upload field */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Logo del Torneo (Imagen de Galería)</label>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => tourFileInputRef.current?.click()}
                    className="px-4 py-2 bg-slate-950 border border-slate-800 hover:bg-slate-850 rounded-xl text-xs font-bold text-slate-300 transition cursor-pointer flex items-center gap-1.5"
                  >
                    <Upload className="w-3.5 h-3.5" /> Subir Logo
                  </button>
                  <input
                    type="file"
                    ref={tourFileInputRef}
                    className="hidden"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        compressAndUploadImage(file, (base64) => {
                          setNewTournament(prev => ({ ...prev, logoUrl: base64 }));
                        });
                      }
                    }}
                  />
                  {newTournament.logoUrl && (
                    <div className="flex items-center gap-2">
                      <img 
                        src={newTournament.logoUrl} 
                        alt="Logo Preview" 
                        className="w-9 h-9 rounded-xl object-contain border border-slate-700 bg-slate-950 p-0.5" 
                      />
                      <button
                        type="button"
                        onClick={() => setNewTournament(prev => ({ ...prev, logoUrl: '' }))}
                        className="text-xs text-red-400 hover:text-red-300 px-2 py-1 bg-red-950/40 border border-red-900/50 rounded-lg transition"
                      >
                        Quitar
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Optional tournament passwords */}
              <div className="border-t border-slate-800/80 pt-4 space-y-3">
                <h4 className="text-xs font-bold text-emerald-400 uppercase tracking-wider">Configuración de Seguridad (Opcional)</h4>
                <p className="text-[10px] text-slate-400 leading-relaxed">Establece contraseñas para restringir el acceso a este torneo. Deja en blanco para permitir acceso libre a todos los visitantes.</p>
                
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">Contraseña AdminTorneo</label>
                    <input
                      type="text"
                      placeholder="Ej: adm123"
                      className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-xs focus:outline-none"
                      value={newTournament.adminPassword}
                      onChange={(e) => setNewTournament(prev => ({ ...prev, adminPassword: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-400 mb-1">Contraseña Visitante</label>
                    <input
                      type="text"
                      placeholder="Ej: vis123"
                      className="w-full px-2.5 py-1.5 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-xs focus:outline-none"
                      value={newTournament.visitorPassword}
                      onChange={(e) => setNewTournament(prev => ({ ...prev, visitorPassword: e.target.value }))}
                    />
                  </div>
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowTournamentModal(false)}
                  className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition"
                >
                  Crear Torneo
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: ASSIGN TEAM TO TOURNAMENT --- */}
      {showAssignModal && currentTour && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 relative overflow-hidden shadow-2xl">
            <h3 className="text-lg font-extrabold text-white mb-4">Inscribir Equipo en Torneo</h3>

            <form onSubmit={handleAssignTeam} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Seleccione un Equipo</label>
                <select
                  required
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none"
                  value={assignTeamState.teamId}
                  onChange={(e) => setAssignTeamState(prev => ({ ...prev, teamId: e.target.value }))}
                >
                  <option value="">-- Elija un Club Registrado --</option>
                  {teams.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>

              {/* If tournament type is GRUPOS, select group */}
              {currentTour.type === 'GRUPOS' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Grupo Correspondiente</label>
                  <select
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none"
                    value={assignTeamState.group}
                    onChange={(e) => setAssignTeamState(prev => ({ ...prev, group: e.target.value }))}
                  >
                    {Array.from({ length: currentTour.numGroups || 2 }, (_, i) => String.fromCharCode(65 + i)).map(g => (
                      <option key={g} value={g}>Grupo {g}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAssignModal(false)}
                  className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition"
                >
                  Inscribir Equipo
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: CREAR LLAVES AUTO (TEMPLATE-BASED) --- */}
      {showAutoLlaveModal && currentTour && (
        <div className="fixed inset-0 z-[110] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-lg p-6 relative overflow-hidden shadow-2xl">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-500 via-emerald-400 to-blue-600" />
            
            <h3 className="text-lg font-extrabold text-white mb-1">Crear Llaves Automáticamente</h3>
            <p className="text-xs text-slate-400 mb-4">
              Selecciona una plantilla de emparejamiento. La app calculará las posiciones actuales de cada grupo y creará los partidos.
            </p>

            <div className="space-y-4">
              {/* Template selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Plantilla de Emparejamientos</label>
                <select
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none focus:border-emerald-500"
                  value={selectedTemplateId}
                  onChange={(e) => {
                    setSelectedTemplateId(e.target.value);
                    const templates = getPairingTemplates(currentTour.numGroups || 2);
                    const match = templates.find(t => t.id === e.target.value);
                    if (match) {
                      setAutoPhaseName(match.phaseName);
                    }
                  }}
                >
                  {getPairingTemplates(currentTour.numGroups || 2).map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>

              {/* Phase name input */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Nombre de la Fase (Título)</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: Cuartos de Final..."
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                  value={autoPhaseName}
                  onChange={(e) => setAutoPhaseName(e.target.value)}
                />
              </div>

              {/* Pairings preview list */}
              <div className="bg-slate-950/60 p-4 rounded-2xl border border-slate-850 max-h-60 overflow-y-auto space-y-2">
                <span className="block text-[10px] font-bold text-emerald-400 uppercase tracking-wider mb-2">Vista Previa de Enfrentamientos</span>
                {(() => {
                  const pairings = generateMatchupsFromTemplate(currentTour.id, selectedTemplateId);
                  if (pairings.length === 0) {
                    return <p className="text-xs text-slate-500 text-center">No hay partidos calculados para esta plantilla.</p>;
                  }
                  return pairings.map((p, idx) => {
                    const teamA = teams.find(t => t.id === p.teamAId);
                    const teamB = teams.find(t => t.id === p.teamBId);
                    return (
                      <div key={idx} className="flex items-center justify-between py-1.5 px-2.5 bg-slate-900/50 rounded-lg border border-slate-850/50 text-xs">
                        <span className="font-semibold text-slate-400 text-[10px]">{p.label}</span>
                        <div className="flex items-center gap-1.5 font-bold text-white">
                          <span className={teamA ? 'text-white' : 'text-slate-500'}>{teamA ? teamA.name : 'Por clasificar'}</span>
                          <span className="text-slate-600 font-bold text-[10px]">vs</span>
                          <span className={teamB ? 'text-white' : 'text-slate-500'}>{teamB ? teamB.name : 'Por clasificar'}</span>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAutoLlaveModal(false)}
                  className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleAutoCreateLlaves}
                  className="flex-1 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl transition cursor-pointer"
                >
                  Generar y Guardar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL: CREATE MANUAL MATCH --- */}
      {showManualMatchModal && currentTour && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 relative overflow-hidden shadow-2xl">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 via-green-400 to-emerald-600" />
            
            <h3 className="text-lg font-extrabold text-white mb-4">Crear Partido Manual</h3>

            <form onSubmit={handleCreateManualMatch} className="space-y-4">
              
              {/* If tournament is GRUPOS, select group first */}
              {currentTour.type === 'GRUPOS' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Grupo</label>
                  <select
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none"
                    value={newMatchState.group}
                    onChange={(e) => {
                      setNewMatchState(prev => ({
                        ...prev,
                        group: e.target.value,
                        teamAId: '', 
                        teamBId: ''
                      }));
                    }}
                  >
                    {Array.from({ length: currentTour.numGroups || 2 }, (_, i) => String.fromCharCode(65 + i)).map(g => (
                      <option key={g} value={g}>Grupo {g}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Round / Fecha */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Fecha o Jornada</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: Fecha 1, Semifinal..."
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                  value={newMatchState.round}
                  onChange={(e) => setNewMatchState(prev => ({ ...prev, round: e.target.value }))}
                />
              </div>

              {/* Team A Selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Equipo Local (A)</label>
                <select
                  required
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none focus:border-emerald-500"
                  value={newMatchState.teamAId}
                  onChange={(e) => setNewMatchState(prev => ({ ...prev, teamAId: e.target.value }))}
                >
                  <option value="">-- Seleccionar Equipo --</option>
                  {(() => {
                    const tourTeams = currentTour.teams || [];
                    let available = tourTeams
                      .filter(tt => currentTour.type !== 'GRUPOS' || !tt.group || tt.group === newMatchState.group)
                      .map(tt => teams.find(t => t.id === tt.teamId))
                      .filter((t): t is Team => Boolean(t));

                    if (available.length === 0) {
                      available = teams;
                    }

                    return available.map(team => (
                      <option key={team.id} value={team.id}>{team.name}</option>
                    ));
                  })()}
                </select>
              </div>

              {/* Team B Selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Equipo Visitante (B)</label>
                <select
                  required
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none focus:border-emerald-500"
                  value={newMatchState.teamBId}
                  onChange={(e) => setNewMatchState(prev => ({ ...prev, teamBId: e.target.value }))}
                >
                  <option value="">-- Seleccionar Equipo --</option>
                  {(() => {
                    const tourTeams = currentTour.teams || [];
                    let available = tourTeams
                      .filter(tt => currentTour.type !== 'GRUPOS' || !tt.group || tt.group === newMatchState.group)
                      .map(tt => teams.find(t => t.id === tt.teamId))
                      .filter((t): t is Team => Boolean(t));

                    if (available.length === 0) {
                      available = teams;
                    }

                    return available
                      .filter(t => t.id !== newMatchState.teamAId)
                      .map(team => (
                        <option key={team.id} value={team.id}>{team.name}</option>
                      ));
                  })()}
                </select>
              </div>

              {/* Optional Free Team Selection (Only when the tournament or group team count is ODD) */}
              {(() => {
                const groupTeamsCount = currentTour.type === 'GRUPOS'
                  ? currentTour.teams.filter(tt => tt.group === newMatchState.group).length
                  : currentTour.teams.length;
                return groupTeamsCount % 2 !== 0;
              })() && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Equipo Libre por esta Fecha (Opcional)</label>
                  <select
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none focus:border-emerald-500"
                    value={newMatchState.freeTeamId}
                    onChange={(e) => setNewMatchState(prev => ({ ...prev, freeTeamId: e.target.value }))}
                  >
                    <option value="">-- Ninguno / Sin Equipo Libre --</option>
                    {(() => {
                      const tourTeams = currentTour.teams || [];
                      let available = tourTeams
                        .filter(tt => currentTour.type !== 'GRUPOS' || !tt.group || tt.group === newMatchState.group)
                        .map(tt => teams.find(t => t.id === tt.teamId))
                        .filter((t): t is Team => Boolean(t));

                      if (available.length === 0) {
                        available = teams;
                      }

                      return available.map(team => (
                        <option key={team.id} value={team.id}>{team.name}</option>
                      ));
                    })()}
                  </select>
                </div>
              )}

              {/* Optional Time and Venue fields for manual creation */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Hora (Opcional)</label>
                  <input
                    type="time"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                    value={newMatchState.time || ''}
                    onChange={(e) => setNewMatchState(prev => ({ ...prev, time: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Sede (Opcional)</label>
                  <input
                    type="text"
                    placeholder="Ej: Cancha 1, Estadio..."
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                    value={newMatchState.venue || ''}
                    onChange={(e) => setNewMatchState(prev => ({ ...prev, venue: e.target.value }))}
                  />
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowManualMatchModal(false)}
                  className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition"
                >
                  Crear Partido
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: BRACKET PAIRING ASSIGNMENT --- */}
      {showBracketPairingModal && bracketPairingTour && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-lg p-6 relative overflow-hidden shadow-2xl my-8">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 via-green-400 to-emerald-600" />
            
            <h3 className="text-xl font-extrabold text-white mb-1">Emparejar Rivales - {bracketRoundName}</h3>
            <p className="text-xs text-slate-400 mb-6">Asigne los equipos para cada enfrentamiento inicial de la llave de eliminación.</p>

            <form onSubmit={handleSaveBracketPairings} className="space-y-4">
              <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
                {bracketPairings.map((pair, idx) => (
                  <div key={idx} className="p-3 bg-slate-950 rounded-2xl border border-slate-850 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <span className="text-xs font-bold text-slate-400 sm:w-20">Partido {idx + 1}</span>
                    
                    <div className="flex-1 flex items-center gap-2">
                      <select
                        className="flex-1 px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded-xl text-slate-200 text-xs focus:outline-none focus:border-emerald-500"
                        value={pair.teamAId}
                        onChange={(e) => {
                          const updated = [...bracketPairings];
                          updated[idx].teamAId = e.target.value;
                          setBracketPairings(updated);
                        }}
                      >
                        <option value="">-- Sin asignar --</option>
                        {bracketPairingTour.teams.map(tt => {
                          const team = teams.find(t => t.id === tt.teamId);
                          return team ? <option key={team.id} value={team.id}>{team.name}</option> : null;
                        })}
                      </select>

                      <span className="text-[10px] font-extrabold text-slate-500">VS</span>

                      <select
                        className="flex-1 px-2.5 py-1.5 bg-slate-900 border border-slate-800 rounded-xl text-slate-200 text-xs focus:outline-none focus:border-emerald-500"
                        value={pair.teamBId}
                        onChange={(e) => {
                          const updated = [...bracketPairings];
                          updated[idx].teamBId = e.target.value;
                          setBracketPairings(updated);
                        }}
                      >
                        <option value="">-- Sin asignar --</option>
                        {bracketPairingTour.teams.map(tt => {
                          const team = teams.find(t => t.id === tt.teamId);
                          return team ? <option key={team.id} value={team.id}>{team.name}</option> : null;
                        })}
                      </select>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex gap-2 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setShowBracketPairingModal(false);
                    setBracketPairingTour(null);
                  }}
                  className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition"
                >
                  Confirmar y Generar Árbol
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: EDIT MATCH SCORE --- */}
      {editingMatch && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-sm p-6 relative overflow-hidden shadow-2xl">
            <h3 className="text-sm font-bold text-slate-400 mb-3 text-center uppercase tracking-wider">
              {editingMatch.round}
            </h3>

            <form onSubmit={handleSaveScore} className="space-y-4">
              <div className="flex items-center justify-between gap-2 p-3 bg-slate-950 rounded-2xl border border-slate-850">
                
                {/* Team A controls */}
                <div className="flex flex-col items-center flex-1 text-center gap-1 overflow-hidden">
                  {renderTeamBadge(teams.find(t => t.id === editingMatch.teamAId) || { id: 'x', name: 'TBD', primaryColor: '#000', secondaryColor: '#000', badgeSymbol: 'ball' }, 'w-10 h-10')}
                  <span className="font-bold text-xs text-white truncate max-w-[100px]">
                    {teams.find(t => t.id === editingMatch.teamAId)?.name || 'TBD'}
                  </span>
                  <input
                    type="number"
                    min="0"
                    placeholder="-"
                    className="w-12 h-10 text-center bg-slate-900 border border-slate-800 rounded-lg text-lg font-black focus:border-emerald-500 focus:outline-none text-white mt-1"
                    value={editScoreA}
                    onChange={(e) => setEditScoreA(e.target.value)}
                  />
                </div>

                <div className="text-slate-500 font-extrabold text-sm">VS</div>

                {/* Team B controls */}
                <div className="flex flex-col items-center flex-1 text-center gap-1 overflow-hidden">
                  {renderTeamBadge(teams.find(t => t.id === editingMatch.teamBId) || { id: 'x', name: 'TBD', primaryColor: '#000', secondaryColor: '#000', badgeSymbol: 'ball' }, 'w-10 h-10')}
                  <span className="font-bold text-xs text-white truncate max-w-[100px]">
                    {teams.find(t => t.id === editingMatch.teamBId)?.name || 'TBD'}
                  </span>
                  <input
                    type="number"
                    min="0"
                    placeholder="-"
                    className="w-12 h-10 text-center bg-slate-900 border border-slate-800 rounded-lg text-lg font-black focus:border-emerald-500 focus:outline-none text-white mt-1"
                    value={editScoreB}
                    onChange={(e) => setEditScoreB(e.target.value)}
                  />
                </div>

              </div>

              {/* Optional penalty shootouts for knockout matches */}
              {editingMatch && (() => {
                const tour = tournaments.find(t => t.id === editingMatch.tournamentId);
                const isKnockout = editingMatch.isLlave || (tour && (tour.type === 'ELIMINACION_DIRECTA' || tour.type === 'FASE_FINAL'));
                return isKnockout;
              })() && (
                <div className="bg-slate-950/50 p-3 rounded-2xl border border-slate-800/80 space-y-2">
                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wide text-center">Tanda de Penales (En caso de empate)</span>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex flex-col items-center flex-1">
                      <label className="text-[10px] font-semibold text-slate-500 mb-1">Penales Local</label>
                      <input
                        type="number"
                        min="0"
                        placeholder="-"
                        className="w-12 h-9 text-center bg-slate-900 border border-slate-800 rounded-lg text-sm font-bold focus:border-emerald-500 focus:outline-none text-white"
                        value={editPenaltiesA}
                        onChange={(e) => setEditPenaltiesA(e.target.value)}
                      />
                    </div>
                    <div className="text-slate-600 font-extrabold text-xs">PK</div>
                    <div className="flex flex-col items-center flex-1">
                      <label className="text-[10px] font-semibold text-slate-500 mb-1">Penales Visita</label>
                      <input
                        type="number"
                        min="0"
                        placeholder="-"
                        className="w-12 h-9 text-center bg-slate-900 border border-slate-800 rounded-lg text-sm font-bold focus:border-emerald-500 focus:outline-none text-white"
                        value={editPenaltiesB}
                        onChange={(e) => setEditPenaltiesB(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Informative help note */}
              <p className="text-[10px] text-slate-500 text-center leading-relaxed">
                Dejar vacío alguno de los campos de puntaje guardará el partido como "No Jugado".
              </p>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingMatch(null)}
                  className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition"
                >
                  Guardar Marcador
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: EDIT TEAM --- */}
      {editingTeam && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 relative overflow-hidden shadow-2xl">
            <h3 className="text-lg font-extrabold text-white mb-4">Editar Equipo</h3>
            
            <form onSubmit={handleEditTeam} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Nombre del Club *</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: Barcelona SC..."
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                  value={editingTeam.name}
                  onChange={(e) => setEditingTeam(prev => prev ? ({ ...prev, name: e.target.value }) : null)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Color Principal</label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      className="w-10 h-10 rounded-xl bg-transparent border border-slate-800 cursor-pointer"
                      value={editingTeam.primaryColor}
                      onChange={(e) => setEditingTeam(prev => prev ? ({ ...prev, primaryColor: e.target.value }) : null)}
                    />
                    <span className="text-xs font-mono text-slate-400 uppercase">{editingTeam.primaryColor}</span>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Color Secundario</label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="color"
                      className="w-10 h-10 rounded-xl bg-transparent border border-slate-800 cursor-pointer"
                      value={editingTeam.secondaryColor}
                      onChange={(e) => setEditingTeam(prev => prev ? ({ ...prev, secondaryColor: e.target.value }) : null)}
                    />
                    <span className="text-xs font-mono text-slate-400 uppercase">{editingTeam.secondaryColor}</span>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Escudo del Club (Galería)</label>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => editTeamFileInputRef.current?.click()}
                    className="px-4 py-2 bg-slate-950 border border-slate-800 hover:bg-slate-855 rounded-xl text-xs font-bold text-slate-300 transition cursor-pointer flex items-center gap-1.5"
                  >
                    <Upload className="w-3.5 h-3.5" /> Cambiar Imagen
                  </button>
                  <input
                    type="file"
                    ref={editTeamFileInputRef}
                    className="hidden"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        compressAndUploadImage(file, (base64) => {
                          setEditingTeam(prev => prev ? ({ ...prev, logoUrl: base64 }) : null);
                        });
                      }
                    }}
                  />
                  {editingTeam.logoUrl && (
                    <div className="flex items-center gap-2">
                      <img 
                        src={editingTeam.logoUrl} 
                        alt="Logo Preview" 
                        className="w-10 h-10 rounded-xl object-contain border border-slate-700 bg-slate-950 p-0.5" 
                      />
                      <button
                        type="button"
                        onClick={() => setEditingTeam(prev => prev ? ({ ...prev, logoUrl: '' }) : null)}
                        className="text-xs text-red-400 hover:text-red-300 px-2 py-1 bg-red-950/40 border border-red-900/50 rounded-lg transition"
                      >
                        Quitar
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingTeam(null)}
                  className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition"
                >
                  Guardar Cambios
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: EDIT TOURNAMENT --- */}
      {editingTournament && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 relative overflow-hidden shadow-2xl">
            <h3 className="text-lg font-extrabold text-white mb-4">Editar Torneo</h3>

            <form onSubmit={handleEditTournament} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Nombre del Torneo *</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: Copa de Verano..."
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                  value={editingTournament.name}
                  onChange={(e) => setEditingTournament(prev => prev ? ({ ...prev, name: e.target.value }) : null)}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Formato del Torneo</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'LIGA', label: 'LIGA (Todos vs Todos)' },
                    { id: 'GRUPOS', label: 'GRUPOS' },
                    { id: 'ELIMINACION_DIRECTA', label: 'Eliminación Directa' },
                    { id: 'FASE_FINAL', label: 'FASE FINAL (Directa)' }
                  ].map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setEditingTournament(prev => prev ? ({ ...prev, type: opt.id as TournamentType }) : null)}
                      className={`p-2.5 text-xs font-bold rounded-xl border text-center transition ${
                        editingTournament.type === opt.id
                          ? 'bg-emerald-600 text-white border-emerald-500 shadow-md'
                          : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {editingTournament.type === 'LIGA' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Cantidad de Equipos (LIGA)</label>
                  <input
                    type="number"
                    min={2}
                    max={64}
                    required
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                    value={editingTournament.numTeams || ''}
                    onChange={(e) => setEditingTournament(prev => prev ? ({ ...prev, numTeams: Number(e.target.value) }) : null)}
                  />
                </div>
              )}

              {editingTournament.type === 'GRUPOS' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Cantidad de Grupos</label>
                  <input
                    type="number"
                    min={2}
                    max={8}
                    required
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                    value={editingTournament.numGroups || ''}
                    onChange={(e) => setEditingTournament(prev => prev ? ({ ...prev, numGroups: Number(e.target.value) }) : null)}
                  />
                </div>
              )}

              {editingTournament.type === 'ELIMINACION_DIRECTA' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Cantidad de Equipos (Eliminación Directa)</label>
                  <input
                    type="number"
                    min={2}
                    max={64}
                    required
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                    value={editingTournament.numTeams || ''}
                    onChange={(e) => setEditingTournament(prev => prev ? ({ ...prev, numTeams: Number(e.target.value) }) : null)}
                  />
                </div>
              )}

              {editingTournament.type === 'FASE_FINAL' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Fase de Inicio</label>
                  <select
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none"
                    value={editingTournament.faseFinalType || 'semis'}
                    onChange={(e) => setEditingTournament(prev => prev ? ({ ...prev, faseFinalType: e.target.value as any }) : null)}
                  >
                    <option value="octavos">Octavos de Final (16 equipos)</option>
                    <option value="cuartos">Cuartos de Final (8 equipos)</option>
                    <option value="semis">Semifinal (4 equipos)</option>
                  </select>
                </div>
              )}

              {/* Tournament logo upload field */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Logo del Torneo (Imagen de Galería)</label>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => editTourFileInputRef.current?.click()}
                    className="px-4 py-2 bg-slate-950 border border-slate-800 hover:bg-slate-850 rounded-xl text-xs font-bold text-slate-300 transition cursor-pointer flex items-center gap-1.5"
                  >
                    <Upload className="w-3.5 h-3.5" /> Cambiar Logo
                  </button>
                  <input
                    type="file"
                    ref={editTourFileInputRef}
                    className="hidden"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        compressAndUploadImage(file, (base64) => {
                          setEditingTournament(prev => prev ? ({ ...prev, logoUrl: base64 }) : null);
                        });
                      }
                    }}
                  />
                  {editingTournament.logoUrl && (
                    <div className="flex items-center gap-2">
                      <img 
                        src={editingTournament.logoUrl} 
                        alt="Logo Preview" 
                        className="w-8 h-8 rounded-lg object-contain border border-slate-700 bg-slate-950 p-0.5" 
                      />
                      <button
                        type="button"
                        onClick={() => setEditingTournament(prev => prev ? ({ ...prev, logoUrl: '' }) : null)}
                        className="text-xs text-red-400 hover:text-red-300 px-2 py-1 bg-red-950/40 border border-red-900/50 rounded-lg transition"
                      >
                        Quitar
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingTournament(null)}
                  className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition"
                >
                  Guardar Cambios
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: EDIT MATCH DETAILS --- */}
      {editingMatchDetails && (
        <div className="fixed inset-0 z-[60] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 relative overflow-hidden shadow-2xl">
            <h3 className="text-lg font-extrabold text-white mb-4">Editar Detalles de Partido</h3>

            <form onSubmit={handleSaveMatchDetails} className="space-y-4">
              {/* Round / Fecha */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Fecha o Jornada</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: Fecha 1, Semifinal..."
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                  value={matchDetailsState.round}
                  onChange={(e) => setMatchDetailsState(prev => ({ ...prev, round: e.target.value }))}
                />
              </div>

              {/* Group selection (only if GROUPS) */}
              {currentTour && currentTour.type === 'GRUPOS' && editingMatchDetails.round !== 'LLAVES' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Grupo del Partido</label>
                  <select
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none focus:border-emerald-500"
                    value={matchDetailsState.group}
                    onChange={(e) => {
                      setMatchDetailsState(prev => ({
                        ...prev,
                        group: e.target.value,
                        teamAId: '',
                        teamBId: ''
                      }));
                    }}
                  >
                    {Array.from({ length: currentTour.numGroups || 2 }, (_, i) => String.fromCharCode(65 + i)).map(g => (
                      <option key={g} value={g}>Grupo {g}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Checkbox for LLAVES manual override */}
              {editingMatchDetails.round === 'LLAVES' && (
                <div className="flex items-center gap-2.5 bg-slate-950/40 p-3 rounded-2xl border border-slate-800/85">
                  <input
                    type="checkbox"
                    id="overrideTeamsCheck"
                    className="w-4 h-4 rounded border-slate-800 text-emerald-500 focus:ring-emerald-500 bg-slate-950 cursor-pointer"
                    checked={matchDetailsState.overrideTeams}
                    onChange={(e) => setMatchDetailsState(prev => ({ ...prev, overrideTeams: e.target.checked }))}
                  />
                  <div className="leading-tight cursor-pointer select-none">
                    <label htmlFor="overrideTeamsCheck" className="text-xs font-bold text-slate-200 block cursor-pointer">
                      Modo Manual (Cruces Personalizados)
                    </label>
                    <span className="text-[10px] text-slate-400 block mt-0.5">
                      Activa esto para sobrescribir los emparejamientos dinámicos de los grupos.
                    </span>
                  </div>
                </div>
              )}

              {/* Team A Selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Equipo Local (A)</label>
                <select
                  required
                  disabled={editingMatchDetails.round === 'LLAVES' && !matchDetailsState.overrideTeams}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none focus:border-emerald-500 disabled:opacity-60"
                  value={matchDetailsState.teamAId}
                  onChange={(e) => setMatchDetailsState(prev => ({ ...prev, teamAId: e.target.value }))}
                >
                  <option value="">-- Seleccionar Equipo --</option>
                  {(() => {
                    if (!currentTour) return null;
                    const tourTeams = currentTour.teams || [];
                    let available = (editingMatchDetails.round === 'LLAVES'
                      ? tourTeams
                      : tourTeams.filter(tt => currentTour.type !== 'GRUPOS' || !tt.group || tt.group === matchDetailsState.group)
                    )
                      .map(tt => teams.find(t => t.id === tt.teamId))
                      .filter((t): t is Team => Boolean(t));

                    if (available.length === 0) {
                      available = teams;
                    }

                    return available.map(team => (
                      <option key={team.id} value={team.id}>{team.name}</option>
                    ));
                  })()}
                </select>
              </div>

              {/* Team B Selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Equipo Visitante (B)</label>
                <select
                  required
                  disabled={editingMatchDetails.round === 'LLAVES' && !matchDetailsState.overrideTeams}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none focus:border-emerald-500 disabled:opacity-60"
                  value={matchDetailsState.teamBId}
                  onChange={(e) => setMatchDetailsState(prev => ({ ...prev, teamBId: e.target.value }))}
                >
                  <option value="">-- Seleccionar Equipo --</option>
                  {(() => {
                    if (!currentTour) return null;
                    const tourTeams = currentTour.teams || [];
                    let available = (editingMatchDetails.round === 'LLAVES'
                      ? tourTeams
                      : tourTeams.filter(tt => currentTour.type !== 'GRUPOS' || !tt.group || tt.group === matchDetailsState.group)
                    )
                      .map(tt => teams.find(t => t.id === tt.teamId))
                      .filter((t): t is Team => Boolean(t));

                    if (available.length === 0) {
                      available = teams;
                    }

                    return available
                      .filter(t => t.id !== matchDetailsState.teamAId)
                      .map(team => (
                        <option key={team.id} value={team.id}>{team.name}</option>
                      ));
                  })()}
                </select>
              </div>

              {/* Optional Free Team Selection (Only when the tournament or group team count is ODD) */}
              {currentTour && (() => {
                const groupTeamsCount = currentTour.type === 'GRUPOS'
                  ? currentTour.teams.filter(tt => tt.group === matchDetailsState.group).length
                  : currentTour.teams.length;
                return groupTeamsCount % 2 !== 0;
              })() && (
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Equipo Libre por esta Fecha (Opcional)</label>
                  <select
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none focus:border-emerald-500"
                    value={matchDetailsState.freeTeamId}
                    onChange={(e) => setMatchDetailsState(prev => ({ ...prev, freeTeamId: e.target.value }))}
                  >
                    <option value="">-- Ninguno / Sin Equipo Libre --</option>
                    {currentTour.teams
                      .filter(tt => currentTour.type !== 'GRUPOS' || tt.group === matchDetailsState.group)
                      .map(tt => {
                        const team = teams.find(t => t.id === tt.teamId);
                        return team ? <option key={team.id} value={team.id}>{team.name}</option> : null;
                      })}
                  </select>
                </div>
              )}

              {/* Optional Time and Venue fields */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Hora del Partido (Opcional)</label>
                  <input
                    type="time"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                    value={matchDetailsState.time || ''}
                    onChange={(e) => setMatchDetailsState(prev => ({ ...prev, time: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1.5">Sede/Lugar (Opcional)</label>
                  <input
                    type="text"
                    placeholder="Ej: Cancha 3, Estadio..."
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                    value={matchDetailsState.venue || ''}
                    onChange={(e) => setMatchDetailsState(prev => ({ ...prev, venue: e.target.value }))}
                  />
                </div>
              </div>

              {/* Goles/Marcador optional editor */}
              <div className="bg-slate-950/50 p-3 rounded-2xl border border-slate-800/80">
                <span className="block text-[10px] font-bold text-slate-400 mb-2 uppercase tracking-wide">Marcador (Opcional)</span>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 mb-1">Goles Local (A)</label>
                    <input
                      type="number"
                      min="0"
                      placeholder="-"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                      value={matchDetailsState.scoreA}
                      onChange={(e) => setMatchDetailsState(prev => ({ ...prev, scoreA: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 mb-1">Goles Visitante (B)</label>
                    <input
                      type="number"
                      min="0"
                      placeholder="-"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                      value={matchDetailsState.scoreB}
                      onChange={(e) => setMatchDetailsState(prev => ({ ...prev, scoreB: e.target.value }))}
                    />
                  </div>
                </div>
              </div>

              {/* Optional penalty shootouts for knockout matches inside Details Modal */}
              {editingMatchDetails && (() => {
                const isKnockout = editingMatchDetails.isLlave || editingMatchDetails.round === 'LLAVES' || (currentTour && (currentTour.type === 'ELIMINACION_DIRECTA' || currentTour.type === 'FASE_FINAL'));
                return isKnockout;
              })() && (
                <div className="bg-slate-950/50 p-3 rounded-2xl border border-slate-800/80">
                  <span className="block text-[10px] font-bold text-slate-400 mb-2 uppercase tracking-wide">Penales en caso de empate (Opcional)</span>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-500 mb-1">Penales Local (A)</label>
                      <input
                        type="number"
                        min="0"
                        placeholder="-"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                        value={matchDetailsState.penaltiesA}
                        onChange={(e) => setMatchDetailsState(prev => ({ ...prev, penaltiesA: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-slate-500 mb-1">Penales Visitante (B)</label>
                      <input
                        type="number"
                        min="0"
                        placeholder="-"
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                        value={matchDetailsState.penaltiesB}
                        onChange={(e) => setMatchDetailsState(prev => ({ ...prev, penaltiesB: e.target.value }))}
                      />
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingMatchDetails(null)}
                  className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition"
                >
                  Guardar Cambios
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- CUSTOM CONFIRMATION MODAL --- */}
      {confirmModalState && confirmModalState.isOpen && (
        <div className="fixed inset-0 z-[100] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-sm p-6 relative overflow-hidden shadow-2xl">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-red-500 to-orange-500" />
            <h3 className="text-base font-extrabold text-white mb-2">{confirmModalState.title}</h3>
            <p className="text-xs text-slate-400 mb-6 leading-relaxed">{confirmModalState.message}</p>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmModalState(null)}
                className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition"
              >
                {confirmModalState.cancelText}
              </button>
              <button
                type="button"
                onClick={confirmModalState.onConfirm}
                className="flex-1 py-2 bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded-xl transition"
              >
                {confirmModalState.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL: ENTER TOURNAMENT PASSWORD --- */}
      {passwordCheckingTourId && (
        <div className="fixed inset-0 z-[110] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-sm p-6 relative overflow-hidden shadow-2xl">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 via-green-400 to-emerald-600" />
            
            <h3 className="text-lg font-extrabold text-white mb-1">Ingresar al Torneo</h3>
            <p className="text-xs text-slate-400 mb-4">
              Este torneo está restringido. Ingresa la contraseña asignada por el Administrador.
            </p>

            <form onSubmit={handleVerifyTournamentPassword} className="space-y-4">
              <div className="relative">
                <input
                  type={showTourPassword ? 'text' : 'password'}
                  required
                  placeholder="Contraseña del torneo"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none pr-10"
                  value={tourPasswordValue}
                  onChange={(e) => {
                    setTourPasswordValue(e.target.value);
                    setTourPasswordError('');
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowTourPassword(!showTourPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                >
                  {showTourPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {tourPasswordError && (
                <p className="text-xs text-red-500 font-bold text-center bg-red-950/30 border border-red-900/40 py-1.5 rounded-lg">
                  {tourPasswordError}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPasswordCheckingTourId(null)}
                  className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition"
                >
                  Acceder
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: CUSTOM BRACKET BUILDER (CREADOR DE LLAVES PERSONALIZADAS) --- */}
      {showBracketBuilderModal && currentTour && (
        <div className="fixed inset-0 z-[120] bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-3xl max-h-[90vh] flex flex-col relative overflow-hidden shadow-2xl my-auto">
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-emerald-500 via-teal-400 to-green-500" />

            {/* Header */}
            <div className="p-5 sm:p-6 border-b border-slate-800 flex-shrink-0">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-emerald-950/80 border border-emerald-800/60 flex items-center justify-center text-emerald-400 flex-shrink-0 shadow-inner">
                    <Wand2 className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base sm:text-lg font-black text-white uppercase tracking-wider">
                      Armar y Personalizar Cruces de Llaves
                    </h3>
                    <p className="text-xs text-slate-400">
                      Torneo: <span className="text-slate-200 font-bold">{currentTour.name}</span>
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setShowBracketBuilderModal(false)}
                  className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center text-sm transition cursor-pointer"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Scrollable Content */}
            <div className="p-5 sm:p-6 space-y-6 overflow-y-auto flex-1">
              {/* Phase name selection */}
              <div>
                <label className="block text-xs font-bold text-slate-300 mb-1.5 uppercase tracking-wider">
                  Nombre de la Fase
                </label>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  {['Octavos de Final', 'Final Directa', 'Segunda Fase', 'Cuartos de Final', 'Semifinales'].map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => handleSelectPhaseNameQuick(p)}
                      className={`px-3 py-1.5 text-xs font-bold rounded-xl border transition cursor-pointer flex items-center gap-1.5 ${
                        bracketBuilderPhaseName === p
                          ? 'bg-emerald-600 text-white border-emerald-500 shadow-md shadow-emerald-950 ring-1 ring-emerald-400/50'
                          : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200 hover:border-slate-700'
                      }`}
                    >
                      {p === 'Octavos de Final' && '🏆'}
                      {p === 'Final Directa' && '🥇'}
                      {p === 'Segunda Fase' && '⚔️'}
                      {p === 'Cuartos de Final' && '🏅'}
                      {p === 'Semifinales' && '🎖️'}
                      <span>{p}</span>
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  required
                  placeholder="Ej: Octavos de Final, Final Directa, Segunda Fase, Liguilla Final..."
                  className="w-full px-3.5 py-2.5 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                  value={bracketBuilderPhaseName}
                  onChange={(e) => setBracketBuilderPhaseName(e.target.value)}
                />
              </div>

              {/* Preset Template Selector */}
              {(() => {
                const allTemplates = getBracketTemplates(currentTour);
                if (allTemplates.length === 0) return null;

                const filteredTemplates = bracketTemplateCategoryFilter === 'ALL'
                  ? allTemplates
                  : allTemplates.filter(t => t.category === bracketTemplateCategoryFilter);

                const categoryButtons: { key: string; label: string; icon: string }[] = [
                  { key: 'ALL', label: 'Todas', icon: '✨' },
                  { key: 'OCTAVOS', label: 'Octavos', icon: '🏆' },
                  { key: 'FINAL_DIRECTA', label: 'Final Directa', icon: '🥇' },
                  { key: 'SEGUNDA_FASE', label: 'Segunda Fase', icon: '⚔️' },
                  { key: 'CUARTOS', label: 'Cuartos', icon: '🏅' },
                  { key: 'SEMIS', label: 'Semifinales', icon: '🎖️' }
                ];

                return (
                  <div className="bg-slate-950/70 border border-slate-800/90 rounded-2xl p-4 sm:p-5 space-y-3.5 shadow-inner">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs font-extrabold text-emerald-400 uppercase tracking-wide">
                        <Sparkles className="w-4 h-4 text-emerald-400 animate-pulse" />
                        <span>Cargar Plantilla de Cruces Predefinida</span>
                      </div>
                      <span className="text-[11px] text-slate-400">
                        Selecciona una plantilla para actualizar automáticamente los cruces de abajo
                      </span>
                    </div>

                    {/* Category Filter Tabs */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-slate-850">
                      {categoryButtons.map(cat => {
                        const count = cat.key === 'ALL'
                          ? allTemplates.length
                          : allTemplates.filter(t => t.category === cat.key).length;
                        
                        if (count === 0 && cat.key !== 'ALL') return null;

                        const isSelected = bracketTemplateCategoryFilter === cat.key;
                        return (
                          <button
                            key={cat.key}
                            type="button"
                            onClick={() => setBracketTemplateCategoryFilter(cat.key)}
                            className={`px-3 py-1 text-xs font-bold rounded-lg border transition cursor-pointer flex items-center gap-1.5 ${
                              isSelected
                                ? 'bg-emerald-600/30 text-emerald-300 border-emerald-500/60 shadow-sm'
                                : 'bg-slate-900/80 text-slate-400 border-slate-800 hover:text-slate-200 hover:bg-slate-850'
                            }`}
                          >
                            <span>{cat.icon}</span>
                            <span>{cat.label}</span>
                            <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                              isSelected ? 'bg-emerald-500 text-slate-950 font-black' : 'bg-slate-800 text-slate-400'
                            }`}>
                              {count}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Template Cards Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-60 overflow-y-auto pr-1">
                      {filteredTemplates.map(tmpl => {
                        const isCurrentSelected = bracketBuilderSelectedTemplate === tmpl.id;
                        return (
                          <button
                            key={tmpl.id}
                            type="button"
                            onClick={() => handleApplyBracketTemplate(tmpl.id)}
                            className={`p-3 rounded-xl text-left transition cursor-pointer flex flex-col justify-between gap-1.5 border relative group ${
                              isCurrentSelected
                                ? 'bg-emerald-950/40 border-emerald-500 shadow-md shadow-emerald-950/50 ring-1 ring-emerald-500/30'
                                : 'bg-slate-900/90 hover:bg-slate-850 border-slate-800 hover:border-emerald-500/40'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className={`text-xs font-bold transition flex items-center gap-1.5 ${
                                isCurrentSelected ? 'text-emerald-300' : 'text-slate-200 group-hover:text-emerald-400'
                              }`}>
                                {isCurrentSelected && <Check className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />}
                                <span>{tmpl.name}</span>
                              </span>
                              <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-md bg-slate-950 border border-slate-800 text-slate-400 flex-shrink-0">
                                {tmpl.rules.length} {tmpl.rules.length === 1 ? 'Llave' : 'Llaves'}
                              </span>
                            </div>
                            <span className="text-[10px] text-slate-400 leading-snug line-clamp-2">
                              {tmpl.description}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Cruces List Editor */}
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-slate-950/40 p-3 rounded-2xl border border-slate-850">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-black text-slate-200 uppercase tracking-wider">
                        Cruces / Enfrentamientos ({bracketBuilderRules.length} {bracketBuilderRules.length === 1 ? 'partido' : 'partidos'})
                      </span>
                      <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-emerald-950 border border-emerald-800 text-emerald-400">
                        {bracketBuilderPhaseName}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Los cruces se actualizan según la plantilla seleccionada o puedes editarlos y personalizarlos libremente
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const newIdx = bracketBuilderRules.length + 1;
                      setBracketBuilderRules(prev => [
                        ...prev,
                        {
                          id: `rule-${Date.now()}-${newIdx}`,
                          sourceA: 'TBD',
                          sourceB: 'TBD',
                          customLabel: `Llave ${newIdx}`
                        }
                      ]);
                    }}
                    className="px-3.5 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 rounded-xl text-xs font-bold flex items-center gap-1.5 transition cursor-pointer self-start sm:self-auto"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Agregar Cruce Manual</span>
                  </button>
                </div>

                <div className="space-y-3">
                  {(() => {
                    const availableSources = getAvailableBracketSources(currentTour);
                    // Group sources by their group category for clean optgroups
                    const groupedSources = availableSources.reduce((acc, s) => {
                      if (!acc[s.group]) acc[s.group] = [];
                      acc[s.group].push(s);
                      return acc;
                    }, {} as Record<string, typeof availableSources>);

                    return bracketBuilderRules.map((rule, idx) => {
                      const resA = resolveBracketSource(currentTour.id, rule.sourceA);
                      const resB = resolveBracketSource(currentTour.id, rule.sourceB);

                      return (
                        <div
                          key={rule.id || idx}
                          className="p-4 bg-slate-950 rounded-2xl border border-slate-850 space-y-3 hover:border-slate-800 transition shadow-sm"
                        >
                          {/* Cruce header bar */}
                          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-850/80 pb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-black text-emerald-400 uppercase tracking-widest bg-emerald-950/80 border border-emerald-900/50 px-2.5 py-0.5 rounded-md">
                                Cruce #{idx + 1}
                              </span>
                              <input
                                type="text"
                                placeholder={`Ej: 1ro Grupo A vs 4to Grupo C`}
                                className="px-2.5 py-1 bg-slate-900 border border-slate-800 rounded-lg text-slate-200 text-xs focus:border-emerald-500 focus:outline-none w-48 sm:w-72 font-medium"
                                value={rule.customLabel || ''}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setBracketBuilderRules(prev =>
                                    prev.map((r, i) => i === idx ? { ...r, customLabel: val } : r)
                                  );
                                }}
                              />
                            </div>

                            {bracketBuilderRules.length > 1 && (
                              <button
                                type="button"
                                onClick={() => {
                                  setBracketBuilderRules(prev => prev.filter((_, i) => i !== idx));
                                }}
                                className="text-slate-500 hover:text-red-400 text-xs p-1.5 rounded-lg hover:bg-slate-900 transition cursor-pointer flex items-center gap-1"
                                title="Eliminar este cruce"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                                <span className="text-[10px]">Quitar</span>
                              </button>
                            )}
                          </div>

                          {/* Team Selection Grid */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {/* Team A Slot */}
                            <div className="p-3 bg-slate-900/90 rounded-xl border border-slate-800/80 space-y-2">
                              <label className="block text-[10px] font-black text-slate-400 uppercase tracking-wider">
                                Posición / Equipo Local (A)
                              </label>
                              <select
                                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-xs focus:border-emerald-500 focus:outline-none"
                                value={rule.sourceA}
                                onChange={(e) => {
                                  const newSourceA = e.target.value;
                                  setBracketBuilderRules(prev =>
                                    prev.map((r, i) => {
                                      if (i !== idx) return r;
                                      const labelA = availableSources.find(s => s.value === newSourceA)?.label || newSourceA;
                                      const labelB = availableSources.find(s => s.value === r.sourceB)?.label || r.sourceB;
                                      return {
                                        ...r,
                                        sourceA: newSourceA,
                                        customLabel: `${labelA} VS ${labelB}`
                                      };
                                    })
                                  );
                                }}
                              >
                                {Object.entries(groupedSources).map(([grp, items]) => (
                                  <optgroup key={grp} label={grp} className="bg-slate-900 text-slate-300 font-bold">
                                    {items.map(item => (
                                      <option key={item.value} value={item.value} className="text-white">
                                        {item.label}
                                      </option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>

                              {/* Dynamic Resolved Badge Preview */}
                              <div className="flex items-center gap-2 pt-1 bg-slate-950/60 p-2 rounded-lg border border-slate-850">
                                {resA.team ? renderTeamBadge(resA.team, 'w-6 h-6') : (
                                  <div className="w-6 h-6 rounded-full border border-dashed border-slate-700 bg-slate-950 flex items-center justify-center flex-shrink-0">
                                    <span className="text-[8px] font-bold text-slate-500">?</span>
                                  </div>
                                )}
                                <div className="min-w-0 flex-1">
                                  <span className={`text-xs font-bold block truncate ${resA.team ? 'text-white' : 'text-slate-400'}`}>
                                    {resA.team ? resA.team.name : resA.label}
                                  </span>
                                  {resA.stats && (
                                    <span className="text-[9px] text-emerald-400 block font-medium">
                                      {resA.stats}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Team B Slot */}
                            <div className="p-3 bg-slate-900/90 rounded-xl border border-slate-800/80 space-y-2">
                              <label className="block text-[10px] font-black text-slate-400 uppercase tracking-wider">
                                Posición / Equipo Visitante (B)
                              </label>
                              <select
                                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-xs focus:border-emerald-500 focus:outline-none"
                                value={rule.sourceB}
                                onChange={(e) => {
                                  const newSourceB = e.target.value;
                                  setBracketBuilderRules(prev =>
                                    prev.map((r, i) => {
                                      if (i !== idx) return r;
                                      const labelA = availableSources.find(s => s.value === r.sourceA)?.label || r.sourceA;
                                      const labelB = availableSources.find(s => s.value === newSourceB)?.label || newSourceB;
                                      return {
                                        ...r,
                                        sourceB: newSourceB,
                                        customLabel: `${labelA} VS ${labelB}`
                                      };
                                    })
                                  );
                                }}
                              >
                                {Object.entries(groupedSources).map(([grp, items]) => (
                                  <optgroup key={grp} label={grp} className="bg-slate-900 text-slate-300 font-bold">
                                    {items.map(item => (
                                      <option key={item.value} value={item.value} className="text-white">
                                        {item.label}
                                      </option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>

                              {/* Dynamic Resolved Badge Preview */}
                              <div className="flex items-center gap-2 pt-1 bg-slate-950/60 p-2 rounded-lg border border-slate-850">
                                {resB.team ? renderTeamBadge(resB.team, 'w-6 h-6') : (
                                  <div className="w-6 h-6 rounded-full border border-dashed border-slate-700 bg-slate-950 flex items-center justify-center flex-shrink-0">
                                    <span className="text-[8px] font-bold text-slate-500">?</span>
                                  </div>
                                )}
                                <div className="min-w-0 flex-1">
                                  <span className={`text-xs font-bold block truncate ${resB.team ? 'text-white' : 'text-slate-400'}`}>
                                    {resB.team ? resB.team.name : resB.label}
                                  </span>
                                  {resB.stats && (
                                    <span className="text-[9px] text-emerald-400 block font-medium">
                                      {resB.stats}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>

              {/* Replace existing checkbox */}
              <div className="bg-slate-950/60 p-3.5 rounded-2xl border border-slate-800 flex items-center gap-3">
                <input
                  type="checkbox"
                  id="replaceExisting"
                  checked={bracketBuilderReplaceExisting}
                  onChange={(e) => setBracketBuilderReplaceExisting(e.target.checked)}
                  className="w-4 h-4 rounded text-emerald-600 bg-slate-900 border-slate-700 focus:ring-emerald-500"
                />
                <label htmlFor="replaceExisting" className="text-xs text-slate-300 cursor-pointer font-medium">
                  Reemplazar llaves existentes en la fase <strong className="text-white">"{bracketBuilderPhaseName}"</strong> si ya existen
                </label>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 sm:p-5 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between gap-3 flex-shrink-0">
              <button
                type="button"
                onClick={() => setShowBracketBuilderModal(false)}
                className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-xl transition cursor-pointer"
              >
                Cancelar
              </button>

              <button
                type="button"
                onClick={handleSaveCustomBracketMatches}
                className="px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-green-500 hover:from-emerald-500 hover:to-green-400 text-white text-xs font-black rounded-xl transition cursor-pointer shadow-lg shadow-emerald-950 flex items-center gap-2"
              >
                <Trophy className="w-4 h-4" />
                <span>🏆 Generar y Guardar Llaves ({bracketBuilderRules.length})</span>
              </button>
            </div>
          </div>
        </div>
      )}
      {showAddManualLlaveModal && currentTour && (
        <div className="fixed inset-0 z-[110] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 relative overflow-hidden shadow-2xl">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 via-green-400 to-emerald-600" />
            
            <h3 className="text-lg font-extrabold text-white mb-1">Agregar Llave / Enfrentamiento</h3>
            <p className="text-xs text-slate-400 mb-4">
              Crea un cruce eliminatorio en la fase de este torneo.
            </p>

            <form onSubmit={handleCreateManualLlave} className="space-y-4">
              {/* Phase / Title */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Fase / Título de la Llave *</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: Segunda Fase, Octavos de Final..."
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none mb-2"
                  value={manualLlaveState.phaseName}
                  onChange={(e) => setManualLlaveState(prev => ({ ...prev, phaseName: e.target.value }))}
                />
                
                {/* Visual quick pills */}
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {['Segunda Fase', 'Octavos', 'Cuartos', 'Semis', 'Final'].map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setManualLlaveState(prev => ({ ...prev, phaseName: p }))}
                      className={`px-2.5 py-1 text-[10px] font-bold rounded-md border transition cursor-pointer ${
                        manualLlaveState.phaseName === p 
                          ? 'bg-emerald-600 text-white border-emerald-500' 
                          : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              {/* Team A Selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Equipo Local (A) *</label>
                <select
                  required
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none focus:border-emerald-500"
                  value={manualLlaveState.teamAId}
                  onChange={(e) => setManualLlaveState(prev => ({ ...prev, teamAId: e.target.value }))}
                >
                  <option value="">-- Seleccionar Equipo --</option>
                  {(() => {
                    const tourTeams = currentTour.teams || [];
                    let available = tourTeams
                      .map(tt => teams.find(t => t.id === tt.teamId))
                      .filter((t): t is Team => Boolean(t));

                    if (available.length === 0) {
                      available = teams;
                    }

                    return available.map(team => (
                      <option key={team.id} value={team.id}>{team.name}</option>
                    ));
                  })()}
                </select>
              </div>

              {/* Team B Selection */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1.5">Equipo Visitante (B) *</label>
                <select
                  required
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-200 text-sm focus:outline-none focus:border-emerald-500"
                  value={manualLlaveState.teamBId}
                  onChange={(e) => setManualLlaveState(prev => ({ ...prev, teamBId: e.target.value }))}
                >
                  <option value="">-- Seleccionar Equipo --</option>
                  {(() => {
                    const tourTeams = currentTour.teams || [];
                    let available = tourTeams
                      .map(tt => teams.find(t => t.id === tt.teamId))
                      .filter((t): t is Team => Boolean(t));

                    if (available.length === 0) {
                      available = teams;
                    }

                    return available
                      .filter(t => t.id !== manualLlaveState.teamAId)
                      .map(team => (
                        <option key={team.id} value={team.id}>{team.name}</option>
                      ));
                  })()}
                </select>
              </div>

              {/* Goles/Marcador optional editor */}
              <div className="bg-slate-950/50 p-3 rounded-2xl border border-slate-800/80">
                <span className="block text-[10px] font-bold text-slate-400 mb-2 uppercase tracking-wide">Marcador (Opcional)</span>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 mb-1">Goles Local (A)</label>
                    <input
                      type="number"
                      min="0"
                      placeholder="-"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                      value={manualLlaveState.scoreA}
                      onChange={(e) => setManualLlaveState(prev => ({ ...prev, scoreA: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 mb-1">Goles Visitante (B)</label>
                    <input
                      type="number"
                      min="0"
                      placeholder="-"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-850 rounded-xl focus:border-emerald-500 text-slate-200 text-sm focus:outline-none"
                      value={manualLlaveState.scoreB}
                      onChange={(e) => setManualLlaveState(prev => ({ ...prev, scoreB: e.target.value }))}
                    />
                  </div>
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddManualLlaveModal(false)}
                  className="flex-1 py-2 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl transition cursor-pointer"
                >
                  Crear Llave
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: PWA INSTALL INSTRUCTIONS --- */}
      {showInstallModal && (
        <div className="fixed inset-0 z-[120] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-sm p-6 relative overflow-hidden shadow-2xl">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 via-green-400 to-emerald-600" />
            
            <div className="flex justify-center mb-4">
              <div className="w-14 h-14 bg-slate-950 border border-slate-800 rounded-2xl flex items-center justify-center shadow shadow-emerald-900">
                <span className="text-xl font-black tracking-tighter">
                  <span className="text-white">P</span>
                  <span className="text-emerald-400">G</span>
                </span>
              </div>
            </div>

            <h3 className="text-lg font-extrabold text-white text-center mb-1">Crear Acceso Directo</h3>
            <p className="text-xs text-slate-400 text-center mb-5 leading-relaxed">
              Ten PlayGol en tu pantalla de inicio tal como una app nativa, abriendo directamente en la pantalla de acceso.
            </p>

            <div className="space-y-4 bg-slate-950/50 p-4 rounded-2xl border border-slate-850/60 mb-5">
              {deviceOS === 'ios' ? (
                <div className="space-y-3">
                  <span className="block text-[10px] font-black text-amber-400 uppercase tracking-wider">Instrucciones para iPhone / iPad:</span>
                  <ol className="list-decimal list-inside text-xs text-slate-300 space-y-2">
                    <li>Presiona el botón de <strong className="text-white">Compartir</strong> <span className="inline-block p-1 bg-slate-800 rounded mx-0.5 text-[10px]">↑</span> en Safari.</li>
                    <li>Desplázate hacia abajo y elige <strong className="text-white">"Agregar a inicio"</strong>.</li>
                    <li>¡Listo! PlayGol se creará en tu pantalla principal.</li>
                  </ol>
                </div>
              ) : (
                <div className="space-y-3">
                  <span className="block text-[10px] font-black text-emerald-400 uppercase tracking-wider">Instrucciones para Android / Chrome:</span>
                  <ol className="list-decimal list-inside text-xs text-slate-300 space-y-2">
                    <li>Presiona el botón <strong className="text-white">Menú (tres puntos)</strong> arriba a la derecha de Chrome.</li>
                    <li>Selecciona <strong className="text-white">"Instalar aplicación"</strong> o <strong className="text-white">"Agregar a la pantalla principal"</strong>.</li>
                    <li>Confirma la instalación y se añadirá el ícono de PlayGol.</li>
                  </ol>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => {
                  requestNotificationPermission();
                  handleInstallPWA();
                }}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black rounded-xl transition cursor-pointer shadow-lg shadow-emerald-950 flex items-center justify-center gap-2"
              >
                <Smartphone className="w-4 h-4" />
                <span>Crear ícono en pantalla</span>
              </button>
              <button
                type="button"
                onClick={() => setShowInstallModal(false)}
                className="w-full py-2.5 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-bold rounded-xl transition cursor-pointer"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- FLOATING CLOUD TOAST NOTIFICATION (FLOTANTE EN FORMA DE NUBE) --- */}
      {activeCloudNotif && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[300] w-[92%] max-w-md animate-in fade-in slide-in-from-top-5 duration-300">
          <div className="bg-slate-900/95 border-2 border-emerald-500/60 rounded-[28px] p-4 shadow-[0_12px_40px_rgba(16,185,129,0.35)] backdrop-blur-md relative overflow-hidden flex items-start gap-3.5">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-green-500/10 border border-emerald-500/40 flex items-center justify-center text-emerald-400 flex-shrink-0 mt-0.5 shadow-inner">
              <Bell className="w-5 h-5 animate-bounce" />
            </div>
            <div className="flex-1 pr-5">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[10px] font-black uppercase tracking-wider text-emerald-400 bg-emerald-950/80 px-2.5 py-0.5 rounded-full border border-emerald-800/60 flex items-center gap-1">
                  <span>☁️</span> Notificación Nube
                </span>
                <span className="text-[9px] text-slate-400">Ahora mismo</span>
              </div>
              <p className="text-xs font-bold text-slate-100 leading-relaxed">{activeCloudNotif.text}</p>
            </div>
            <button
              onClick={() => setActiveCloudNotif(null)}
              className="absolute top-2.5 right-2.5 w-7 h-7 rounded-full bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center text-xs transition cursor-pointer"
            >
              ✕
            </button>
          </div>
        </div>
      )}

    </div>
  );

  // --- SUBCOMPONENTS: STANDINGS TABLE RENDERER ---
  function renderStandingsTable(tournamentId: string, groupFilter?: string) {
    const rows = calculateStandings(tournamentId, groupFilter);

    if (rows.length === 0) {
      return (
        <div className="text-center py-6">
          <p className="text-xs text-slate-500">No hay información de posiciones todavía.</p>
        </div>
      );
    }

    return (
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-850 text-slate-400 font-semibold">
              <th className="py-2.5 px-2 text-center w-8">#</th>
              <th className="py-2.5 px-2">Equipo</th>
              <th className="py-2.5 px-2 text-center w-10">PJ</th>
              <th className="py-2.5 px-2 text-center w-8">PG</th>
              <th className="py-2.5 px-2 text-center w-8">PE</th>
              <th className="py-2.5 px-2 text-center w-8">PP</th>
              <th className="py-2.5 px-2 text-center w-12 hidden sm:table-cell">GF:GC</th>
              <th className="py-2.5 px-2 text-center w-10">DG</th>
              <th className="py-2.5 px-2 text-center w-12 font-bold text-emerald-400">PTS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const team = teams.find(t => t.id === r.teamId);
              if (!team) return null;
              return (
                <tr key={r.teamId} className="border-b border-slate-850/50 hover:bg-slate-800/20 transition">
                  <td className="py-2.5 px-2 text-center font-bold text-slate-400">
                    {idx + 1}
                  </td>
                  <td className="py-2.5 px-2 font-bold text-white flex items-center gap-2">
                    {renderTeamBadge(team, 'w-6 h-6')}
                    <span className="truncate max-w-[120px] sm:max-w-none">{team.name}</span>
                  </td>
                  <td className="py-2.5 px-2 text-center font-medium text-slate-300">{r.played}</td>
                  <td className="py-2.5 px-2 text-center text-slate-400">{r.won}</td>
                  <td className="py-2.5 px-2 text-center text-slate-400">{r.drawn}</td>
                  <td className="py-2.5 px-2 text-center text-slate-400">{r.lost}</td>
                  <td className="py-2.5 px-2 text-center text-slate-500 hidden sm:table-cell">{r.goalsFor}:{r.goalsAgainst}</td>
                  <td className={`py-2.5 px-2 text-center font-bold ${r.goalDifference > 0 ? 'text-green-400' : r.goalDifference < 0 ? 'text-red-400' : 'text-slate-400'}`}>
                    {r.goalDifference > 0 ? `+${r.goalDifference}` : r.goalDifference}
                  </td>
                  <td className="py-2.5 px-2 text-center font-black text-emerald-400 text-sm">{r.points}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  // --- SUBCOMPONENTS: FIXTURE MATCH LIST RENDERER ---
  function renderMatchList(tour: Tournament) {
    const tourMatches = matches.filter(m => m.tournamentId === tour.id && m.isLlave !== true && m.round !== 'LLAVES');

    if (tourMatches.length === 0) {
      return (
        <div className="text-center py-10 border border-dashed border-slate-800 rounded-xl">
          <p className="text-sm text-slate-400">No hay partidos creados en el fixture.</p>
          {role === 'admin' && (
            tour.type === 'ELIMINACION_DIRECTA' ? (
              <button
                onClick={() => {
                  setNewMatchState({
                    teamAId: '',
                    teamBId: '',
                    round: 'Fecha 1',
                    scoreA: '',
                    scoreB: '',
                    played: false,
                    group: 'A',
                    freeTeamId: '',
                    time: '',
                    venue: ''
                  });
                  setShowManualMatchModal(true);
                }}
                className="mt-4 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-4 py-2 rounded-xl transition inline-flex items-center gap-1.5 mx-auto"
              >
                <Plus className="w-3.5 h-3.5" /> Crear Partido
              </button>
            ) : (
              <button
                onClick={() => handleGenerateFixture(tour)}
                className="mt-4 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-4 py-2 rounded-xl transition"
              >
                Generar Fixture Automático
              </button>
            )
          )}
        </div>
      );
    }

    // Group matches by Round Name for elegant nested layout
    const groupedMatches: Record<string, Match[]> = {};
    tourMatches.forEach(m => {
      if (!groupedMatches[m.round]) {
        groupedMatches[m.round] = [];
      }
      groupedMatches[m.round].push(m);
    });

    return (
      <div className="space-y-6">
        {Object.entries(groupedMatches).map(([roundName, roundList]) => (
          <div key={roundName} className="space-y-2.5">
            <h4 className="text-xs font-bold uppercase text-slate-400 bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-850 inline-block">
              {roundName}
            </h4>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {roundList.map(match => {
                const teamA = teams.find(t => t.id === match.teamAId);
                const teamB = teams.find(t => t.id === match.teamBId);
                return (
                  <div 
                    key={match.id}
                    onClick={() => handleOpenScoreModal(match)}
                    className={`bg-slate-950 rounded-2xl border border-slate-850 overflow-hidden flex flex-col transition ${
                      canEditCurrentTour ? 'hover:border-emerald-500/50 cursor-pointer' : ''
                    }`}
                  >
                    {/* Header Bar for Match Meta details (Time, Venue, Group) */}
                    {(match.time || match.venue || (tour.type === 'GRUPOS' && match.group)) && (
                      <div className="flex items-center justify-between gap-2 px-3.5 py-1.5 bg-slate-900/90 border-b border-slate-850/80 text-[10px] font-extrabold">
                        <div className="flex items-center gap-2 overflow-hidden min-w-0">
                          {match.time && (
                            <span className="flex items-center gap-1 text-sky-400 font-extrabold flex-shrink-0 bg-sky-950/60 border border-sky-900/40 px-2 py-0.5 rounded-md">
                              <Clock className="w-3 h-3" /> {match.time}
                            </span>
                          )}
                          {match.venue && (
                            <span className="flex items-center gap-1 text-amber-400 font-extrabold truncate bg-amber-950/60 border border-amber-900/40 px-2 py-0.5 rounded-md" title={match.venue}>
                              <MapPin className="w-3 h-3 flex-shrink-0" /> {match.venue}
                            </span>
                          )}
                        </div>
                        {tour.type === 'GRUPOS' && match.group && (
                          <span className="text-[9px] font-black text-emerald-400 bg-emerald-950/80 border border-emerald-900/50 px-2 py-0.5 rounded-md uppercase tracking-wider flex-shrink-0">
                            Grupo {match.group}
                          </span>
                        )}
                      </div>
                    )}

                    {/* MAIN MATCH TEAMS & SCORE ROW */}
                    <div className="p-3.5 flex items-center justify-between gap-2">
                      {/* Team A details */}
                      <div className="flex items-center gap-2.5 flex-1 min-w-0">
                        {teamA ? renderTeamBadge(teamA, 'w-8 h-8 md:w-9 md:h-9') : <div className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-slate-800 flex-shrink-0" />}
                        <span className={`text-xs md:text-sm font-black truncate ${match.played && (match.scoreA ?? 0) > (match.scoreB ?? 0) ? 'text-white' : 'text-slate-200'}`}>
                          {teamA ? teamA.name : 'TBD'}
                        </span>
                      </div>

                      {/* SCORE BOARD CONTAINER */}
                      <div className="px-3.5 py-1.5 bg-slate-900 rounded-xl border border-slate-800 text-center flex items-center gap-2 flex-shrink-0 shadow-inner">
                        {match.played ? (
                          <>
                            <span className="text-base font-black text-white">{match.scoreA}</span>
                            <span className="text-xs font-bold text-slate-500">-</span>
                            <span className="text-base font-black text-white">{match.scoreB}</span>
                          </>
                        ) : (
                          <span className="text-xs font-black text-emerald-400 tracking-wider">VS</span>
                        )}
                      </div>

                      {/* Team B details */}
                      <div className="flex items-center gap-2.5 flex-1 justify-end min-w-0 text-right">
                        <span className={`text-xs md:text-sm font-black truncate ${match.played && (match.scoreB ?? 0) > (match.scoreA ?? 0) ? 'text-white' : 'text-slate-200'}`}>
                          {teamB ? teamB.name : 'TBD'}
                        </span>
                        {teamB ? renderTeamBadge(teamB, 'w-8 h-8 md:w-9 md:h-9') : <div className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-slate-800 flex-shrink-0" />}
                      </div>

                      {/* Admin Action Buttons */}
                      {canEditCurrentTour && (
                        <div className="flex items-center ml-1 border-l border-slate-850 pl-1.5 gap-1 flex-shrink-0">
                          {/* Edit Match Details Button */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenEditMatchDetails(match);
                            }}
                            className="text-slate-400 hover:text-emerald-400 p-1.5 rounded-lg hover:bg-slate-900 transition"
                            title="Editar Partido"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>

                          {/* Delete Match Button */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteMatch(match.id);
                            }}
                            className="text-slate-400 hover:text-red-400 p-1.5 rounded-lg hover:bg-slate-900 transition"
                            title="Eliminar Partido"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Separate Box for Free Teams (Equipo Libre) */}
            {(() => {
              const freeTeamsInRound = roundList.filter(m => m.freeTeamId);
              if (freeTeamsInRound.length === 0) return null;
              
              // We extract the unique freeTeamIds so we don't duplicate them in the display
              const uniqueFreeTeams = Array.from(new Set(freeTeamsInRound.map(m => JSON.stringify({ id: m.freeTeamId, group: m.group, matchId: m.id }))));
              
              return (
                <div className="p-4 bg-slate-900/40 border border-slate-800/60 rounded-2xl space-y-2 mt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <span className="text-[10px] font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                      <Shield className="w-3.5 h-3.5 text-amber-500" /> EQUIPO LIBRE / DESCANSA ESTA FECHA
                    </span>
                    <p className="text-[10px] text-slate-400 mt-0.5">Este equipo no tiene programado partido para la presente jornada.</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {uniqueFreeTeams.map(itemStr => {
                      const item = JSON.parse(itemStr);
                      const fTeam = teams.find(t => t.id === item.id);
                      if (!fTeam) return null;
                      return (
                        <div key={item.matchId} className="flex items-center gap-2 bg-slate-950 border border-slate-850 px-3.5 py-1.5 rounded-xl text-xs shadow-sm">
                          {renderTeamBadge(fTeam, 'w-5 h-5')}
                          <span className="font-extrabold text-white">{fTeam.name}</span>
                          {tour.type === 'GRUPOS' && item.group && (
                            <span className="text-[9px] font-extrabold text-emerald-400 bg-emerald-950/40 border border-emerald-900/30 px-1.5 py-0.5 rounded uppercase tracking-wider">
                              Grupo {item.group}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

          </div>
        ))}
      </div>
    );
  }

  // --- SUBCOMPONENTS: GRAPHICAL BRACKET TREE FOR ELIMINACION DIRECTA ---
  function renderBracketTree(tour: Tournament) {
    const tourMatches = matches.filter(m => m.tournamentId === tour.id);

    // Group slots by round
    const octavos = tourMatches.filter(m => m.round === 'Octavos').sort((a, b) => (a.bracketSlot ?? 0) - (b.bracketSlot ?? 0));
    const cuartos = tourMatches.filter(m => m.round === 'Cuartos').sort((a, b) => (a.bracketSlot ?? 0) - (b.bracketSlot ?? 0));
    const semis = tourMatches.filter(m => m.round === 'Semifinal').sort((a, b) => (a.bracketSlot ?? 0) - (b.bracketSlot ?? 0));
    const final = tourMatches.filter(m => m.round === 'Final').sort((a, b) => (a.bracketSlot ?? 0) - (b.bracketSlot ?? 0));

    if (tourMatches.length === 0) {
      return (
        <div className="text-center py-10 w-full">
          <p className="text-sm text-slate-400">No se ha generado el árbol de eliminación aún.</p>
          {canEditCurrentTour && (
            <button
              onClick={() => handleGenerateFixture(tour)}
              className="mt-3 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-4 py-2 rounded-xl transition"
            >
              Generar Árbol de Eliminación
            </button>
          )}
        </div>
      );
    }

    const renderBracketMatchCard = (m: Match) => {
      const tA = teams.find(t => t.id === m.teamAId);
      const tB = teams.find(t => t.id === m.teamBId);
      return (
        <div 
          key={m.id}
          onClick={() => handleOpenScoreModal(m)}
          className={`w-44 p-2.5 bg-slate-950 border rounded-xl flex flex-col gap-1.5 transition ${
            m.played ? 'border-slate-800' : 'border-slate-850'
          } ${canEditCurrentTour ? 'hover:border-emerald-500 cursor-pointer' : ''}`}
        >
          {/* Team A line */}
          <div className="flex items-center justify-between gap-1 overflow-hidden">
            <div className="flex items-center gap-1.5 overflow-hidden">
              {tA ? renderTeamBadge(tA, 'w-5 h-5') : <div className="w-5 h-5 rounded-full bg-slate-900 border border-slate-800" />}
              <span className={`text-[10px] font-bold truncate ${m.played && (m.scoreA ?? 0) > (m.scoreB ?? 0) ? 'text-emerald-400' : 'text-slate-400'}`}>
                {tA ? tA.name : 'TBD'}
              </span>
            </div>
            <span className="text-[10px] font-black text-white px-1">
              {m.played ? m.scoreA : '-'}
            </span>
          </div>

          {/* Team B line */}
          <div className="flex items-center justify-between gap-1 overflow-hidden">
            <div className="flex items-center gap-1.5 overflow-hidden">
              {tB ? renderTeamBadge(tB, 'w-5 h-5') : <div className="w-5 h-5 rounded-full bg-slate-900 border border-slate-800" />}
              <span className={`text-[10px] font-bold truncate ${m.played && (m.scoreB ?? 0) > (m.scoreA ?? 0) ? 'text-emerald-400' : 'text-slate-400'}`}>
                {tB ? tB.name : 'TBD'}
              </span>
            </div>
            <span className="text-[10px] font-black text-white px-1">
              {m.played ? m.scoreB : '-'}
            </span>
          </div>

          {/* Optional time/venue details */}
          {(m.time || m.venue) && (
            <div className="flex items-center justify-between gap-1 mt-1 border-t border-slate-900 pt-1 text-[8px] font-bold text-slate-500 uppercase tracking-wider">
              {m.time && (
                <span className="flex items-center gap-0.5 text-sky-400">
                  <Clock className="w-2 h-2" /> {m.time}
                </span>
              )}
              {m.venue && (
                <span className="flex items-center gap-0.5 text-amber-400 truncate max-w-[80px]" title={m.venue}>
                  <MapPin className="w-2 h-2" /> {m.venue}
                </span>
              )}
            </div>
          )}
        </div>
      );
    };

    return (
      <>
        {/* Render columns conditionally if matches are present in that round */}
        {octavos.length > 0 && (
          <div className="flex flex-col justify-around gap-4">
            <h5 className="text-[10px] font-bold text-center text-slate-500 uppercase tracking-widest border-b border-slate-850 pb-1 mb-2">Octavos</h5>
            {octavos.map(renderBracketMatchCard)}
          </div>
        )}
        
        {cuartos.length > 0 && (
          <div className="flex flex-col justify-around gap-4">
            <h5 className="text-[10px] font-bold text-center text-slate-500 uppercase tracking-widest border-b border-slate-850 pb-1 mb-2">Cuartos</h5>
            {cuartos.map(renderBracketMatchCard)}
          </div>
        )}

        {semis.length > 0 && (
          <div className="flex flex-col justify-around gap-4">
            <h5 className="text-[10px] font-bold text-center text-slate-500 uppercase tracking-widest border-b border-slate-850 pb-1 mb-2">Semifinal</h5>
            {semis.map(renderBracketMatchCard)}
          </div>
        )}

        {final.length > 0 && (
          <div className="flex flex-col justify-around gap-4">
            <h5 className="text-[10px] font-bold text-center text-slate-500 uppercase tracking-widest border-b border-slate-850 pb-1 mb-2">Gran Final</h5>
            {final.map(renderBracketMatchCard)}
          </div>
        )}
      </>
    );
  }
}
