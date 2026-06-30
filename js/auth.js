// Google authentication + role helpers.
//
// Roles:
//   super admin   -> SUPER_ADMIN_EMAILS (code). Can manage subgroup admins.
//   subgroup admin -> BOOTSTRAP_ADMIN_EMAILS (code) + the `admins` collection
//                     (created by a super admin). Can create matches + invite.
//   player        -> any signed-in user. Joins a game via a shared link.
import {
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db, googleProvider } from "./firebase.js";
import { BOOTSTRAP_ADMIN_EMAILS, SUPER_ADMIN_EMAILS } from "./config.js";

const lc = (s) => (s || "").toLowerCase();

const SUPER_SET = new Set(SUPER_ADMIN_EMAILS.map(lc));
const BOOTSTRAP_SET = new Set(BOOTSTRAP_ADMIN_EMAILS.map(lc));

// Dynamic subgroup admins, kept in sync from the `admins` collection.
let dynamicAdmins = new Set();

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

export function isSuperAdmin(user) {
  return !!user && SUPER_SET.has(lc(user.email));
}

// True for roles known from code alone (no Firestore read needed).
export function isKnownAdmin(user) {
  if (!user) return false;
  const email = lc(user.email);
  return SUPER_SET.has(email) || BOOTSTRAP_SET.has(email);
}

export function isAdmin(user) {
  if (!user) return false;
  const email = lc(user.email);
  return SUPER_SET.has(email) || BOOTSTRAP_SET.has(email) || dynamicAdmins.has(email);
}

// Subscribe to the dynamic admin list. Updates the in-memory set used by
// isAdmin() and (optionally) hands the list to a callback for the UI.
export function watchAdmins(callback) {
  return onSnapshot(collection(db, "admins"), (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    dynamicAdmins = new Set(list.map((a) => lc(a.email || a.id)));
    if (callback) callback(list);
  });
}

// Super admin grants subgroup-admin access by email.
export async function addAdmin(email, byUser) {
  const e = lc(email);
  if (!e) throw new Error("Enter an email address.");
  await setDoc(
    doc(db, "admins", e),
    {
      email: e,
      role: "admin",
      createdBy: byUser ? byUser.uid : null,
      createdByEmail: byUser ? lc(byUser.email) : null,
      createdAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function removeAdmin(email) {
  await deleteDoc(doc(db, "admins", lc(email)));
}

// Mirror the signed-in user into /users so other clients can show names.
async function upsertUser(user) {
  if (!user) return;
  await setDoc(
    doc(db, "users", user.uid),
    {
      uid: user.uid,
      displayName: user.displayName || user.email || "Player",
      email: lc(user.email),
      photoURL: user.photoURL || null,
      lastSeen: serverTimestamp(),
    },
    { merge: true }
  );
}
