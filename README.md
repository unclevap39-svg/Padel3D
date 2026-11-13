# Padel 3D

Un match de padel en double, en 3D, jouable dans le navigateur d'un téléphone et installable sur
l'écran d'accueil (PWA, jouable hors ligne). Vous contrôlez un joueur ; votre partenaire et les
deux adversaires sont joués par l'ordinateur.

- **Rendu** : Three.js (PBR, ombres, tone mapping ACES, environnement de stade généré par code)
- **Physique de la balle** : Rapier (WebAssembly) à 240 Hz — gravité, traînée, effet Magnus
  (lift, slice), rebonds sur le gazon, les vitres, le grillage (irrégulier) et le filet
- **Règles** : moteur indépendant du rendu, couvert par des tests unitaires
- **Aucun service payant** : tous les assets sont générés par code ou sous licence libre
  (CC0 pour le modèle des joueurs, OFL pour la police des menus)

## Contenu

- **Accueil façon salon** : votre équipe est sur le terrain, au centre de l'écran ; onglets en
  haut (Jouer, En ligne, Vestiaire, Boutique, Carrière), mode de jeu et bouton JOUER en bas à
  droite, défi du jour et tournoi à gauche. L'habillage « Verre et acier » reprend le terrain
  lui-même : vitres boulonnées, poteaux d'acier, lignes blanches, et le jaune de la balle
  réservé à l'action.

- **Modes de jeu** : match rapide (1 set), match complet (2 sets gagnants), tie-break, tournoi en
  trois tours de difficulté croissante, entraînement, défi du jour.
- **Progression** : pièces et expérience gagnées à chaque match, niveaux, statistiques de carrière.
- **Boutique et vestiaire** : dix personnages, dix raquettes (rondes, goutte d'eau ou diamant,
  finition mate, brillante ou métal), dix terrains avec leur ambiance lumineuse, des tenues et
  des balles, à débloquer avec les pièces gagnées en jouant. Il n'y a aucun achat en argent
  réel ; tout est enregistré sur l'appareil.
- **Personnages** : tous inventés (aucune personne réelle), construits à partir des données
  MakeHuman : corps, visage, peau et coiffure diffèrent. Votre partenaire et vos adversaires
  sont tirés parmi les autres ; en ligne, chacun voit le personnage de l'autre.

## Jeu en ligne

- **Modes** : classique et classé, en 2 contre 2 (chaque joueur avec un partenaire joué par
  l'ordinateur) et en 1 contre 1 ; invitation d'un ami par code ou par lien.
- **Fonctionnement** : une fonction Netlify (`netlify/functions/online.mts`, logique dans
  `server/online.ts`, stockage Netlify Blobs) met les joueurs en relation, puis les deux
  téléphones se connectent directement l'un à l'autre (WebRTC). L'un des deux fait tourner la
  partie, l'autre la reçoit en miroir (`src/net/`).
- **Classement** : points Elo séparés pour le 1v1 et le 2v2, mis à jour quand les deux joueurs
  déclarent le même résultat.

Limites à connaître :

- Sans serveur relais, la connexion directe échoue entre certains réseaux mobiles très fermés ;
  le jeu l'indique et propose de réessayer (le Wi-Fi fonctionne presque toujours).
- La partie tourne sur le téléphone de l'un des joueurs : l'autre a un léger retard sur ses
  propres gestes, et le classement repose sur la bonne foi des deux appareils (pas d'arbitre
  serveur contre la triche).
- Il faut que d'autres joueurs cherchent un match au même moment ; sinon, invitez un ami.

En développement, `npm run dev` sert le salon en mémoire : deux onglets peuvent s'affronter.

## Lancer le projet

```bash
npm install
npm run dev        # serveur de développement : http://localhost:5173
npm test           # tests unitaires (règles, physique, matchs complets IA contre IA)
npm run build      # build de production dans dist/
npm run preview    # sert dist/ sur http://localhost:4173 (service worker actif)
```

Paramètres d'URL utiles : `?q=low|medium|high` force la qualité graphique, `?noinstall` saute
l'écran d'installation.

## Comment jouer

| Action | Geste |
|---|---|
| Se déplacer | Pouce gauche : posez-le n'importe où sur la moitié gauche et glissez |
| Frapper | Trois boutons à droite : FRAPPE (coup normal), LOB, SMASH (balle haute ; le bouton s'allume quand c'est possible). Appuyez dès que la balle vient vers vous : le joueur y va et frappe au bon moment |
| Doser | Maintenez le bouton : la jauge monte, la balle part plus fort et plus loin. Zone verte idéale, zone rouge risquée. Relâchez pour figer la puissance |
| Viser | Bouton enfoncé, le joystick déplace le cercle jaune sur le terrain adverse : la balle ira là. Relâché, elle revient vers le centre |
| Servir | Maintenez FRAPPE pour doser, visez dans le carré avec le joystick, relâchez (deux essais) |
| Pause | Bouton en haut à droite, ou Échap |
| Clavier (ordinateur) | Flèches ou ZQSD, Espace frapper, K lob, L smash (maintenir pour doser) |

Repères à l'écran : un cercle blanc de votre côté montre où la balle adverse va rebondir, et
« Laissez-la » s'affiche quand elle va sortir.

La visée reste toujours dans les lignes : une balle ne sort que si elle est frappée dans la zone
rouge de la jauge, mal prise (joueur trop loin de la balle) ou, sans aide, visée tout près des
lignes. L'aide au placement se règle de 0 à 100 % dans les réglages : à 0 % vous vous placez
seul et vos balles sont moins précises ; plus haut, le joueur court à la balle dès que vous
appuyez sur un bouton et vos balles restent plus près de l'endroit visé.

## Déployer gratuitement sur Netlify

Le fichier `netlify.toml` contient déjà la commande de build, le dossier publié et les en-têtes
de cache. Le HTTPS, indispensable pour une PWA, est fourni automatiquement.

### Méthode 1 — depuis GitHub (mises à jour automatiques)

1. Créez un compte gratuit sur <https://app.netlify.com> (connexion avec GitHub).
2. **Add new site → Import an existing project → GitHub**, puis choisissez le dépôt `Padel3D`.
3. Dans **Branch to deploy**, choisissez la branche qui contient le jeu
   (`claude/lucid-goldberg-1fkfu6`, ou `main` une fois la branche fusionnée).
4. Laissez les autres champs tels quels (ils viennent de `netlify.toml`) et cliquez **Deploy**.
5. Après une à deux minutes, le jeu est en ligne à une adresse du type
   `https://nom-du-site.netlify.app`. Vous pouvez changer ce nom dans
   **Site configuration → Change site name**.

Chaque nouveau commit sur la branche redéploie le site. Les copies installées se mettent à jour
au lancement suivant.

### Méthode 2 — sans GitHub (glisser-déposer)

1. Sur votre ordinateur : `npm install` puis `npm run build`.
2. Ouvrez <https://app.netlify.com/drop> et déposez le dossier `dist`.

## Installer sur le téléphone

Ouvert dans le navigateur, le jeu propose lui-même l'installation au premier lancement.

### iPhone / iPad

1. Ouvrez l'adresse du jeu dans **Safari** (obligatoire : les autres navigateurs iOS ne
   proposent pas tous l'ajout à l'écran d'accueil).
2. Touchez **Partager** (carré avec une flèche vers le haut).
3. Choisissez **Sur l'écran d'accueil**, puis **Ajouter**.
4. Lancez **Padel 3D** depuis son icône et tenez le téléphone en paysage.

### Android

1. Ouvrez l'adresse du jeu dans **Chrome**.
2. Touchez **Installer** dans le jeu, ou le menu **⋮ → Installer l'application**
   (ou **Ajouter à l'écran d'accueil**).
3. Lancez **Padel 3D** depuis son icône : plein écran, verrouillé en paysage.

Après le premier chargement complet, le jeu fonctionne sans connexion.

## Architecture

```
src/
  rules/     Règles du padel en TypeScript pur : terrain, score, arbitre d'un point, match
  physics/   Modèle de vol (traînée, Magnus, rebonds), prédicteur, solveur de coups, monde Rapier
  core/      Simulation sans rendu (joueurs, service, échanges), loi de visée et jauge
             (shots.ts), boucle de jeu, réglages, profil du joueur (pièces, niveaux, objets,
             modes de jeu)
  ai/        Interception de la balle, placement en double, choix de coups, 3 niveaux
  entities/  Joueur (logique), animation procédurale, modèle skinné, mannequin de secours, balle
  render/    Scène, terrain, textures procédurales, caméra, repères au sol, qualité adaptative
  input/     Joystick, boutons de frappe, clavier, vibration
  audio/     Sons synthétisés (Web Audio) et annonce vocale du score
  net/       Jeu en ligne : salon, connexion directe, hôte et invité
  ui/        Accueil façon salon (jouer, modes, en ligne, vestiaire, boutique, carrière,
             réglages), HUD, panneaux de pause et de fin de match ; lobby.css porte l'identité
             visuelle « Verre et acier »
server/      Logique du salon en ligne (testable sans réseau)
netlify/     Fonction serveur du salon
tests/       Vitest : règles, physique, matchs complets, jouabilité (visée, jauge, service),
             réseau, salon
tools/       Construction du modèle de joueur et des icônes
scripts/     Aides de vérification visuelle (captures Playwright)
```

La simulation (`core/sim.ts`) n'importe ni Three.js ni le DOM : elle émet des événements
(frappe, rebond, faute, point) que le rendu, le son et le HUD se contentent d'écouter. C'est ce
qui permet de dérouler des matchs entiers en accéléré dans les tests.

## Limites connues

- **Animations** : il n'existe pas de capture de mouvement de padel sous licence CC0. Tous les
  mouvements sont donc générés par code (pas plantés au sol, cinématique inverse, coups calés
  sur le point de contact réel). C'est cohérent et sans glissement des pieds, mais moins naturel
  que de la capture de mouvement.
- **Personnages** : dix corps différents, mais tous portent la même coupe de tenue (seules les
  couleurs changent) et jouent avec les mêmes animations. Le visage est figé, les cheveux longs
  sont rigides et, de près, le t-shirt peut laisser voir un défaut à l'épaule. Les personnages
  n'ont pas de caractéristiques de jeu propres : la différence est visuelle.
- **Vitres** : transparence, reflets d'environnement et effet de Fresnel, sans réfraction réelle.
- **Public** : tribunes texturées, pas de spectateurs en 3D.
- **Textures** : compressées en WebP et non en KTX2 (le décodeur KTX2 aurait pesé plus lourd que
  le gain pour cinq petites textures).
- **iPhone** : Safari ne propose ni vibration ni verrouillage de l'orientation ; un écran demande
  de tourner l'appareil.
- **Règles simplifiées** : pas de changement de côté, pas de jeu hors du terrain par les portes,
  balle touchant un joueur non arbitrée.
- **Performance** : la qualité s'adapte automatiquement (résolution, puis ombres), mais le jeu
  n'a pas été mesuré sur un téléphone réel. Le compteur d'images par seconde s'active dans les
  réglages.

## Licences et crédits

- Code du jeu : ce dépôt.
- Modèle des joueurs : données [MakeHuman](http://www.makehumancommunity.org) (maillage, squelette,
  vêtements, textures), **CC0 1.0** — détail des sources dans `tools/README.md`.
- Textures du terrain, sons, icônes, environnement : générés par code.
- Police des menus : [Archivo](https://github.com/Omnibus-Type/Archivo) (Omnibus-Type),
  **SIL Open Font License 1.1**, embarquée dans le jeu (`src/ui/fonts/`), aucun appel externe.
- Bibliothèques : three.js (MIT), Rapier (Apache-2.0), décodeur Draco (Apache-2.0).
