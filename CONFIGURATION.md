# Configuration de WeFlix

## État du dépôt importé

- TMDB alimente le catalogue, la recherche, les fiches, les distributions,
  les recommandations et les liens de bandes-annonces YouTube.
- Firebase Authentication gère email/mot de passe et Google.
- Firestore stocke la watchlist et la liste « continuer à regarder » sous
  `users/{uid}/...`.
- Aucun import, stockage, encodage ou CDN vidéo n'existe dans le dépôt.
- Les anciens lecteurs tiers ont été désactivés. Ils doivent être remplacés
  par des flux détenus ou licenciés.

## Configuration locale

Copier `.env.example` vers `.env.local`, puis renseigner TMDB et Firebase.
Vite charge automatiquement `.env.local`, déjà ignoré par Git.

```bash
cp .env.example .env.local
npm run dev
```

## Architecture vidéo prévue

Les secrets Cloudflare Stream ne doivent jamais être appelés depuis le code
React. Une API serveur devra :

1. authentifier un administrateur ;
2. générer une URL d'upload unique ;
3. recevoir les webhooks de fin d'encodage ;
4. associer l'identifiant vidéo à un identifiant TMDB dans une collection
   `catalog` ;
5. générer un jeton de lecture court pour un utilisateur autorisé.

Schéma minimal envisagé pour `catalog/{mediaKey}` :

```text
mediaType: movie | tv
tmdbId: number
seasonNumber: number | null
episodeNumber: number | null
videoUid: string
status: uploading | processing | ready | blocked
published: boolean
createdAt: timestamp
updatedAt: timestamp
```

Firebase Storage n'est pas nécessaire pour les masters vidéo si Cloudflare
Stream est retenu : Stream reçoit, encode et diffuse directement les fichiers.

## Cloudflare R2, Worker et Turnstile

Le Worker dans `worker/` lie le bucket privé `weflix-media` sous le nom
`MEDIA`. Il valide Turnstile côté serveur et n'autorise la lecture de
`/media/*` qu'après validation d'un jeton Firebase.

Les secrets `TURNSTILE_SECRET_KEY` et `FIREBASE_API_KEY` doivent être ajoutés
avec `wrangler secret put`. Ils ne doivent jamais figurer dans le bundle Vite.
Le frontend utilise `VITE_EDGE_API_URL` en production et le middleware Vite
local lorsqu'elle est vide.

Pour importer un fichier détenu ou licencié et l'associer au catalogue :

```bash
npm run r2:upload -- /chemin/film.mp4 movie/550 "Titre du film"
npm run r2:upload -- /chemin/episode.mp4 episode/1399/1/1 "S01E01"
```

Pour les films longs, utiliser de préférence l'encodage HLS :

```bash
npm run r2:hls -- /chemin/film.mp4 movie/550 "Titre du film"
```
