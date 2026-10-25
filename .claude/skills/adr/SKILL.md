---
description: Rédige un nouvel ADR (décision d'architecture) dans docs/adr/ quand une décision change la stack, le périmètre, la sécurité ou la livraison de lockmaster.
argument-hint: "<titre de la décision>"
---

# Nouvel ADR

Décision : `$ARGUMENTS`

1. Liste `docs/adr/` et prends le numéro suivant (`NNNN`, 4 chiffres).
2. Vérifie qu'aucun ADR existant ne couvre déjà la question ; si un ADR est remplacé,
   passe son statut à `remplacé par ADR-NNNN` (seule modification autorisée d'un ADR accepté).
3. Crée `docs/adr/NNNN-<slug-en-kebab>.md` :

```markdown
# ADR-NNNN : <Titre>

- Statut : proposé
- Date : <AAAA-MM-JJ>

## Contexte
<problème, contraintes, pièges de `docs/00` concernés>

## Décision
<ce qui est décidé, précisément>

## Justification
<pourquoi ; données, mesures, références>

## Alternatives écartées
<option : raison>

## Conséquences
<sur le code, la sécurité, l'exploitation, les tests ; documents à mettre à jour>
```

4. Mets à jour les documents impactés (`CLAUDE.md`, `docs/0x-*.md`, feuille de route) et cite l'ADR.
5. L'ADR reste « proposé » tant que l'utilisateur ne l'a pas validé explicitement.
