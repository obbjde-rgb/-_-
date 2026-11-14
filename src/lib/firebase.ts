import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  projectId: "tokyo-canto-cxfb9",
  appId: "1:312887359748:web:046f42e349005fa058f851",
  apiKey: "AIzaSyA6JNqdTVraf4mUEMru1nKlYz3bf7BgSL4",
  authDomain: "tokyo-canto-cxfb9.firebaseapp.com",
  storageBucket: "tokyo-canto-cxfb9.firebasestorage.app",
  messagingSenderId: "312887359748"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, "ai-studio-0c8042e7-b201-4a9c-870a-f6b5301aaa1f");
export const auth = getAuth(app);

export enum OperationType {
  READ = 'read',
  WRITE = 'write',
  DELETE = 'delete',
  UPDATE = 'update',
  CREATE = 'create',
  LIST = 'list'
}

export const handleFirestoreError = (error: any, operation: OperationType, ...args: any[]) => {
  if (error?.message?.includes('Quota exceeded') || error?.code === 'resource-exhausted') {
    console.warn(`Firestore ${operation} quota exceeded. Using fallback.`, error.message);
  } else {
    console.error(`Firestore ${operation} error:`, error, ...args);
  }
  throw error;
};

export default app;
