import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
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
