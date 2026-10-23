import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  getDocs,
  query,
  where,
  type Firestore,
} from "firebase/firestore";
import fs from "node:fs";
import path from "node:path";
import type { NovelRow, ChapterRow, AppSettingsRow } from "./db.server";

let _app: FirebaseApp | null = null;
let _db: Firestore | null = null;

const DEFAULT_FIREBASE_CONFIG = {
  projectId: "dauntless-scene-4vxch",
  appId: "1:1001471407430:web:11f3e629fbb081cd2de147",
  apiKey: "AIzaSyCrXyv0qIKr11y7t-Ca32itusVyRe_Ltso",
  authDomain: "dauntless-scene-4vxch.firebaseapp.com",
  firestoreDatabaseId: "ai-studio-lovabletxt-768ababb-fd3d-4be4-9379-d48ddbf82faf",
  storageBucket: "dauntless-scene-4vxch.firebasestorage.app",
  messagingSenderId: "1001471407430",
};

export function getFirestoreDb(): Firestore | null {
  if (_db) return _db;
  try {
    let config = DEFAULT_FIREBASE_CONFIG;
    try {
      const candidates = [
        path.resolve(process.cwd(), "firebase-applet-config.json"),
        path.resolve(process.cwd(), ".output/server/firebase-applet-config.json"),
        "/app/applet/firebase-applet-config.json",
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          config = JSON.parse(fs.readFileSync(p, "utf-8"));
          break;
        }
      }
    } catch {
      // Safe fallback
    }
    _app = getApps().length ? getApps()[0]! : initializeApp(config);
    _db = getFirestore(_app, config.firestoreDatabaseId || "(default)");
    return _db;
  } catch (err) {
    console.error("[Firestore] Failed to initialize Firestore:", err);
    return null;
  }
}

/** Sync entire state down from Firestore (called on container boot) */
export async function syncDownFromFirestore(): Promise<{
  settings?: AppSettingsRow;
  novels: NovelRow[];
  chapters: ChapterRow[];
} | null> {
  const db = getFirestoreDb();
  if (!db) return null;
  try {
    const novelsSnap = await getDocs(collection(db, "novels"));
    const novels: NovelRow[] = [];
    novelsSnap.forEach((d) => novels.push(d.data() as NovelRow));

    const chaptersSnap = await getDocs(collection(db, "chapters"));
    const chapters: ChapterRow[] = [];
    chaptersSnap.forEach((d) => chapters.push(d.data() as ChapterRow));

    const settingsSnap = await getDoc(doc(db, "settings", "app"));
    const settings = settingsSnap.exists() ? (settingsSnap.data() as AppSettingsRow) : undefined;

    return { settings, novels, chapters };
  } catch (err) {
    console.warn("[Firestore] Failed to sync down from Firestore:", err);
    return null;
  }
}

/** Save a novel to Firestore */
export async function saveNovelToFirestore(novel: NovelRow) {
  const db = getFirestoreDb();
  if (!db) return;
  try {
    await setDoc(doc(db, "novels", novel.id), novel, { merge: true });
  } catch (err) {
    console.error(`[Firestore] Failed to save novel ${novel.id}:`, err);
  }
}

/** Delete a novel and its chapters from Firestore */
export async function deleteNovelFromFirestore(novelId: string) {
  const db = getFirestoreDb();
  if (!db) return;
  try {
    await deleteDoc(doc(db, "novels", novelId));
    const q = query(collection(db, "chapters"), where("novel_id", "==", novelId));
    const snap = await getDocs(q);
    const deletes = snap.docs.map((d) => deleteDoc(d.ref));
    await Promise.all(deletes);
  } catch (err) {
    console.error(`[Firestore] Failed to delete novel ${novelId}:`, err);
  }
}

/** Save a chapter to Firestore */
export async function saveChapterToFirestore(chapter: ChapterRow) {
  const db = getFirestoreDb();
  if (!db) return;
  try {
    const key = `${chapter.novel_id}_${chapter.idx}`;
    await setDoc(doc(db, "chapters", key), chapter, { merge: true });
  } catch (err) {
    console.error(`[Firestore] Failed to save chapter ${chapter.idx}:`, err);
  }
}

/** Save app settings to Firestore */
export async function saveSettingsToFirestore(settings: AppSettingsRow) {
  const db = getFirestoreDb();
  if (!db) return;
  try {
    await setDoc(doc(db, "settings", "app"), settings, { merge: true });
  } catch (err) {
    console.error("[Firestore] Failed to save settings:", err);
  }
}
