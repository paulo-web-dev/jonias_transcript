"use strict";

const argon2 = require("argon2");
const db = require("./db.js");

// ---------- Hash de senha (argon2id) ----------

function hashSenha(senha) {
  return argon2.hash(senha, { type: argon2.argon2id });
}

async function verificarSenha(hash, senha) {
  try {
    return await argon2.verify(hash, senha);
  } catch (_) {
    return false; // hash corrompido/formato inválido conta como senha errada
  }
}

// Hash de sacrifício: verificado quando o login não existe, para o tempo de
// resposta não revelar se o usuário está cadastrado.
const hashFantasmaPromise = hashSenha("senha-fantasma-anti-timing");

async function verificarSenhaFantasma(senha) {
  await verificarSenha(await hashFantasmaPromise, senha);
  return false;
}

// ---------- Seed do primeiro admin ----------
// Idempotente, roda a cada startup: se não há usuários, cria o admin a partir
// de ADMIN_USER/ADMIN_PASS do .env; depois adota as aulas sem dono (criadas
// antes da migração para multiusuário).

async function semearAdmin() {
  const total = db.prepare("SELECT COUNT(*) AS n FROM usuarios").get().n;
  let adminId;

  if (total === 0) {
    const { ADMIN_USER, ADMIN_PASS } = process.env;
    if (!ADMIN_USER || !ADMIN_PASS) {
      console.error(
        "✖  Nenhum usuário cadastrado e ADMIN_USER/ADMIN_PASS ausentes no .env —\n" +
          "   impossível criar o primeiro admin. Configure-os e reinicie (npm start).\n"
      );
      process.exit(1);
    }
    const info = db
      .prepare(
        "INSERT INTO usuarios (login, senha_hash, nome, papel, ativo, criado_em) VALUES (?, ?, ?, 'admin', 1, ?)"
      )
      .run(ADMIN_USER, await hashSenha(ADMIN_PASS), ADMIN_USER, new Date().toISOString());
    adminId = info.lastInsertRowid;
    console.log(`Primeiro admin "${ADMIN_USER}" criado a partir do .env.`);
  } else {
    adminId = db
      .prepare("SELECT id FROM usuarios WHERE papel = 'admin' ORDER BY id LIMIT 1")
      .get()?.id;
  }

  if (adminId) {
    const { changes } = db
      .prepare("UPDATE aulas SET usuario_id = ? WHERE usuario_id IS NULL")
      .run(adminId);
    if (changes > 0) console.log(`${changes} aula(s) existente(s) atribuída(s) ao admin.`);
  }
}

module.exports = { hashSenha, verificarSenha, verificarSenhaFantasma, semearAdmin };
