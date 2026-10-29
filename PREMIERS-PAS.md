# Publier et lancer Capri

Ce dossier contient les sources prêtes pour un dépôt GitHub. Il n’inclut ni voix
personnelle, ni clé API, ni réglages de ton ordinateur, ni historique Git privé.

## Déposer le projet sur GitHub

Crée un dépôt vide sur GitHub, puis ajoute le contenu de ce dossier à sa racine.
Pour les fichiers volumineux ou l’ensemble des sous-dossiers, utilise GitHub Desktop
ou Git. Le fichier `.gitignore` empêche l’ajout accidentel des dépendances installées,
des installateurs, des modèles et des échantillons vocaux.

Conserve les licences, les mentions de provenance et les attributions du projet.
La licence actuelle PolyForm Noncommercial n’autorise pas tous les usages commerciaux.

## Lancer le projet sous Windows

Installe Node.js (version 20 ou ultérieure), ouvre un terminal dans ce dossier, puis :

```console
npm ci
npm start
```

## Vérifier et fabriquer une version

```console
npm run test:safety
npm run test:animations
npm run test:voices
npm run test:hooks
npm run dist
```

Les tests de voix et d’intégrations utilisent uniquement des serveurs de test locaux.
L’installateur apparaît dans `dist/`. Il n’est pas signé par un certificat d’éditeur.

## Animations et voix

Les déplacements et rotations utilisent désormais une cadence cible de 60 images
par seconde, avec un timing régulier sur les écrans rapides. Les dessins originaux
gardent leur cadence artistique. Le mode de mouvements réduits est respecté.

Aucune voix personnalisée n’est configurée ou fournie. Le studio vocal reste disponible
pour plus tard. Ses modèles sont téléchargés séparément et ne doivent pas être ajoutés
au dépôt. Voir `scripts/voice/README.md` pour les limites de sécurité du moteur optionnel.
