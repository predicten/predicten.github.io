// Firebase web app config for Predicten.
export const firebaseConfig = {
  apiKey: "AIzaSyClo9x5vquZqJY3Rlpnq27BBEjb9eZfWRM",
  authDomain: "predicten-2c4e7.firebaseapp.com",
  projectId: "predicten-2c4e7",
  storageBucket: "predicten-2c4e7.firebasestorage.app",
  messagingSenderId: "743144220563",
  appId: "1:743144220563:web:dd02d4d8bf5b5fb6e8aa66",
  measurementId: "G-Q68F6RFRFH",
};

// Super admins can do everything, including creating/removing subgroup admins
// from the admin console. Keep this list tiny. (Also enforced in firestore.rules.)
export const SUPER_ADMIN_EMAILS = [
  "jue.george@gmail.com",
];

// Permanent admins baked into the app, in addition to the dynamic subgroup
// admins a super admin creates from the console (stored in the `admins`
// collection). These can create matches and invite players, but cannot manage
// other admins. (Also enforced in firestore.rules.)
export const BOOTSTRAP_ADMIN_EMAILS = [
  "binoybt@gmail.com",
];
