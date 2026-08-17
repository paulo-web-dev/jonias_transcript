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

// ---------- Rate limit progressivo do login ----------
// Persistido em SQLite (tabela login_bloqueios) para sobreviver a restart.
// Duas chaves por tentativa: por IP e por login. A partir da 5ª falha em
// qualquer chave, bloqueia por 30 s, dobrando a cada falha até 15 min.
// Sucesso limpa as duas chaves.

const MAX_FALHAS_LIVRES = 4;
const BLOQUEIO_BASE_MS = 30 * 1000;
const BLOQUEIO_TETO_MS = 15 * 60 * 1000;

function chavesDeLogin(ip, login) {
  const chaves = [`ip:${ip}`];
  if (login) chaves.push(`login:${login.toLowerCase()}`);
  return chaves;
}

function bloqueioAtivo(chaves) {
  const consultar = db.prepare("SELECT bloqueado_ate FROM login_bloqueios WHERE chave = ?");
  const agora = Date.now();
  return chaves.some((chave) => {
    const registro = consultar.get(chave);
    return registro?.bloqueado_ate && Date.parse(registro.bloqueado_ate) > agora;
  });
}

function registrarFalha(chaves) {
  const incrementar = db.prepare(
    `INSERT INTO login_bloqueios (chave, falhas) VALUES (?, 1)
     ON CONFLICT(chave) DO UPDATE SET falhas = falhas + 1
     RETURNING falhas`
  );
  const bloquear = db.prepare("UPDATE login_bloqueios SET bloqueado_ate = ? WHERE chave = ?");
  for (const chave of chaves) {
    const { falhas } = incrementar.get(chave);
    const excesso = falhas - MAX_FALHAS_LIVRES;
    if (excesso > 0) {
      const ms = Math.min(BLOQUEIO_TETO_MS, BLOQUEIO_BASE_MS * 2 ** (excesso - 1));
      bloquear.run(new Date(Date.now() + ms).toISOString(), chave);
    }
  }
}

function limparFalhas(chaves) {
  const apagar = db.prepare("DELETE FROM login_bloqueios WHERE chave = ?");
  for (const chave of chaves) apagar.run(chave);
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

module.exports = {
  hashSenha,
  verificarSenha,
  verificarSenhaFantasma,
  semearAdmin,
  chavesDeLogin,
  bloqueioAtivo,
  registrarFalha,
  limparFalhas,
};
