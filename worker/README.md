# WeFlix Edge Worker

Ce Worker fournit :

- `POST /api/turnstile/verify` : validation serveur Turnstile ;
- `GET|HEAD /media/<clé-r2>` : lecture privée d'un objet R2 après validation d'un jeton Firebase ;
- `GET /health` : diagnostic sans secret.

Avant le déploiement, définir les secrets :

```bash
npx wrangler@4.80.0 secret put TURNSTILE_SECRET_KEY --config worker/wrangler.jsonc
npx wrangler@4.80.0 secret put FIREBASE_API_KEY --config worker/wrangler.jsonc
npx wrangler@4.80.0 deploy --config worker/wrangler.jsonc
```

La clé S3 R2 n'est pas nécessaire dans le Worker : l'accès passe par le binding `MEDIA`.

Après le déploiement, renseigner l'URL `workers.dev` obtenue dans
`VITE_EDGE_API_URL` côté frontend. En développement local, laisser cette
variable vide pour utiliser le middleware Vite.
