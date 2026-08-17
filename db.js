"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "aula-ai.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ---------- Migrações ----------
// Versionamento via PRAGMA user_version: cada função abaixo leva o banco da
// versão N-1 para a versão N, dentro de uma transação (se falhar, a versão não
// avança). Bancos novos e antigos passam pelo mesmo caminho — a migração 1 é o
// baseline idempotente (CREATE IF NOT EXISTS) que ambos já satisfazem.

const MIGRACOES = [
  // 1 — baseline: aulas + anotações
  () => {
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
  },

  // 2 — usuários e posse das aulas. usuario_id entra nullable porque o SQLite
  // não permite ADD COLUMN NOT NULL sem default constante; o seed no startup
  // (auth.js) faz o backfill e a aplicação sempre grava o dono.
  () => {
    db.exec(`
      CREATE TABLE usuarios (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        login      TEXT    NOT NULL UNIQUE,
        senha_hash TEXT    NOT NULL,
        nome       TEXT    NOT NULL DEFAULT '',
        papel      TEXT    NOT NULL DEFAULT 'admin',
        ativo      INTEGER NOT NULL DEFAULT 1,
        criado_em  TEXT    NOT NULL
      );

      ALTER TABLE aulas ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id);
      CREATE INDEX idx_aulas_usuario ON aulas(usuario_id);
    `);
  },

  // 3 — bloqueio progressivo de tentativas de login (por IP e por login)
  () => {
    db.exec(`
      CREATE TABLE login_bloqueios (
        chave         TEXT PRIMARY KEY,
        falhas        INTEGER NOT NULL DEFAULT 0,
        bloqueado_ate TEXT
      );
    `);
  },
];

let versao = db.pragma("user_version", { simple: true });
for (; versao < MIGRACOES.length; versao++) {
  db.transaction(() => {
    MIGRACOES[versao]();
    db.pragma(`user_version = ${versao + 1}`);
  })();
}

module.exports = db;
