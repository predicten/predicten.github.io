// Google authentication helpers.
import {
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, googleProvider } from "./firebase.js";
import { ADMIN_EMAILS } from "./config.js";

export function watchAuth(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function loginWithGoogle() {
  const result = await signInWithPopup(auth, googleProvider);
  await upsertUser(result.user);
  return result.user;
}

export function logout() {
  return signOut(auth);
}

export function isAdmin(user) {
  return !!user && ADMIN_EMAILS.includes((user.email || "").toLowerCase());
}

// Mirror the signed-in user into /users so other clients can show names.
async function upsertUser(user) {
  if (!user) return;
  await setDoc(
    doc(db, "users", user.uid),
    {
      uid: user.uid,
      displayName: user.displayName || user.email || "Player",
      email: (user.email || "").toLowerCase(),
      photoURL: user.photoURL || null,
      lastSeen: serverTimestamp(),
    },
    { merge: true }
  );
}
