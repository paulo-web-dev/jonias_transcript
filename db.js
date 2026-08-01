"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "aula-ai.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS aulas (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    nome                 TEXT    NOT NULL,
    data_criacao         TEXT    NOT NULL,
    status               TEXT    NOT NULL DEFAULT 'em_andamento',
    duracao              INTEGER NOT NULL DEFAULT 0,
    transcricao_completa TEXT    NOT NULL DEFAULT '',
    resumo_md            TEXT    NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS anotacoes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    aula_id   INTEGER NOT NULL REFERENCES aulas(id) ON DELETE CASCADE,
    texto     TEXT    NOT NULL,
    timestamp TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_anotacoes_aula ON anotacoes(aula_id);
`);

module.exports = db;
