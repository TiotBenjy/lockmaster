-- 0001 : schéma de la base du signataire, identique à docs/05-modele-de-donnees.md §Base du service de
-- signature (testé). Base distincte de celle de l'application (ADR-0009), lisible par le seul compte
-- lockmaster-signer. Ne jamais modifier cette migration une fois fusionnée : ajouter 0002, 0003...

CREATE TABLE key (
  id          TEXT PRIMARY KEY,                -- même identifiant que signing_key.id côté application
  kind        TEXT NOT NULL CHECK (kind IN ('openpgp','apk-rsa')),
  purpose     TEXT NOT NULL CHECK (purpose IN ('repo','audit')),
  fingerprint TEXT NOT NULL UNIQUE,
  public_key  TEXT NOT NULL,
  private_key_enc BLOB NOT NULL,               -- seal (clé maîtresse du SIGNATAIRE), AAD = table, colonne, id et
                                               -- empreinte de l'identité : une identité modifiée rend la clé indéchiffrable
  -- Identité liée à la clé, fixée à la création/rotation, modifiable seulement par la CLI locale :
  repo_name   TEXT, repo_format TEXT, origin_label TEXT,
  allowed_names TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_names)),
  state       TEXT NOT NULL CHECK (state IN ('active','rotating_in','rotating_out','retired')),
  created_at  INTEGER NOT NULL, expires_at INTEGER,
  CHECK ((purpose = 'audit') = (repo_name IS NULL))
);
CREATE TABLE signature_log (                   -- journal chaîné, append-only
  seq        INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,                 -- horloge du signataire, jamais une valeur reçue par le socket
  key_id     TEXT REFERENCES key(id),          -- NULL seulement pour un refus qui ne désigne aucune clé connue
  kind       TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 32),
                                               -- apt-release, rpm-repomd, rpm-header, apk-index, apk-package,
                                               -- audit-checkpoint ; key-generate, key-rotate, key-retire ; unknown (refus)
  content_sha256 TEXT NOT NULL,                -- contenu signé, clé publique (cycle de vie) ou demande refusée
  request    TEXT NOT NULL CHECK (json_valid(request)),   -- contexte déclaré : dépôt, canal, génération, paquet
  outcome    TEXT NOT NULL CHECK (outcome IN ('signed','refused','done')),  -- done : cycle de vie d'une clé
  reason     TEXT,                             -- motif de refus
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL,
  CHECK (outcome = 'refused' OR key_id IS NOT NULL)
);
CREATE TRIGGER signature_log_no_update BEFORE UPDATE ON signature_log BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER signature_log_no_delete BEFORE DELETE ON signature_log BEGIN SELECT RAISE(ABORT, 'append-only'); END;
-- Chaînage imposé par la base : seq suivant et prev_hash = hash de la dernière entrée (bloque aussi
-- INSERT OR REPLACE, avec recursive_triggers = ON à l'ouverture).
CREATE TRIGGER signature_log_chain BEFORE INSERT ON signature_log
  WHEN NEW.seq IS NOT (SELECT coalesce(max(seq), 0) + 1 FROM signature_log)
    OR NEW.prev_hash IS NOT coalesce((SELECT hash FROM signature_log ORDER BY seq DESC LIMIT 1),
                                     '0000000000000000000000000000000000000000000000000000000000000000')
  BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TABLE rate_window (key_id TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (key_id, minute));
