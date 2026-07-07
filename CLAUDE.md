# jira-cli

CLI Node.js/TypeScript pour créer et modifier des fiches Jira Cloud (écritures,
en complément du connecteur Atlassian en lecture seule).

## Règle impérative : garder la documentation synchronisée

À **chaque** modification du comportement de la CLI — ajout/suppression/renommage
d'une commande, d'un argument ou d'une option, changement d'une valeur par
défaut, d'une variable d'environnement ou d'une règle d'usage — il faut, dans le
même changement :

1. **Vérifier la commande `skill`** ([src/skill.ts](src/skill.ts)).
   Elle produit le skill Claude Code clé en main (`SKILL.md`) lu par les agents
   IA. La partie commandes/arguments/options est générée par introspection de
   commander et se met à jour seule, **mais** les textes statiques
   (`SKILL_DESCRIPTION`, `TOOL_PURPOSE`, `INVOCATION_NOTES`, `USAGE_RULES`,
   défauts documentés) sont écrits à la main : les relire et les corriger si le
   changement les concerne. La `SKILL_DESCRIPTION` est le mécanisme de
   déclenchement du skill — la maintenir à jour quand le périmètre évolue.
2. **Mettre à jour le [README.md](README.md)** en conséquence : liste des
   opérations, exemples de la section *Usage*, et *Notes* (règles de résolution,
   variables d'environnement…).

Le skill et le README sont les deux faces — agent et humain — de la même
documentation : ils ne doivent jamais diverger du code.

## Vérifications avant de conclure

```bash
npm run build      # tsc — doit passer sans erreur
npm run lint       # biome — ou `npm run lint:fix` pour corriger
npm run test       # vitest
```

## Conventions

- Scripts d'outillage (skills, hooks) : **JavaScript/Node.js** uniquement.
- Validation des réponses Jira via schémas zod ([src/jira.schemas.ts](src/jira.schemas.ts)).
- Appels HTTP centralisés dans le helper `request()` de [src/jira.ts](src/jira.ts)
  (gère l'auth Basic, le choix `platform`/`agile`, et le formatage des erreurs).
