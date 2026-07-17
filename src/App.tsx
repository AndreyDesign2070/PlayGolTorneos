/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Trophy, Shield, Calendar, Plus, Trash2, Edit2, Share2, Lock, LogOut, 
  Download, Upload, Info, Users, Check, ArrowRight, Sparkles, RefreshCw, Smartphone,
  Star, Crown, Zap, Eye, EyeOff
} from 'lucide-react';

import { auth, db } from './lib/firebase';
import { 
  onSnapshot, collection, getDocs, doc, setDoc, deleteDoc, writeBatch 
} from 'firebase/firestore';
import { 
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut 
} from 'firebase/auth';

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

export default function App() {
  // --- STATE ---
  const [role, setRole] = useState<'admin' | 'visitor' | null>(() => {
    return (sessionStorage.getItem('playgol_role') as any) || null;
  });
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const [teams, setTeams] = useState<Team[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);

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
    group: 'A'
  });

  // Manual Match creation modal
  const [showManualMatchModal, setShowManualMatchModal] = useState(false);

  // Bracket pairing modal states
  const [showBracketPairingModal, setShowBracketPairingModal] = useState(false);
  const [bracketPairingTour, setBracketPairingTour] = useState<Tournament | null>(null);
  const [bracketPairings, setBracketPairings] = useState<{ teamAId: string; teamBId: string }[]>([]);
  const [bracketRoundName, setBracketRoundName] = useState('');

  // Match Editor Modal
  const [editingMatch, setEditingMatch] = useState<Match | null>(null);
  const [editScoreA, setEditScoreA] = useState<string>('');
  const [editScoreB, setEditScoreB] = useState<string>('');

  // Match Details Editor Modal
  const [editingMatchDetails, setEditingMatchDetails] = useState<Match | null>(null);
  const [matchDetailsState, setMatchDetailsState] = useState({
    round: '',
    teamAId: '',
    teamBId: '',
    group: 'A',
    scoreA: '',
    scoreB: '',
    overrideTeams: false
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

  // Share message status
  const [copyStatus, setCopyStatus] = useState(false);
  const [importString, setImportString] = useState('');
  const [importStatus, setImportStatus] = useState<{ success?: boolean; msg?: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const editTeamFileInputRef = useRef<HTMLInputElement>(null);
  const tourFileInputRef = useRef<HTMLInputElement>(null);
  const editTourFileInputRef = useRef<HTMLInputElement>(null);

  // --- INITIAL SEED DATA & SYNC ENGINE & AUTH SYSTEM ---
  useEffect(() => {
    // 1. Listen to Auth State changes in Firebase Auth (optional background sync)
    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      if (user) {
        if (user.email === 'admin@playgol.com') {
          setRole('admin');
          sessionStorage.setItem('playgol_role', 'admin');
        } else if (user.email === 'visitor@playgol.com') {
          setRole('visitor');
          sessionStorage.setItem('playgol_role', 'visitor');
        }
      }
    });

    // 2. Load and Sync collections from Firestore
    let unsubTeams: () => void = () => {};
    let unsubTournaments: () => void = () => {};
    let unsubMatches: () => void = () => {};

    let isSeeding = false;
    const seedFirestoreIfNeeded = async () => {
      if (isSeeding) return;
      isSeeding = true;
      try {
        console.log("Firestore tournaments collection is empty. Starting seeding process...");
        let seedTeamsData: Team[] = [];
        let seedTournamentsData: Tournament[] = [];
        let seedMatchesData: Match[] = [];

        // Try fetching existing data from Express data.json to avoid losing the user's custom matchups!
        try {
          const apiRes = await fetch('/api/state');
          if (apiRes.ok) {
            const apiData = await apiRes.json();
            if (apiData && Array.isArray(apiData.teams) && apiData.teams.length > 0) {
              seedTeamsData = apiData.teams;
              seedTournamentsData = apiData.tournaments;
              seedMatchesData = apiData.matches;
            }
          }
        } catch (e) {
          console.error("Error fetching state from Express server to seed:", e);
        }

        // Fallback to hardcoded seed if the server didn't have data
        if (seedTeamsData.length === 0) {
          seedTeamsData = [
            { id: 't1', name: 'Alianza FC', primaryColor: '#1d4ed8', secondaryColor: '#ffffff', badgeSymbol: 'shield' },
            { id: 't2', name: 'Deportivo Oro', primaryColor: '#eab308', secondaryColor: '#1e293b', badgeSymbol: 'crown' },
            { id: 't3', name: 'Real Volcán', primaryColor: '#dc2626', secondaryColor: '#000000', badgeSymbol: 'flame' },
            { id: 't4', name: 'Verde United', primaryColor: '#059669', secondaryColor: '#ffffff', badgeSymbol: 'ball' },
            { id: 't5', name: 'Estrella FC', primaryColor: '#8b5cf6', secondaryColor: '#fef08a', badgeSymbol: 'star' },
            { id: 't6', name: 'Relámpago FC', primaryColor: '#0ea5e9', secondaryColor: '#172554', badgeSymbol: 'zap' }
          ];

          seedTournamentsData = [
            {
              id: 'tour1',
              name: 'Superliga PlayGol',
              type: 'LIGA',
              teams: seedTeamsData.map(t => ({ teamId: t.id }))
            }
          ];

          const generated = generateRoundRobinMatches('tour1', seedTeamsData.map(t => t.id));
          generated.forEach((m, idx) => {
            if (idx < 5) {
              m.scoreA = Math.floor(Math.random() * 4);
              m.scoreB = Math.floor(Math.random() * 4);
              m.played = true;
            }
            seedMatchesData.push(m);
          });
        }

        // Perform batch write to populate Firestore collections
        const batch = writeBatch(db);
        seedTeamsData.forEach(t => {
          batch.set(doc(db, "teams", t.id), t);
        });
        seedTournamentsData.forEach(t => {
          batch.set(doc(db, "tournaments", t.id), t);
        });
        seedMatchesData.forEach(m => {
          const mDoc = { ...m };
          if (mDoc.group === undefined) delete mDoc.group;
          if (mDoc.bracketSlot === undefined) delete mDoc.bracketSlot;
          if ((mDoc as any).overrideTeams === undefined) delete (mDoc as any).overrideTeams;
          batch.set(doc(db, "matches", m.id), mDoc);
        });

        await batch.commit();
        console.log("Firestore collections seeded successfully!");
      } catch (err) {
        console.error("Error in seedFirestoreIfNeeded:", err);
      } finally {
        isSeeding = false;
      }
    };

    const setupFirebaseSync = () => {
      // 3. Subscribe to real-time changes in Firestore immediately & non-blockingly
      unsubTeams = onSnapshot(collection(db, "teams"), (snapshot) => {
        const list: Team[] = [];
        snapshot.forEach(d => {
          list.push(d.data() as Team);
        });
        setTeams(list);
        setIsLoading(false);
      }, (error) => {
        console.error("Error in teams Firestore subscription:", error);
        setIsLoading(false);
      });

      unsubTournaments = onSnapshot(collection(db, "tournaments"), (snapshot) => {
        const list: Tournament[] = [];
        snapshot.forEach(d => {
          list.push(d.data() as Tournament);
        });
        setTournaments(list);
        setIsLoading(false);

        if (snapshot.empty) {
          seedFirestoreIfNeeded();
        }
      }, (error) => {
        console.error("Error in tournaments Firestore subscription:", error);
        setIsLoading(false);
      });

      unsubMatches = onSnapshot(collection(db, "matches"), (snapshot) => {
        const list: Match[] = [];
        snapshot.forEach(d => {
          list.push(d.data() as Match);
        });
        setMatches(list);
        setIsLoading(false);
      }, (error) => {
        console.error("Error in matches Firestore subscription:", error);
        setIsLoading(false);
      });
    };

    setupFirebaseSync();

    return () => {
      unsubscribeAuth();
      unsubTeams();
      unsubTournaments();
      unsubMatches();
    };
  }, []);

  // --- SAVE PERSISTENCE ---
  const saveState = async (updatedTeams: Team[], updatedTournaments: Tournament[], updatedMatches: Match[]) => {
    // Recursively clean all collections for Firestore compatibility (removes undefined fields)
    const cleanTeams = cleanForFirestore(updatedTeams) as Team[];
    const cleanTournaments = cleanForFirestore(updatedTournaments) as Tournament[];
    const cleanMatches = cleanForFirestore(updatedMatches) as Match[];

    // Snappy UI state updates locally
    setTeams(cleanTeams);
    setTournaments(cleanTournaments);
    setMatches(cleanMatches);

    // LocalStorage fallback
    localStorage.setItem('playgol_teams', JSON.stringify(cleanTeams));
    localStorage.setItem('playgol_tournaments', JSON.stringify(cleanTournaments));
    localStorage.setItem('playgol_matches', JSON.stringify(cleanMatches));

    // Exclusive real-time update of Firestore and Express on authorized editor sides
    const isAuthorizedEditor = role === 'admin' || Object.values(unlockedTournaments).some(r => r === 'AdminTorneo');
    if (isAuthorizedEditor) {
      try {
        // Compare with current local states to perform targeted Firestore updates (diffing)
        
        // 1. Diff Teams
        for (const t of cleanTeams) {
          const existing = teams.find(x => x.id === t.id);
          if (!existing || JSON.stringify(existing) !== JSON.stringify(t)) {
            await setDoc(doc(db, 'teams', t.id), t);
          }
        }
        for (const t of teams) {
          if (!cleanTeams.some(x => x.id === t.id)) {
            await deleteDoc(doc(db, 'teams', t.id));
          }
        }

        // 2. Diff Tournaments
        for (const t of cleanTournaments) {
          const existing = tournaments.find(x => x.id === t.id);
          if (!existing || JSON.stringify(existing) !== JSON.stringify(t)) {
            await setDoc(doc(db, 'tournaments', t.id), t);
          }
        }
        for (const t of tournaments) {
          if (!cleanTournaments.some(x => x.id === t.id)) {
            await deleteDoc(doc(db, 'tournaments', t.id));
          }
        }

        // 3. Diff Matches
        for (const m of cleanMatches) {
          const existing = matches.find(x => x.id === m.id);
          if (!existing || JSON.stringify(existing) !== JSON.stringify(m)) {
            await setDoc(doc(db, 'matches', m.id), m);
          }
        }
        for (const m of matches) {
          if (!cleanMatches.some(x => x.id === m.id)) {
            await deleteDoc(doc(db, 'matches', m.id));
          }
        }
      } catch (err) {
        console.error("Error writing updates to Firebase Firestore:", err);
      }

      // Sync with Express backend to keep data.json always updated on the container
      try {
        await fetch('/api/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teams: cleanTeams, tournaments: cleanTournaments, matches: cleanMatches })
        });
      } catch (apiErr) {
        console.error("Error syncing state to Express server:", apiErr);
      }
    }
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

  // --- IMAGE UPLOAD HELPER (downscales to save localStorage size) ---
  const compressAndUploadImage = (file: File, callback: (base64: string) => void) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 150;
        const MAX_HEIGHT = 150;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const compressedBase64 = canvas.toDataURL('image/png', 0.85);
          callback(compressedBase64);
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

    const updated = tournaments.map(t => {
      if (t.id === editingTournament.id) {
        return {
          ...editingTournament,
          name: editingTournament.name.trim(),
          numGroups: editingTournament.type === 'GRUPOS' ? Number(editingTournament.numGroups || 2) : undefined,
          numTeams: (editingTournament.type === 'LIGA' || editingTournament.type === 'ELIMINACION_DIRECTA') ? Number(editingTournament.numTeams || 8) : undefined,
          faseFinalType: editingTournament.type === 'FASE_FINAL' ? editingTournament.faseFinalType : undefined,
        };
      }
      return t;
    });

    saveState(teams, updated, matches);
    setEditingTournament(null);
  };

  const handleEditTeam = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTeam || !editingTeam.name.trim()) return;

    const updated = teams.map(t => {
      if (t.id === editingTeam.id) {
        return {
          ...editingTeam,
          name: editingTeam.name.trim()
        };
      }
      return t;
    });

    saveState(updated, tournaments, matches);
    setEditingTeam(null);
  };

  // --- MANUAL MATCH CREATION ---
  const handleCreateManualMatch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTournamentId || !newMatchState.teamAId || !newMatchState.teamBId) {
      alert('Por favor selecciona ambos equipos.');
      return;
    }
    if (newMatchState.teamAId === newMatchState.teamBId) {
      alert('No puedes crear un partido con el mismo equipo.');
      return;
    }

    const created: Match = {
      id: `m-manual-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      tournamentId: selectedTournamentId,
      teamAId: newMatchState.teamAId,
      teamBId: newMatchState.teamBId,
      scoreA: null,
      scoreB: null,
      played: false,
      round: newMatchState.round.trim() || 'Fecha 1',
      group: currentTour?.type === 'GRUPOS' ? newMatchState.group : undefined
    };

    saveState(teams, tournaments, [...matches, created]);
    setShowManualMatchModal(false);
    // Reset state
    setNewMatchState({
      teamAId: '',
      teamBId: '',
      round: 'Fecha 1',
      scoreA: '',
      scoreB: '',
      played: false,
      group: 'A'
    });
  };

  const handleDeleteMatch = (matchId: string) => {
    if (role !== 'admin') return;
    showConfirm(
      '¿Eliminar Partido?',
      '¿Está seguro de querer eliminar este partido de la programación?',
      () => {
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
    if (role !== 'admin') return;
    
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

    saveState([...teams, created], tournaments, matches);
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

    saveState(teams, [...tournaments, created], matches);
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

    saveState(teams, tournaments, [...matches, created]);
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
    setShowAssignModal(false);
    setAssignTeamState({ teamId: '', group: 'A' });
  };

  const handleRemoveTeamFromTournament = (teamId: string) => {
    if (role !== 'admin' || !selectedTournamentId) return;
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
      overrideTeams: (match as any).overrideTeams || false
    });
  };

  const handleSaveMatchDetails = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMatchDetails) return;

    const sA = matchDetailsState.scoreA.trim() !== '' ? Number(matchDetailsState.scoreA) : null;
    const sB = matchDetailsState.scoreB.trim() !== '' ? Number(matchDetailsState.scoreB) : null;
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
            played: isPlayed,
            group: currentTour?.type === 'GRUPOS' ? matchDetailsState.group : undefined,
            overrideTeams: matchDetailsState.overrideTeams
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
        played: isPlayed,
        group: undefined,
        overrideTeams: matchDetailsState.overrideTeams
      } as any;
      updated = [...matches, newMatch];
    }

    saveState(teams, tournaments, updated);
    setEditingMatchDetails(null);
  };

  const handleOpenScoreModal = (match: Match) => {
    if (role !== 'admin') return;
    setEditingMatch(match);
    setEditScoreA(match.scoreA !== null ? String(match.scoreA) : '');
    setEditScoreB(match.scoreB !== null ? String(match.scoreB) : '');
  };

  const handleSaveScore = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMatch || role !== 'admin') return;

    const scoreA = editScoreA.trim() !== '' ? Number(editScoreA) : null;
    const scoreB = editScoreB.trim() !== '' ? Number(editScoreB) : null;
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
          played
        }
      ];
    }

    const tour = tournaments.find(t => t.id === editingMatch.tournamentId);

    // --- BRACKET AUTO-PROGRESSION LOGIC ---
    if (played && tour && (tour.type === 'ELIMINACION_DIRECTA' || tour.type === 'FASE_FINAL') && editingMatch.bracketSlot !== undefined) {
      const winnerId = scoreA! > scoreB! ? editingMatch.teamAId : editingMatch.teamBId;
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

    saveState(teams, tournaments, updatedMatches);
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
      '¿Está seguro de querer borrar todos los datos del torneo? Esta acción no se puede deshacer y reiniciará la aplicación.',
      () => {
        localStorage.removeItem('playgol_teams');
        localStorage.removeItem('playgol_tournaments');
        localStorage.removeItem('playgol_matches');
        window.location.reload();
      },
      'Borrar Todo',
      'Cancelar'
    );
  };

  // --- RENDER HEADING LOGO BADGE ---
  const renderTeamBadge = (team: Team, sizeClass = 'w-10 h-10') => {
    if (team.logoUrl) {
      return (
        <img 
          src={team.logoUrl} 
          alt={team.name} 
          className={`${sizeClass} rounded-full object-contain border border-slate-700 bg-slate-900 p-0.5`}
        />
      );
    }

    // Dynamic Symbol presets
    let symbolIcon = <Shield className="w-1/2 h-1/2 text-white" />;
    if (team.badgeSymbol === 'ball') symbolIcon = <span className="text-sm font-bold">⚽</span>;
    else if (team.badgeSymbol === 'star') symbolIcon = <Star className="w-1/2 h-1/2 text-white fill-white" />;
    else if (team.badgeSymbol === 'crown') symbolIcon = <Crown className="w-1/2 h-1/2 text-white" />;
    else if (team.badgeSymbol === 'trophy') symbolIcon = <Trophy className="w-1/2 h-1/2 text-white" />;
    else if (team.badgeSymbol === 'flame') symbolIcon = <span className="text-sm">🔥</span>;
    else if (team.badgeSymbol === 'zap') symbolIcon = <Zap className="w-1/2 h-1/2 text-white fill-white" />;

    return (
      <div 
        className={`${sizeClass} rounded-full flex items-center justify-center border-2 shadow-inner relative`}
        style={{ 
          backgroundColor: team.primaryColor, 
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
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                Ingresa con tu Contraseña
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
            {/* Role indicator badge */}
            <div className={`text-xs px-3 py-1.5 rounded-full font-bold flex items-center gap-1.5 border ${
              role === 'admin' 
                ? 'bg-emerald-950/50 text-emerald-400 border-emerald-900' 
                : 'bg-blue-950/50 text-blue-400 border-blue-900'
            }`}>
              <span className="w-2 h-2 rounded-full bg-current animate-pulse" />
              {role === 'admin' ? 'Administrador' : 'Visitante'}
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
                <div className="w-14 h-14 rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center text-3xl">
                  {currentTour.type === 'LIGA' ? '🏆' : currentTour.type === 'GRUPOS' ? '👥' : '⚔️'}
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
                Calendario de Partidos ({matches.filter(m => m.tournamentId === currentTour.id).length})
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
                  
                  {role === 'admin' && (
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
                            group: 'A'
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
                {currentTour.name === 'INTERLIGA CANTONAL PORTOVIEJO 2026' ? (
                  <>
                    <div className="bg-gradient-to-r from-emerald-950/40 via-slate-900/40 to-emerald-950/40 border border-emerald-900/30 p-5 rounded-3xl text-center">
                      <div className="flex items-center justify-center gap-2 mb-1.5">
                        <Trophy className="w-5 h-5 text-emerald-400" />
                        <h3 className="text-base font-extrabold text-white uppercase tracking-wider">
                          Emparejamientos de Llaves (Octavos de Final)
                        </h3>
                      </div>
                      <p className="text-xs text-slate-400 max-w-xl mx-auto leading-relaxed">
                        Las llaves se definen dinámicamente según el orden final de los grupos (A, B, C, D, E) y el mejor 4to lugar de todos los grupos. {role === 'admin' && 'Como administrador, puedes editar marcadores y sobrescribir cruces manualmente.'}
                      </p>
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
                              if (role === 'admin') {
                                handleOpenScoreModal(match);
                              }
                            }}
                            className={`p-4 bg-slate-900 rounded-2xl border ${
                              match.played ? 'border-emerald-500/30 bg-emerald-950/5' : 'border-slate-800'
                            } hover:border-emerald-500/50 transition relative overflow-hidden flex flex-col justify-between ${
                              role === 'admin' ? 'cursor-pointer' : ''
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
                                  <div className="flex items-center gap-2">
                                    <span className="text-base font-black text-white">{match.scoreA}</span>
                                    <span className="text-slate-600 font-bold text-xs">-</span>
                                    <span className="text-base font-black text-white">{match.scoreB}</span>
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

                            {role === 'admin' && (
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
                  </>
                ) : (
                  // Manual LLAVES configuration for other tournaments
                  <div className="space-y-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-bold text-white">Fases de Eliminación Directa</h3>
                        <p className="text-xs text-slate-400">Crea y gestiona las fases finales de forma personalizada.</p>
                      </div>
                      {canEditCurrentTour && (
                        <button
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
                          className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-1 transition shadow cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5" /> Agregar Llave / Partido
                        </button>
                      )}
                    </div>

                    {matches.filter(m => m.tournamentId === currentTour.id && m.isLlave === true).length === 0 ? (
                      <div className="bg-slate-900 border border-slate-800 p-8 rounded-2xl text-center">
                        <p className="text-slate-400 text-sm">Aún no se han configurado llaves manuales para este torneo.</p>
                        {canEditCurrentTour && (
                          <button
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
                            className="mt-4 bg-emerald-600 text-white text-xs font-bold px-4 py-2 rounded-xl transition cursor-pointer"
                          >
                            Crear Primera Llave
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-8">
                        {(Object.entries(
                          matches
                            .filter(m => m.tournamentId === currentTour.id && m.isLlave === true)
                            .reduce((acc, m) => {
                              if (!acc[m.round]) acc[m.round] = [];
                              acc[m.round].push(m);
                              return acc;
                            }, {} as Record<string, Match[]>)
                        ) as [string, Match[]][]).map(([phase, phaseMatches]) => (
                          <div key={phase} className="space-y-4">
                            <h4 className="text-sm font-extrabold text-emerald-400 uppercase tracking-wider border-b border-slate-800/80 pb-1.5 flex items-center gap-2">
                              🏆 {phase}
                            </h4>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              {phaseMatches.map(match => {
                                const teamA = teams.find(t => t.id === match.teamAId);
                                const teamB = teams.find(t => t.id === match.teamBId);

                                return (
                                  <div
                                    key={match.id}
                                    onClick={() => {
                                      if (canEditCurrentTour) {
                                        handleOpenEditMatchDetails(match);
                                      }
                                    }}
                                    className={`p-4 bg-slate-900 border rounded-2xl transition ${
                                      match.played ? 'border-emerald-500/30 bg-emerald-950/5' : 'border-slate-800'
                                    } ${canEditCurrentTour ? 'hover:border-emerald-500/50 cursor-pointer' : ''}`}
                                  >
                                    <div className="flex items-center justify-between">
                                      {/* Team A */}
                                      <div className="flex items-center gap-2.5 flex-1 min-w-0">
                                        {teamA ? renderTeamBadge(teamA, 'w-8 h-8') : (
                                          <div className="w-8 h-8 rounded-full border border-dashed border-slate-700 bg-slate-950 flex items-center justify-center">
                                            <span className="text-[10px] font-bold text-slate-500">TBD</span>
                                          </div>
                                        )}
                                        <div className="min-w-0">
                                          <span className="text-xs font-extrabold text-slate-300 block truncate">
                                            {teamA ? teamA.name : 'TBD'}
                                          </span>
                                        </div>
                                      </div>

                                      {/* Score */}
                                      <div className="flex items-center gap-2 mx-4 px-3 py-1 bg-slate-950 rounded-xl border border-slate-850">
                                        <span className="text-sm font-black text-white">{match.played ? match.scoreA : '-'}</span>
                                        <span className="text-slate-600 font-bold text-xs">:</span>
                                        <span className="text-sm font-black text-white">{match.played ? match.scoreB : '-'}</span>
                                      </div>

                                      {/* Team B */}
                                      <div className="flex items-center gap-2.5 flex-1 justify-end min-w-0 text-right">
                                        <div className="min-w-0">
                                          <span className="text-xs font-extrabold text-slate-300 block truncate">
                                            {teamB ? teamB.name : 'TBD'}
                                          </span>
                                        </div>
                                        {teamB ? renderTeamBadge(teamB, 'w-8 h-8') : (
                                          <div className="w-8 h-8 rounded-full border border-dashed border-slate-700 bg-slate-950 flex items-center justify-center">
                                            <span className="text-[10px] font-bold text-slate-500">TBD</span>
                                          </div>
                                        )}
                                      </div>
                                    </div>

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
                                          className="text-[10px] font-bold text-red-400 hover:text-red-300 transition"
                                        >
                                          Eliminar Enfrentamiento
                                        </button>
                                        <button
                                          type="button"
                                          className="text-[10px] font-bold text-emerald-400 hover:text-emerald-300 transition flex items-center gap-1"
                                        >
                                          <Edit2 className="w-3 h-3" /> Editar Marcador
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
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
                  {role === 'admin' && (
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

                        {role === 'admin' && (
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
                  <div className="mt-3 flex items-center gap-2 p-2 bg-slate-950 rounded-lg border border-slate-800">
                    <img src={newTeam.logoUrl} alt="Preview" className="w-10 h-10 rounded-full object-contain bg-slate-900 p-0.5" />
                    <span className="text-xs text-emerald-400 font-semibold">Cargado exitosamente ✓</span>
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
                    <img 
                      src={newTournament.logoUrl} 
                      alt="Logo Preview" 
                      className="w-8 h-8 rounded-lg object-contain border border-slate-800 bg-slate-950 p-0.5" 
                    />
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
                  {currentTour.teams
                    .filter(tt => currentTour.type !== 'GRUPOS' || tt.group === newMatchState.group)
                    .map(tt => {
                      const team = teams.find(t => t.id === tt.teamId);
                      return team ? <option key={team.id} value={team.id}>{team.name}</option> : null;
                    })}
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
                  {currentTour.teams
                    .filter(tt => currentTour.type !== 'GRUPOS' || tt.group === newMatchState.group)
                    .filter(tt => tt.teamId !== newMatchState.teamAId)
                    .map(tt => {
                      const team = teams.find(t => t.id === tt.teamId);
                      return team ? <option key={team.id} value={team.id}>{team.name}</option> : null;
                    })}
                </select>
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
                    <img 
                      src={editingTeam.logoUrl} 
                      alt="Logo Preview" 
                      className="w-10 h-10 rounded-xl object-contain border border-slate-800 bg-slate-950 p-0.5" 
                    />
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
                    <img 
                      src={editingTournament.logoUrl} 
                      alt="Logo Preview" 
                      className="w-8 h-8 rounded-lg object-contain border border-slate-800 bg-slate-950 p-0.5" 
                    />
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
                  {currentTour && (editingMatchDetails.round === 'LLAVES'
                    ? currentTour.teams
                    : currentTour.teams.filter(tt => currentTour.type !== 'GRUPOS' || tt.group === matchDetailsState.group)
                  ).map(tt => {
                    const team = teams.find(t => t.id === tt.teamId);
                    return team ? <option key={team.id} value={team.id}>{team.name}</option> : null;
                  })}
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
                  {currentTour && (editingMatchDetails.round === 'LLAVES'
                    ? currentTour.teams
                    : currentTour.teams.filter(tt => currentTour.type !== 'GRUPOS' || tt.group === matchDetailsState.group)
                  )
                    .filter(tt => tt.teamId !== matchDetailsState.teamAId)
                    .map(tt => {
                      const team = teams.find(t => t.id === tt.teamId);
                      return team ? <option key={team.id} value={team.id}>{team.name}</option> : null;
                    })}
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

      {/* --- MODAL: ADD MANUAL LLAVE --- */}
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
                  {currentTour.teams.map(tt => {
                    const team = teams.find(t => t.id === tt.teamId);
                    return team ? <option key={team.id} value={team.id}>{team.name}</option> : null;
                  })}
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
                  {currentTour.teams
                    .filter(tt => tt.teamId !== manualLlaveState.teamAId)
                    .map(tt => {
                      const team = teams.find(t => t.id === tt.teamId);
                      return team ? <option key={team.id} value={team.id}>{team.name}</option> : null;
                    })}
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
    const tourMatches = matches.filter(m => m.tournamentId === tour.id);

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
                    group: 'A'
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
                    className={`p-3.5 bg-slate-950 rounded-xl border border-slate-850 flex items-center justify-between transition ${
                      role === 'admin' ? 'hover:border-emerald-500/50 cursor-pointer' : ''
                    }`}
                  >
                    {/* Team A details */}
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {teamA ? renderTeamBadge(teamA, 'w-7 h-7') : <div className="w-7 h-7 rounded-full bg-slate-800" />}
                      <span className={`text-xs font-bold truncate ${match.played && (match.scoreA ?? 0) > (match.scoreB ?? 0) ? 'text-white' : 'text-slate-400'}`}>
                        {teamA ? teamA.name : 'TBD'}
                      </span>
                    </div>

                    {/* SCORE BOARD CONTAINER */}
                    <div className="flex flex-col items-center gap-1 mx-2">
                      <div className="px-3 py-1 bg-slate-900 rounded-lg border border-slate-800 text-center flex items-center gap-2">
                        {match.played ? (
                          <>
                            <span className="text-sm font-black text-white">{match.scoreA}</span>
                            <span className="text-[9px] font-bold text-slate-600">-</span>
                            <span className="text-sm font-black text-white">{match.scoreB}</span>
                          </>
                        ) : (
                          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">VS</span>
                        )}
                      </div>
                      {tour.type === 'GRUPOS' && match.group && (
                        <span className="text-[9px] font-extrabold text-emerald-400 bg-emerald-950/40 border border-emerald-900/30 px-1.5 py-0.5 rounded uppercase tracking-wider">
                          Grupo {match.group}
                        </span>
                      )}
                    </div>

                    {/* Team B details */}
                    <div className="flex items-center gap-2 flex-1 justify-end min-w-0 text-right">
                      <span className={`text-xs font-bold truncate ${match.played && (match.scoreB ?? 0) > (match.scoreA ?? 0) ? 'text-white' : 'text-slate-400'}`}>
                        {teamB ? teamB.name : 'TBD'}
                      </span>
                      {teamB ? renderTeamBadge(teamB, 'w-7 h-7') : <div className="w-7 h-7 rounded-full bg-slate-800" />}
                    </div>

                    {/* Admin Action Buttons */}
                    {role === 'admin' && (
                      <div className="flex items-center ml-2 border-l border-slate-850 pl-2 gap-1 flex-shrink-0">
                        {/* Edit Match Details Button */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenEditMatchDetails(match);
                          }}
                          className="text-slate-500 hover:text-emerald-400 p-1.5 rounded-lg hover:bg-slate-900 transition"
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
                          className="text-slate-500 hover:text-red-400 p-1.5 rounded-lg hover:bg-slate-900 transition"
                          title="Eliminar Partido"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
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
          {role === 'admin' && (
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
          } ${role === 'admin' ? 'hover:border-emerald-500 cursor-pointer' : ''}`}
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
