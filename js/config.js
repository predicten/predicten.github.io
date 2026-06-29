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

// Emails allowed to use the admin console. Anyone signed in with one of these
// Google accounts can enter stats / settle windows. (Also enforce in
// firestore.rules for real security — see firestore.rules.)
export const ADMIN_EMAILS = [
  "jue.george@gmail.com",
  "binoybt@gmail.com",
];
