# Outils de construction des assets

## `build-character.mjs` — modèle des joueurs

Construit `public/models/player.glb` (maillage skinné compressé Draco, textures WebP) et
`public/models/skin_dark.webp` à partir des données **MakeHuman**, toutes publiées en **CC0 1.0**
(« The assets […] have been released under CC0 1.0 Universal », `LICENSE.md` du dépôt MakeHuman,
section C ; chaque fichier porte la mention « explicitly released as CC0 in september 2020 »).

```
node tools/build-character.mjs <dossier de données>
```

Le dossier de données doit contenir quatre sous-dossiers :

| Sous-dossier | Contenu | Source |
|---|---|---|
| `makehuman/` | `3dobjs/base.obj`, `targets/macrodetails/*.target`, `eyes/low-poly/*`, `eyes/materials/brown_eye.png` | `makehumancommunity/makehuman`, tag `v1.3.0`, dossier `makehuman/data` |
| `mpfb/` | `rigs/standard/rig.game_engine.json`, `rigs/standard/weights.game_engine.json`, `mesh_metadata/basemesh_vertex_groups.json` | `makehumancommunity/mpfb2`, tag `v2.0.18`, dossier `src/mpfb/data` |
| `assets/` | `clothes/male_casualsuit06/*`, `clothes/shoes05/*`, `hair/short02/*` (fichiers `.mhclo`, `.obj`) | `makehumancommunity/makehuman-assets`, tag `v1.3.0`, dossier `base` |
| `textures/` | les PNG correspondants : `skins/textures/young_{light,dark}skinned_male_diffuse.png`, `clothes/male_casualsuit06/*_{diffuse,ao,normal}.png`, `clothes/shoes05/shoes05_diffuse.png`, `hair/short02/short02_diffuse.png` | même dépôt (fichiers Git LFS) |

Provenance des fichiers utilisés pour la version livrée : les dépôts `makehuman` et `mpfb2` ont
été lus via `raw.githubusercontent.com`. Le dépôt `makehuman-assets` n'étant plus servi par
GitHub, ses fichiers texte viennent de l'archive `v1.3.0` conservée par le proxy de modules Go
(`proxy.golang.org`), et ses textures PNG du miroir `gitlab.com/fihlatv/makehuman-assets`,
vérifiées identiques (SHA-256) aux pointeurs LFS de la version `v1.3.0`.

Les dix personnages de la boutique se construisent avec le même script :

```
node tools/build-character.mjs <dossier de données> --roster public/models/chars
```

Chaque fichier `public/models/chars/<nom>.glb` ne contient que ce qui est propre au personnage
(corps, peau, cheveux en gris neutre que le jeu teinte) ; la tenue, les chaussures et les yeux
réutilisent les textures du modèle de base. La liste (`ROSTER` dans le script) fixe pour chacun
les morphs MakeHuman (origine, sexe, âge, musculature, corpulence, forme du visage), la taille,
la coiffure et la texture de peau. Coiffures et peaux utilisées : `hair/{short01..04, bob01,
bob02, braid01, ponytail01, long01}` et les textures `skins/textures/*_diffuse*.png`, mêmes
sources et même licence CC0 que ci-dessus.

Ce que fait le script :

1. applique les morphs « homme jeune » (+ 35 % de musculature) au maillage de base ;
2. place le squelette « game engine » (53 os) sur les repères du maillage morphé et reprend ses poids ;
3. ajuste vêtements, chaussures, cheveux et yeux sur le corps (format `.mhclo`) ;
4. transforme le jean en short (coupe au-dessus du genou, ourlet), sépare t-shirt et short pour
   pouvoir les teinter aux couleurs des équipes, et efface le logo imprimé sur le t-shirt ;
5. masque la peau cachée par les vêtements, exporte en glTF binaire (Draco + WebP).

Les os sont exportés sans orientation de repos (translation seule) : le jeu calcule lui-même
les rotations à partir de son animation procédurale (`src/entities/skinned.ts`).

Dépendances de développement : `@gltf-transform/*`, `draco3dgltf`, `sharp`.
