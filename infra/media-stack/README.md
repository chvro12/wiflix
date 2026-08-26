# Stack média locale WeFlix

## Redémarrage fiable

Sur macOS, utilisez `./restart-media-stack.sh` pour reconstruire ou redémarrer
la stack. Le script suspend brièvement le montage NFS AllDebrid, démarre Docker,
puis le remonte automatiquement. Cela évite le blocage de Docker Desktop lors
de la création d'un conteneur dont le bind mount contient ce sous-montage NFS.

Stack Docker locale pour organiser et diffuser des médias que vous êtes
autorisé à utiliser. Tous les services partagent `./data` sous le chemin
`/data` afin que les liens créés par Vortex soient identiques dans Radarr,
Sonarr et Jellyfin.

## Services

| Service | Adresse | Rôle |
| --- | --- | --- |
| Jellyfin | http://localhost:8096 | Catalogue et lecture |
| Radarr | http://localhost:7878 | Films |
| Sonarr | http://localhost:8989 | Séries |
| Bazarr | http://localhost:6767 | Sous-titres |
| Prowlarr | http://localhost:9696 | Indexeurs autorisés |
| Comet | http://localhost:8000 | Recherche agrégée VF/MULTi |
| Seerr | http://localhost:5055 | Demandes et découverte |
| Vortex (optionnel) | http://localhost:6489 | Interface compatible qBittorrent vers AllDebrid |

Les ports écoutent uniquement sur `127.0.0.1`. Aucun service n'est exposé sur
Internet ou sur le réseau local.

La définition Torrentio fournie avec le projet n'accepte des résultats que
lorsque Radarr ou Sonarr transmet un identifiant IMDb. Torrentio ne proposant
pas de recherche textuelle, une recherche sans identifiant renvoie volontairement
zéro résultat. Cette protection empêche qu'un titre de test comme *Fight Club*
ou *Reacher* soit associé à un autre média.

## 1. Démarrer le socle

Docker Desktop doit être lancé.

```bash
cd infra/media-stack
cp .env.example .env
mkdir -p data/library/movies data/library/tv data/vortex data/alldebrid
docker compose config --quiet
docker compose up -d
```

Dans Jellyfin, ajouter `/data/library/movies` et `/data/library/tv`. Dans
Radarr et Sonarr, utiliser respectivement ces mêmes chemins comme dossiers
racines. Connecter ensuite :

- Bazarr à `http://radarr:7878` et `http://sonarr:8989` ;
- Prowlarr à ces deux mêmes adresses ;
- Seerr à `http://jellyfin:8096`, puis à Radarr et Sonarr.

Les clés API se trouvent dans **Settings > General** de chaque application.

## 2. Activer AllDebrid et Vortex (optionnel)

Cette partie requiert un abonnement AllDebrid. Sur macOS, le montage rclone
est fait sur l'hôte : un montage FUSE dans un conteneur ne se propage pas de
façon fiable vers les autres conteneurs Docker Desktop.

1. Installer rclone : `brew install rclone`. Le script utilise `nfsmount` sur
   macOS et ne nécessite donc pas macFUSE.
2. Créer une clé API AllDebrid dédiée.
3. Lancer `./configure-rclone.sh` et saisir cette clé. Le fichier créé est
   ignoré par Git et protégé avec des permissions restrictives.
4. Dans un terminal séparé, lancer `./mount-alldebrid.sh` et le laisser actif.
5. Démarrer Vortex :

```bash
docker compose --profile alldebrid up -d
```

Configurer Vortex avec :

- montage AllDebrid : `/data/alldebrid` ;
- dossier de liens/téléchargements : `/data/vortex` ;
- une clé API AllDebrid dédiée ;
- catégories `radarr` et `sonarr`.

Dans Radarr et Sonarr, ajouter un client **qBittorrent** :

- hôte : `vortex` ;
- port : `8080` ;
- catégorie : `radarr` ou `sonarr` ;
- dossier racine : `/data/library/movies` ou `/data/library/tv`.

Aucun *Remote Path Mapping* n'est nécessaire puisque `/data` est identique
partout. N'ajoutez que des sources et contenus que vous avez le droit
d'utiliser. Un débrideur ne seed généralement pas : respectez les règles et le
ratio des trackers privés.

## Priorité à la version française

La langue audio passe avant la résolution lors de la sélection automatique :
une source VF/VFF/VFQ est choisie avant une source de meilleure qualité sans
français. Les mentions MULTi viennent ensuite, puis les sources sans langue
confirmée. La qualité, la taille et le nombre de seeders ne départagent que les
sources d'un même niveau de langue.

À niveau de langue égal, une source VF/MULTi trouvée par Comet est essayée en
premier. Cette priorité ne permet jamais à une source Comet sans français de
passer devant une véritable VF trouvée ailleurs.

Les contenus déjà lisibles dont la source n'est pas identifiée VF/VFF ou MULTi
sont également revérifiés dans Comet toutes les six heures. Lorsqu'une source
française apparaît, elle remplace la version étrangère et la sortie HLS de R2
est régénérée. L'ancienne version reste lisible pendant la recherche.

Comet complète les résultats Prowlarr/Torrentio à partir de plusieurs moteurs,
en utilisant l'identifiant IMDb exact du film ou de la série. Il fonctionne ici
uniquement comme moteur de recherche : les vidéos ne sont pas enregistrées dans
son volume. Sa base SQLite est limitée aux métadonnées et aux résultats récents,
avec une expiration après sept jours. L'ingestion DMM en masse, le scraper en
arrière-plan et le proxy vidéo sont désactivés afin de préserver le stockage et
la mémoire du Mac.

## Secours Real-Debrid

Lorsque `REAL_DEBRID_API_KEY` contient le jeton d'un compte Premium,
`r2-importer` conserve AllDebrid comme premier choix puis vérifie
automatiquement le cache Real-Debrid si aucune source AllDebrid n'est prête.
Le fournisseur retenu est enregistré avec chaque film ou épisode ; Jellyfin et
l'encodage R2 utilisent ensuite le bon fournisseur sans exposer sa clé.

Les anciennes entrées restent compatibles et sont considérées comme provenant
d'AllDebrid lorsqu'elles ne possèdent pas encore de champ `provider`.

## Commandes utiles

```bash
# État et journaux
docker compose ps
docker compose logs --tail=100

# Mise à jour
docker compose pull
docker compose up -d

# Arrêt (les configurations sont conservées)
docker compose --profile alldebrid down
```

Les dossiers `config/`, `data/`, le `.env` et la configuration rclone réelle
sont ignorés par Git car ils peuvent contenir des secrets et des données
personnelles.

## Envoi automatique vers Cloudflare R2

Le service `r2-importer` reçoit les webhooks authentifiés de Radarr et Sonarr.
Lorsqu'un média autorisé est importé ou mis à niveau, il :

1. inspecte la source avec `ffprobe` et conserve une seule piste française ;
2. remuxe directement H.264/AAC, ou ne transcode que le flux incompatible ;
3. publie les fichiers fMP4 et playlists de variantes dans le bucket R2 ;
4. publie le master puis le manifeste catalogue en dernier.

Pour Sonarr, l'identifiant TVDB du webhook est converti en identifiant TMDB.
Les traitements utilisent deux voies légères et une voie lourde afin de ne pas
saturer la machine. Le service doit rester démarré avec Docker :

```bash
docker compose up -d r2-importer
docker compose logs -f r2-importer
```

## Lecture hybride et files prioritaires

Une demande interactive ne passe plus derrière le rattrapage du catalogue.
Les travaux sont classés en quatre niveaux : lecture directe, finalisation R2,
amélioration VF, puis réparation. Au redémarrage, seuls les médias explicitement
invalidés sont restaurés immédiatement ; le reste est contrôlé par lots.

Quand R2 n'est pas encore prêt, le Worker peut appeler `POST /playback/session`
sur l'origine. L'importateur publie un HLS temporaire 720p après trois segments,
puis prépare un 720p durable et ajoute le 1080p au manifeste adaptatif.

Les nouvelles publications utilisent par défaut `byterange-fmp4` : une
playlist vidéo, une playlist audio française et deux fichiers média fMP4
adressés par plages HTTP. Ce format remplace plusieurs milliers de segments
R2 par quelques objets seulement. Les anciens contenus `.ts` restent lisibles
et ne sont pas retraités automatiquement.

La file R2 sépare deux remux légers d'un unique transcodage lourd. La découverte
de nouveaux contenus se met en pause au-delà de 32 publications en attente,
sous 20 Go d'espace disque libre ou pendant une lecture interactive nécessitant
le CPU. Les préchargements automatiques privilégient en plus une source AVC
720p compacte ; les demandes interactives conservent leur préférence 1080p.
Les variables principales sont `R2_HLS_LAYOUT`,
`R2_FMP4_CANARY_LIMIT`, `R2_LIGHT_CONCURRENCY`, `R2_MIN_FREE_DISK_GB` et
`R2_MAX_ATTEMPTS`.

Pour exposer l'origine depuis le Mac :

1. créer un tunnel nommé `weflix-origin` vers `http://r2-importer:8788` ;
2. associer `origin.wiflix.site` au tunnel ;
3. renseigner `CLOUDFLARE_TUNNEL_TOKEN`, `MEDIA_ORIGIN_PUBLIC_URL`,
   `MEDIA_ORIGIN_TOKEN` et `MEDIA_ORIGIN_SIGNING_KEY` dans `.env` ;
4. définir `MEDIA_ORIGIN_URL` et le secret `MEDIA_ORIGIN_TOKEN` sur le Worker ;
5. démarrer `docker compose --profile tunnel up -d`.

Le jeton API utilisé pour automatiser les étapes 1 et 2 doit disposer de
`Cloudflare Tunnel: Edit` et `DNS: Edit`. Les playlists utilisent des URLs HMAC
temporaires et n'exposent jamais les liens du fournisseur de fichiers.
