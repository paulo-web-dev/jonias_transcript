"use strict";
// Operações de manutenção do banco SQLite, para o deploy seguro (CLAUDE.md,
// "Deploy seguro"). Não depende de db.js — não roda migração nem seed, então
// serve também para inspecionar um banco antigo sem alterá-lo.
//
//   node scripts/banco.js conferir   <arquivo.db>
//   node scripts/banco.js checkpoint <arquivo.db>
//   node scripts/banco.js backup     <arquivo.db> <destino.db>
//
// Também funciona dentro de um container que ainda não tem este arquivo:
//   docker compose exec -T <serviço> node - conferir /app/aula-ai.db < scripts/banco.js

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// `node - cmd arq` (stdin) e `node scripts/banco.js cmd arq` deixam os
// argumentos em posições iguais: argv[2] em diante.
const [cmd, arquivo, destino] = process.argv.slice(2);

function sair(msg) {
  console.error(`✖  ${msg}`);
  process.exit(1);
}

if (!cmd || !arquivo) sair("uso: banco.js conferir|checkpoint|backup <arquivo.db> [destino.db]");
const caminho = path.resolve(arquivo);
if (!fs.existsSync(caminho)) sair(`${caminho} não existe`);

const TABELAS = [
  "usuarios", "pessoas", "carteiras", "contatos_ativo", "contatos_ativo_historico",
  "marcacoes_prospeccao", "cores_prospeccao", "ligacoes", "oportunidades",
  "matriculas", "turmas", "metas", "periodos", "feedbacks", "aulas", "importacoes",
];

function tamanhos() {
  return ["", "-wal", "-shm"]
    .map((suf) => {
      const f = caminho + suf;
      return fs.existsSync(f) ? `${path.basename(f)} ${fs.statSync(f).size} B` : null;
    })
    .filter(Boolean)
    .join(" · ");
}

function conferir() {
  const db = new Database(caminho, { readonly: true, fileMustExist: true });
  const existe = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all());
  console.log(`arquivo       ${caminho}`);
  console.log(`tamanhos      ${tamanhos()}`);
  console.log(`user_version  ${db.pragma("user_version", { simple: true })}`);
  console.log(`quick_check   ${db.pragma("quick_check", { simple: true })}`);
  for (const t of TABELAS) {
    const n = existe.has(t) ? db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get() : "(não existe)";
    console.log(`${t.padEnd(26)} ${n}`);
  }
  // Os carimbos mais recentes provam que é o banco VIVO, não uma cópia antiga.
  const ultimo = (sql) => { try { return db.prepare(sql).pluck().get() ?? "—"; } catch { return "—"; } };
  console.log(`último histórico de contato  ${ultimo("SELECT MAX(registrado_em) FROM contatos_ativo_historico")}`);
  console.log(`última edição de contato     ${ultimo("SELECT MAX(editado_em) FROM contatos_ativo")}`);
  console.log(`última marcação              ${ultimo("SELECT MAX(marcado_em) FROM marcacoes_prospeccao")}`);
  console.log(`última importação            ${ultimo("SELECT MAX(iniciado_em) FROM importacoes")}`);
  // Importações recusadas guardam o motivo real (a tela antiga só dizia "erro 422")
  if (existe.has("importacoes")) {
    const erros = db.prepare(
      "SELECT id, tipo, arquivo_nome, iniciado_em, erro FROM importacoes WHERE status = 'erro' ORDER BY id DESC LIMIT 5"
    ).all();
    if (erros.length) console.log("últimas importações recusadas:");
    for (const e of erros) console.log(`  #${e.id} ${e.iniciado_em} ${e.tipo} "${e.arquivo_nome}": ${e.erro}`);
  }
  db.close();
}

async function main() {
  if (cmd === "conferir") return conferir();
  if (cmd === "checkpoint") {
    const db = new Database(caminho, { fileMustExist: true });
    // TRUNCATE: passa tudo do -wal para o .db e zera o -wal. busy = 1 quer
    // dizer que um leitor impediu o checkpoint completo — repetir.
    const [r] = db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    console.log(`checkpoint: busy=${r.busy} log=${r.log} checkpointed=${r.checkpointed}`);
    console.log(`tamanhos    ${tamanhos()}`);
    if (r.busy) sair("checkpoint incompleto (busy) — rode de novo");
    return;
  }
  if (cmd === "backup") {
    if (!destino) sair("backup precisa de <destino.db>");
    const alvo = path.resolve(destino);
    if (fs.existsSync(alvo)) sair(`${alvo} já existe — não sobrescrevo backup`);
    const db = new Database(caminho, { readonly: true, fileMustExist: true });
    // API de backup online do SQLite: cópia consistente mesmo com o app
    // gravando, num arquivo único (sem -wal).
    await db.backup(alvo);
    db.close();
    console.log(`backup: ${alvo} (${fs.statSync(alvo).size} B)`);
    return;
  }
  sair(`comando desconhecido: ${cmd}`);
}

main().catch((e) => sair(e.message));
