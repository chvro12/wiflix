import React, { useState, useEffect } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { applyActionCode } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { auth, db } from '../../firebase';
import { FaSpinner, FaCheckCircle, FaExclamationCircle } from 'react-icons/fa';
import { BiMoviePlay } from 'react-icons/bi';
import SEO from './SEO';

export default function EmailVerificationPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const location = useLocation();

  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    const oobCode = queryParams.get('oobCode');
    const mode = queryParams.get('mode');

    if (!oobCode || mode !== 'verifyEmail') {
      setError('Le lien de vérification est invalide ou incomplet. Utilisez le lien exact reçu par e-mail.');
      setLoading(false);
      return;
    }

    const processVerification = async () => {
      try {
        // 1. Actually verify the email token with Firebase
        await applyActionCode(auth, oobCode);

        // 2. Wait for Firebase to finish resolving the local session.
        await auth.authStateReady();

        // 3. If they opened the link on the SAME device they registered on,
        //    currentUser will be present — reload it to get the fresh emailVerified: true
        //    token, then write it to Firestore immediately.
        //
        //    If they opened it on a DIFFERENT device (e.g. mobile after registering on Mac),
        //    currentUser is null here. In that case we skip the Firestore write —
        //    it will be done by saveUserToFirestore() the next time they log in on any device,
        //    because signInWithEmailAndPassword always returns a fresh ID token from the server.
        if (auth.currentUser) {
          await auth.currentUser.reload();
          const u = auth.currentUser;
          if (u.emailVerified) {
            const ref = doc(db, 'users', u.uid);
            await setDoc(ref, { emailVerified: true }, { merge: true });
          }
        }

        setSuccess(true);
      } catch (err) {
        setError('Le lien de vérification est invalide ou a expiré.');
      } finally {
        setLoading(false);
      }
    };

    processVerification();
  }, [location.search]);

  return (
    <div className="min-h-screen bg-[#07080a] flex items-center justify-center p-4">
      <SEO title="Vérification de l’adresse e-mail — WeFlix" noSuffix />
      
      <div className="w-full max-w-[400px] bg-[#0b0f19]/95 backdrop-blur-2xl border border-white/10 rounded-3xl shadow-2xl shadow-black p-8 text-center">
        <div className="flex justify-center items-center gap-2 mb-8">
          <div className="w-10 h-10 rounded-xl bg-red-600/20 flex items-center justify-center">
            <BiMoviePlay className="text-red-500 text-2xl" />
          </div>
          <span className="text-2xl font-black text-white tracking-tight">
            We<span className="text-red-500">Flix</span>
          </span>
        </div>

        {loading ? (
          <div className="flex flex-col items-center gap-4 py-8">
            <FaSpinner className="text-red-500 animate-spin text-4xl" />
            <p className="text-gray-400 font-medium mt-2">Vérification de votre adresse e-mail…</p>
          </div>
        ) : success ? (
          <div className="flex flex-col items-center gap-4">
            <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mb-2">
              <FaCheckCircle className="text-green-500 text-4xl" />
            </div>
            <h2 className="text-xl font-bold text-white">Adresse e-mail vérifiée !</h2>
            <p className="text-gray-400 text-sm mb-4">
              Votre adresse e-mail a bien été vérifiée. Votre compte est maintenant actif.
            </p>
            <Link
              to="/"
              className="w-full py-3.5 flex justify-center items-center gap-2 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl shadow-[0_0_20px_rgba(220,38,38,0.3)] transition-all"
            >
              Aller à l’accueil
            </Link>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mb-2">
              <FaExclamationCircle className="text-red-500 text-4xl" />
            </div>
            <h2 className="text-xl font-bold text-white">Échec de la vérification</h2>
            <p className="text-gray-400 text-sm mb-4 leading-relaxed">
              {error}
            </p>
            <Link
              to="/"
              className="w-full py-3.5 flex justify-center items-center bg-white/10 hover:bg-white/20 text-white font-bold rounded-xl transition-all"
            >
              Retour à l’accueil
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
