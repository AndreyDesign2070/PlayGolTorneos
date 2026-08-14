import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { 
  getFirestore, 
  initializeFirestore, 
  persistentLocalCache, 
  persistentMultipleTabManager,
  enableIndexedDbPersistence 
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyBc8UBBoFyK0A5H9B1xNyZKSD2ttroZhRs",
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

// Initialize Firestore with offline persistent cache (IndexedDB) to minimize network reads
let firestoreDb;
try {
  firestoreDb = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  }, "ai-studio-playgol-184d974d-929a-4d47-812c-35e4e28a3f4a");
} catch (e) {
  firestoreDb = getFirestore(app, "ai-studio-playgol-184d974d-929a-4d47-812c-35e4e28a3f4a");
  enableIndexedDbPersistence(firestoreDb).catch(() => {});
}

export const db = firestoreDb;
