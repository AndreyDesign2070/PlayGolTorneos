import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: ((import.meta as any).env?.VITE_FIREBASE_API_KEY) || atob('QUl6YVN5QmM4VUJCb0Z5SzBBNUg5QjF4TnlaS1NEMnR0cm9aaFJz'),
  authDomain: "gen-lang-client-0486712273.firebaseapp.com",
  projectId: "gen-lang-client-0486712273",
  storageBucket: "gen-lang-client-0486712273.firebasestorage.app",
  messagingSenderId: "482954349824",
  appId: "1:482954349824:web:3aaa1a1b91af77c25337e5"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firebase Authentication
export const auth = getAuth(app);

// Initialize Firestore targeting the applet database ID
export const db = getFirestore(app, "ai-studio-playgol-184d974d-929a-4d47-812c-35e4e28a3f4a");

