import React, { useState, useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import { motion, AnimatePresence } from 'framer-motion';
import { FaTimes, FaGoogle, FaEnvelope, FaLock, FaUser, FaSpinner, FaExclamationCircle, FaCheckCircle } from 'react-icons/fa';
import { BiMoviePlay } from 'react-icons/bi';
import { auth, googleProvider, db } from '../firebase';
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signInWithPopup,
  linkWithCredential,
  sendPasswordResetEmail,
  updateProfile 
} from 'firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';

const FIREBASE_ERRORS = {
  'auth/invalid-email':               'Cette adresse e-mail est invalide.',
  'auth/user-not-found':              'Aucun compte ne correspond à cette adresse.',
  'auth/wrong-password':              'Mot de passe incorrect.',
  'auth/invalid-credential':          'Adresse e-mail ou mot de passe incorrect.',
  'auth/email-already-in-use':        'Un compte utilise déjà cette adresse e-mail.',
  'auth/weak-password':               'Le mot de passe doit contenir au moins 6 caractères.',
  'auth/too-many-requests':           'Trop de tentatives. Veuillez patienter puis réessayer.',
  'auth/network-request-failed':      'Erreur réseau. Vérifiez votre connexion.',
  'auth/popup-closed-by-user':        'La fenêtre de connexion a été fermée.',
  'auth/cancelled-popup-request':     'Une autre fenêtre de connexion est déjà ouverte.',
  'auth/popup-blocked':               'La fenêtre a été bloquée par votre navigateur.',
  'auth/user-disabled':               'Ce compte a été désactivé.',
};

const getFirebaseError = (err) => {
  const code = err?.code || '';
  return FIREBASE_ERRORS[code] || 'Une erreur est survenue. Veuillez réessayer.';
};

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;
const EDGE_API_URL = String(import.meta.env.VITE_EDGE_API_URL || '').replace(/\/$/, '');

// Upsert user profile in Firestore (merge so existing data is not overwritten)
const saveUserToFirestore = async (user) => {
  const ref = doc(db, 'users', user.uid);
  await setDoc(ref, {
    uid: user.uid,
    displayName: user.displayName || null,
    email: user.email,
    photoURL: user.photoURL || null,
    emailVerified: user.emailVerified || false,
    lastLoginAt: serverTimestamp(),
  }, { merge: true });
};

export default function AuthModal({ isOpen, onClose }) {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  // Holds a pending Google OAuthCredential when account collision detected
  const [pendingGoogleCred, setPendingGoogleCred] = useState(null);

  const [verificationSent, setVerificationSent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');

  // Cloudflare Turnstile
  const turnstileRef = useRef(null);
  const turnstileWidgetId = useRef(null);

  useEffect(() => {
    if (!isOpen) return;

    const renderWidget = () => {
      if (!turnstileRef.current || !window.turnstile) return;
      if (turnstileWidgetId.current !== null) {
        try { window.turnstile.remove(turnstileWidgetId.current); } catch { /* widget already removed */ }
      }
      turnstileWidgetId.current = window.turnstile.render(turnstileRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: 'dark',
        callback: (token) => setTurnstileToken(token),
        'expired-callback': () => setTurnstileToken(''),
        'error-callback': () => setTurnstileToken(''),
      });
    };

    // If Turnstile already loaded before this modal opened, render immediately
    if (!TURNSTILE_SITE_KEY) return undefined;
    if (window._turnstileReady || window.turnstile) {
      setTimeout(renderWidget, 100); // small delay for modal DOM to mount
    } else {
      // Wait for the onload event fired from index.html
      window.addEventListener('turnstile-ready', renderWidget, { once: true });
    }

    return () => {
      window.removeEventListener('turnstile-ready', renderWidget);
      if (turnstileWidgetId.current !== null && window.turnstile) {
        try { window.turnstile.remove(turnstileWidgetId.current); } catch { /* widget already removed */ }
        turnstileWidgetId.current = null;
      }
    };
  }, [isOpen]);

  const verifyTurnstile = async () => {
    if (!TURNSTILE_SITE_KEY) throw new Error('Turnstile n’est pas configuré.');
    if (!turnstileToken) throw new Error('Veuillez terminer la validation anti-robot.');
    const response = await fetch(`${EDGE_API_URL}/api/turnstile/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: turnstileToken }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || 'Validation anti-robot refusée.');
  };

  const resetTurnstile = () => {
    setTurnstileToken('');
    if (turnstileWidgetId.current !== null && window.turnstile) window.turnstile.reset(turnstileWidgetId.current);
  };


  // Clear errors when switching tabs
  const handleSwitchTab = (toLogin) => {
    setIsLogin(toLogin);
    setError('');
    setShowReset(false);
    setResetSent(false);
    setPendingGoogleCred(null);
    setVerificationSent(false);
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    if (!resetEmail.trim()) return;
    setLoading(true);
    setError('');
    try {
      await sendPasswordResetEmail(auth, resetEmail.trim());
      setResetSent(true);
    } catch (err) {
      setError(getFirebaseError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await verifyTurnstile();
      if (isLogin) {
        // Sign in with email/password
        const result = await signInWithEmailAndPassword(auth, email, password);

        await result.user.reload();
        if (!result.user.emailVerified) {
          await auth.signOut();
          setError('Veuillez vérifier votre adresse e-mail avant de vous connecter. Consultez votre boîte de réception ou vos courriers indésirables.');
          return; // Stop early
        }

        // If there is a pending Google credential from a collision, link it now
        if (pendingGoogleCred) {
          await linkWithCredential(result.user, pendingGoogleCred);
          setPendingGoogleCred(null);
          // Refresh user to get updated profile after link
          saveUserToFirestore({ ...result.user, displayName: result.user.displayName }).catch(console.error);
        } else {
          // Update Firestore on standard login to reflect verified status and last login
          saveUserToFirestore(result.user).catch(console.error);
        }
      } else {
        // Register new user
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        await updateProfile(userCredential.user, { displayName: name });

        // Send verification email BEFORE writing to Firestore.
        // The Firestore document is intentionally NOT created here — it will be
        // written by saveUserToFirestore() on first successful verified login.
        // This prevents unverified "ghost" rows from cluttering the database.
        const { sendEmailVerification } = await import('firebase/auth');
        await sendEmailVerification(userCredential.user);

        // Sign out immediately so the user cannot access protected routes
        // before they have verified their email address.
        await auth.signOut();

        setVerificationSent(true);
        return; // Stop early so we show the success screen
      }
      onClose();
    } catch (err) {
      setError(err?.code ? getFirebaseError(err) : (err?.message || 'Une erreur est survenue.'));
      resetTurnstile();
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setLoading(true);
    try {
      await verifyTurnstile();
      const result = await signInWithPopup(auth, googleProvider);
      // Save/update user profile in Firestore
      saveUserToFirestore(result.user).catch(console.error);
      onClose();
    } catch (err) {
      setError(err?.code ? getFirebaseError(err) : (err?.message || 'Une erreur est survenue.'));
      resetTurnstile();
    } finally {
      setLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <React.Fragment>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm"
          />

          {/* Modal Container */}
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 30 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="w-full max-w-[400px] bg-[#0b0f19]/95 backdrop-blur-2xl border border-white/10 rounded-3xl shadow-2xl shadow-black overflow-hidden pointer-events-auto"
            >
              <div className="p-8">
                {/* Header */}
                <div className="flex justify-between items-center mb-8">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-red-600/20 flex items-center justify-center">
                      <BiMoviePlay className="text-red-500 text-xl" />
                    </div>
                    <span className="text-xl font-black text-white tracking-tight">
                      We<span className="text-red-500">Flix</span>
                    </span>
                  </div>
                  <button
                    onClick={onClose}
                    className="p-2 bg-white/5 hover:bg-white/10 rounded-full text-gray-400 hover:text-white transition-colors"
                  >
                    <FaTimes />
                  </button>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 p-1 bg-white/5 rounded-xl mb-6">
                  <button
                    type="button"
                    onClick={() => handleSwitchTab(true)}
                    className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all duration-300 ${
                      isLogin ? 'bg-red-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    Connexion
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSwitchTab(false)}
                    className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all duration-300 ${
                      !isLogin ? 'bg-red-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'
                    }`}
                  >
                    Inscription
                  </button>
                </div>

                {/* Info Note / Error */}
                <AnimatePresence mode="wait">
                  {error ? (
                    <motion.div
                      key="error"
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.2 }}
                      className="flex items-start gap-2.5 mb-6 bg-red-500/10 border border-red-500/25 rounded-xl px-4 py-3"
                    >
                      <FaExclamationCircle className="text-red-400 text-base shrink-0 mt-0.5" />
                      <p className="text-red-300 text-sm font-medium leading-snug">{error}</p>
                    </motion.div>
                  ) : (
                    <motion.p
                      key="hint"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="text-gray-400 text-sm mb-6 text-center"
                    >
                      {isLogin
                        ? 'Bon retour ! Connectez-vous pour accéder à votre liste.'
                        : 'Créez un compte pour enregistrer vos films et synchroniser votre progression.'}
                    </motion.p>
                  )}
                </AnimatePresence>

                {/* Form OR Forgot Password */}
                {showReset ? (
                  <form className="space-y-4" onSubmit={handleForgotPassword}>
                    {resetSent ? (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="flex flex-col items-center gap-3 py-4 text-center"
                      >
                        <FaCheckCircle className="text-green-400 text-4xl" />
                        <p className="text-green-300 font-semibold text-sm">E-mail de réinitialisation envoyé !</p>
                        <p className="text-gray-500 text-xs">Consultez votre boîte de réception pour obtenir le lien de réinitialisation.</p>
                        <button
                          type="button"
                          onClick={() => { setShowReset(false); setResetSent(false); setError(''); }}
                          className="mt-2 text-sm text-red-400 hover:text-red-300 font-semibold underline underline-offset-2 transition-colors"
                        >
                          ← Retour à la connexion
                        </button>
                      </motion.div>
                    ) : (
                      <>
                        <div className="relative">
                          <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                            <FaEnvelope className="text-gray-500 text-sm" />
                          </div>
                          <input
                            type="email"
                            required
                            value={resetEmail}
                            onChange={(e) => setResetEmail(e.target.value)}
                            placeholder="Votre adresse e-mail"
                            className="w-full bg-black/20 border border-white/10 rounded-xl py-3 pl-11 pr-4 text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-red-500 focus:border-red-500 transition-all font-medium text-sm"
                          />
                        </div>
                        <button
                          type="submit"
                          disabled={loading}
                          className="w-full py-3.5 flex justify-center items-center gap-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-bold rounded-xl shadow-[0_0_20px_rgba(220,38,38,0.3)] transition-all active:scale-[0.98]"
                        >
                          {loading && <FaSpinner className="animate-spin" />}
                          Envoyer le lien
                        </button>
                        <button
                          type="button"
                          onClick={() => { setShowReset(false); setError(''); }}
                          className="w-full text-sm text-gray-500 hover:text-gray-300 font-semibold transition-colors py-1"
                        >
                          ← Retour à la connexion
                        </button>
                      </>
                    )}
                  </form>
                ) : verificationSent ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex flex-col items-center gap-3 py-4 text-center"
                  >
                    <FaCheckCircle className="text-green-400 text-4xl" />
                    <h2 className="text-white font-bold text-lg mt-2">Vérifiez votre adresse e-mail</h2>
                    <p className="text-gray-400 text-sm">
                      Un lien de vérification a été envoyé à <strong className="text-white">{email}</strong>.
                      Consultez votre boîte de réception et cliquez sur le lien pour activer votre compte.
                    </p>
                    <button
                      type="button"
                      onClick={() => handleSwitchTab(true)}
                      className="mt-4 w-full py-3.5 bg-white/10 hover:bg-white/20 text-white font-bold rounded-xl transition-all"
                    >
                      Retour à la connexion
                    </button>
                  </motion.div>
                ) : (
                <form className="space-y-4" onSubmit={handleSubmit}>
                  {!isLogin && (
                    <motion.div 
                      initial={{ opacity: 0, height: 0 }} 
                      animate={{ opacity: 1, height: 'auto' }} 
                      exit={{ opacity: 0, height: 0 }}
                      className="relative"
                    >
                      <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                        <FaUser className="text-gray-500 text-sm" />
                      </div>
                      <input
                        type="text"
                        required={!isLogin}
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Nom complet"
                        className="w-full bg-black/20 border border-white/10 rounded-xl py-3 pl-11 pr-4 text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-red-500 focus:border-red-500 transition-all font-medium text-sm"
                      />
                    </motion.div>
                  )}

                  <div className="relative">
                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                      <FaEnvelope className="text-gray-500 text-sm" />
                    </div>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="Adresse e-mail"
                      className="w-full bg-black/20 border border-white/10 rounded-xl py-3 pl-11 pr-4 text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-red-500 focus:border-red-500 transition-all font-medium text-sm"
                    />
                  </div>

                  <div className="relative">
                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                      <FaLock className="text-gray-500 text-sm" />
                    </div>
                    <input
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Mot de passe"
                      className="w-full bg-black/20 border border-white/10 rounded-xl py-3 pl-11 pr-4 text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-red-500 focus:border-red-500 transition-all font-medium text-sm"
                    />
                  </div>

                  {isLogin && (
                    <div className="flex justify-end -mt-1">
                      <button
                        type="button"
                        onClick={() => { setShowReset(true); setResetEmail(email); setError(''); }}
                        className="text-xs text-gray-500 hover:text-red-400 font-semibold underline underline-offset-2 transition-colors"
                      >
                        Mot de passe oublié ?
                      </button>
                    </div>
                  )}
                  {TURNSTILE_SITE_KEY ? (
                    <div ref={turnstileRef} className="flex justify-center" />
                  ) : (
                    <p className="text-center text-xs text-amber-400">Protection anti-robot non configurée.</p>
                  )}

                  <button
                    type="submit"
                    disabled={loading || !TURNSTILE_SITE_KEY || !turnstileToken}
                    className={`w-full py-3.5 mt-2 flex justify-center items-center gap-2 disabled:opacity-50 text-white font-bold rounded-xl transition-all active:scale-[0.98] ${
                      pendingGoogleCred
                        ? 'bg-blue-600 hover:bg-blue-500 shadow-[0_0_20px_rgba(37,99,235,0.3)]'
                        : 'bg-red-600 hover:bg-red-500 shadow-[0_0_20px_rgba(220,38,38,0.3)]'
                    }`}
                  >
                    {loading && <FaSpinner className="animate-spin" />}
                    {pendingGoogleCred
                      ? <><FaGoogle /> Se connecter et associer Google</>
                      : (isLogin ? 'Continuer' : 'Créer un compte')
                    }
                  </button>
                </form>
                )}

                {/* Divider */}
                <div className="flex items-center gap-3 my-6">
                  <div className="flex-1 h-px bg-white/10" />
                  <span className="text-xs text-gray-500 uppercase font-semibold">Ou</span>
                  <div className="flex-1 h-px bg-white/10" />
                </div>

                {/* Google Button */}
                <button
                  type="button"
                  disabled={loading}
                  onClick={handleGoogleSignIn}
                  className="w-full flex items-center justify-center gap-3 py-3 bg-white/5 hover:bg-white/10 border border-white/10 text-white font-bold rounded-xl transition-all active:scale-[0.98] disabled:opacity-50"
                >
                  <FaGoogle className="text-red-500" />
                  Continuer avec Google
                </button>
              </div>
            </motion.div>
          </div>
        </React.Fragment>
      )}
    </AnimatePresence>
  );
}

AuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
