"use strict";

// Sincronização do MySQL da Unyflex → cópia local em SQLite.
// O acesso NÃO é ao vivo: este job copia turmas (classes) e matrículas
// (enrollments + students) como snapshot substituído em transação única —
// relatórios leem sempre a cópia local (números reproduzíveis, zero carga na
// produção fora da janela de sync). O usuário MySQL é exclusivo e somente
// SELECT; credenciais no .env; nunca há escrita na origem.

const mysql = require("mysql2/promise");
const db = require("./db.js");
const { normalizarNome } = require("./importacao.js");

// Filtro de curso válido definido pelo negócio
const FILTRO_CLASSES = "unyflex = 0 AND id > 1200 AND status = 'able'";

function credenciaisMysql() {
  const { MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE } = process.env;
  if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_PASSWORD || !MYSQL_DATABASE) return null;
  return {
    host: MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    connectTimeout: 10000,
    dateStrings: true, // datas como texto, sem conversão de fuso
  };
}

// "YYYY-MM-DD HH:MM:SS" (dateStrings) → ISO local do modelo canônico
function dataMysqlIso(texto) {
  const t = String(texto ?? "").trim();
  return t ? t.replace(" ", "T") : null;
}

// Em erro de coluna inexistente, anexa as colunas reais da tabela para
// facilitar o ajuste (o esquema exato só se confirma no primeiro sync real).
async function enriquecerErroDeColuna(conexao, err) {
  if (err.code !== "ER_BAD_FIELD_ERROR") return err;
  try {
    const colunas = {};
    for (const tabela of ["classes", "enrollments", "students"]) {
      const [linhas] = await conexao.query(`SHOW COLUMNS FROM \`${tabela}\``);
      colunas[tabela] = linhas.map((l) => l.Field).join(", ");
    }
    err.message += ` — colunas disponíveis: ${JSON.stringify(colunas)}`;
  } catch (_) {
    /* mantém o erro original */
  }
  return err;
}

async function sincronizarMysql(usuarioId) {
  const iniciadoEm = new Date().toISOString();
  const cred = credenciaisMysql();
  if (!cred) {
    const err = new Error(
      "Sincronização indisponível: configure MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD e " +
        "MYSQL_DATABASE no .env (usuário exclusivo, somente SELECT) e reinicie o servidor."
    );
    err.semCredenciais = true;
    throw err;
  }

  let conexao;
  let turmas;
  let matriculas;
  try {
    conexao = await mysql.createConnection(cred);
    try {
      [turmas] = await conexao.query(
        `SELECT id, name, start_date FROM classes WHERE ${FILTRO_CLASSES}`
      );
      [matriculas] = await conexao.query(
        `SELECT e.id, e.classes_id, e.student_id, e.wallet, e.created_at,
                s.name AS aluno_nome, s.email AS aluno_email,
                s.phone AS aluno_telefone, s.city AS aluno_cidade
         FROM enrollments e
         JOIN students s ON s.id = e.student_id
         WHERE e.classes_id IN (SELECT id FROM classes WHERE ${FILTRO_CLASSES})`
      );
    } catch (err) {
      throw await enriquecerErroDeColuna(conexao, err);
    }
  } catch (err) {
    registrarErroDeSync(usuarioId, iniciadoEm, err);
    throw err;
  } finally {
    if (conexao) await conexao.end().catch(() => {});
  }

  // Resolve o vendedor pelo wallet (nome), tolerando "Nome Sobrenome"
  const pessoas = db.prepare("SELECT id, wallet_nome FROM pessoas WHERE wallet_nome IS NOT NULL").all();
  const pessoaPorWallet = new Map(pessoas.map((p) => [normalizarNome(p.wallet_nome), p.id]));
  const walletsSemMatch = new Map();
  function resolverWallet(wallet) {
    if (!wallet) return null;
    const norm = normalizarNome(wallet);
    const id = pessoaPorWallet.get(norm) ?? pessoaPorWallet.get(norm.split(" ")[0]) ?? null;
    if (id === null) walletsSemMatch.set(wallet, (walletsSemMatch.get(wallet) || 0) + 1);
    return id;
  }

  const agora = new Date().toISOString();
  const inserirTurma = db.prepare(
    "INSERT INTO turmas (id, nome, start_date, sincronizado_em) VALUES (?, ?, ?, ?)"
  );
  const inserirMatricula = db.prepare(
    `INSERT INTO matriculas (id, turma_id, student_id, aluno_nome, aluno_email,
       aluno_telefone, aluno_cidade, wallet, pessoa_id, criada_em, sincronizado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const importacaoId = db.transaction(() => {
    // Snapshot full-replace: a cópia local é sempre o retrato da origem
    db.prepare("DELETE FROM matriculas").run();
    db.prepare("DELETE FROM turmas").run();

    for (const t of turmas) {
      inserirTurma.run(t.id, t.name ?? null, dataMysqlIso(t.start_date), agora);
    }
    for (const m of matriculas) {
      inserirMatricula.run(
        m.id,
        m.classes_id,
        m.student_id ?? null,
        m.aluno_nome ?? null,
        m.aluno_email ?? null,
        m.aluno_telefone ?? null,
        m.aluno_cidade ?? null,
        m.wallet ?? null,
        resolverWallet(m.wallet),
        dataMysqlIso(m.created_at),
        agora
      );
    }

    const detalhes = {
      motivos: {},
      problemas: Object.fromEntries(
        walletsSemMatch.size
          ? [["wallet_sem_match", {
              qtde: [...walletsSemMatch.values()].reduce((a, b) => a + b, 0),
              amostras: [...walletsSemMatch.entries()].slice(0, 20).map(([w, n]) => `"${w}" (${n}x)`),
            }]]
          : []
      ),
      avisos: [],
    };

    const info = db
      .prepare(
        `INSERT INTO importacoes (tipo, usuario_id, iniciado_em, concluido_em,
           linhas_lidas, linhas_validas, registros_novos, detalhes_json)
         VALUES ('mysql', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        usuarioId,
        iniciadoEm,
        new Date().toISOString(),
        turmas.length + matriculas.length,
        turmas.length + matriculas.length,
        turmas.length + matriculas.length,
        JSON.stringify(detalhes)
      );
    return info.lastInsertRowid;
  })();

  return {
    status: "concluida",
    importacaoId,
    tipo: "mysql",
    turmas: turmas.length,
    matriculas: matriculas.length,
    walletsSemMatch: Object.fromEntries(walletsSemMatch),
    sincronizadoEm: agora,
  };
}

function registrarErroDeSync(usuarioId, iniciadoEm, err) {
  try {
    db.prepare(
      `INSERT INTO importacoes (tipo, usuario_id, iniciado_em, concluido_em, status, erro)
       VALUES ('mysql', ?, ?, ?, 'erro', ?)`
    ).run(usuarioId, iniciadoEm, new Date().toISOString(), String(err.message || err));
  } catch (_) {
    /* auditoria de erro é melhor-esforço */
  }
}

module.exports = { sincronizarMysql, credenciaisMysql };
