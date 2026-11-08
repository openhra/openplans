CREATE TABLE rx_release (
  snapshot_id text PRIMARY KEY REFERENCES snapshot(snapshot_id),
  source_version date NOT NULL UNIQUE,
  concept_count integer NOT NULL DEFAULT 0,
  relation_count integer NOT NULL DEFAULT 0,
  ndc_count integer NOT NULL DEFAULT 0
);

-- One row per published RXNORM atom preserves synonyms/TTY rather than guessing a name.
CREATE TABLE rx_concept (
  snapshot_id text NOT NULL REFERENCES rx_release(snapshot_id),
  rxcui text NOT NULL CHECK (rxcui ~ '^[0-9]+$'),
  rxaui text NOT NULL,
  name text NOT NULL,
  tty text NOT NULL,
  suppress text NOT NULL CHECK (suppress IN ('N', 'O', 'Y', 'E')),
  source_record bigint NOT NULL,
  PRIMARY KEY (snapshot_id, rxaui)
);
CREATE INDEX rx_concept_rxcui ON rx_concept(snapshot_id, rxcui);
CREATE INDEX rx_concept_name ON rx_concept(snapshot_id, lower(name) text_pattern_ops);

-- Semantic direction: source_rxcui --rela--> target_rxcui (RXCUI2 --> RXCUI1).
CREATE TABLE rx_relation (
  snapshot_id text NOT NULL REFERENCES rx_release(snapshot_id),
  source_rxcui text NOT NULL CHECK (source_rxcui ~ '^[0-9]+$'),
  target_rxcui text NOT NULL CHECK (target_rxcui ~ '^[0-9]+$'),
  rela text NOT NULL,
  suppress text NOT NULL CHECK (suppress IN ('N', 'O', 'Y', 'E', '')),
  source_record bigint NOT NULL,
  PRIMARY KEY (snapshot_id, source_rxcui, target_rxcui, rela, suppress)
);
CREATE INDEX rx_relation_target ON rx_relation(snapshot_id, target_rxcui, rela);

CREATE TABLE rx_ndc (
  snapshot_id text NOT NULL REFERENCES rx_release(snapshot_id),
  rxcui text NOT NULL CHECK (rxcui ~ '^[0-9]+$'),
  ndc text NOT NULL CHECK (ndc ~ '^[0-9]{11}$'),
  suppress text NOT NULL CHECK (suppress IN ('N', 'O', 'Y', 'E', '')),
  source_record bigint NOT NULL,
  PRIMARY KEY (snapshot_id, rxcui, ndc, suppress)
);
CREATE INDEX rx_ndc_code ON rx_ndc(snapshot_id, ndc);
