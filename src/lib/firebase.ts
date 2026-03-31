import { FirebaseApp, FirebaseOptions, getApps, initializeApp } from "firebase/app";
import { Database, getDatabase } from "firebase/database";

const REQUIRED_KEYS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_DATABASE_URL",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

const FIREBASE_ENV = {
  NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  NEXT_PUBLIC_FIREBASE_DATABASE_URL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
} as const;

function readFirebaseConfig(): FirebaseOptions | null {
  const values = REQUIRED_KEYS.map((key) => FIREBASE_ENV[key]);
  const hasMissing = values.some((value) => !value);
  if (hasMissing) {
    return null;
  }

  return {
    apiKey: FIREBASE_ENV.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: FIREBASE_ENV.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    databaseURL: FIREBASE_ENV.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
    projectId: FIREBASE_ENV.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: FIREBASE_ENV.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: FIREBASE_ENV.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: FIREBASE_ENV.NEXT_PUBLIC_FIREBASE_APP_ID,
  };
}

export function getMissingFirebaseEnv(): string[] {
  return REQUIRED_KEYS.filter((key) => !FIREBASE_ENV[key]).map((key) => key);
}

export function canInitializeFirebase(): boolean {
  return getMissingFirebaseEnv().length === 0;
}

let cachedApp: FirebaseApp | null = null;
let cachedDatabase: Database | null = null;

export function getRealtimeDatabase(): Database | null {
  const config = readFirebaseConfig();
  if (!config) {
    return null;
  }

  if (!cachedApp) {
    cachedApp = getApps()[0] ?? initializeApp(config);
  }

  if (!cachedDatabase) {
    cachedDatabase = getDatabase(cachedApp);
  }

  return cachedDatabase;
}
