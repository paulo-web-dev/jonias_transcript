"use strict";

// Sincronização do MySQL da Unyflex → cópia local em SQLite.
// O acesso NÃO é ao vivo: este job copia turmas (classes) e matrículas
// (enrollments + students) para o SQLite e os relatórios leem sempre a cópia
// local (números reproduzíveis, zero carga na produção fora da janela de
// sync). O usuário MySQL é exclusivo e somente SELECT — apenas nas tabelas
// classes, enrollments e students; nunca há escrita na origem.
//
// Estratégia: turmas são poucas (centenas) e vêm inteiras a cada sync
// (upsert, nunca DELETE — matrículas antigas continuam apontando para elas);
// matrículas são incrementais por enrollments.updated_at a partir do último
// sync bem-sucedido, com margem de 3 dias contra diferenças de fuso/relógio.
// O primeiro sync traz tudo. Upsert por id preserva as colunas do cruzamento.
// Após copiar, o cruzamento matrícula ↔ oportunidade roda só no SQLite.

const mysql = require("mysql2/promise");
const db = require("./db.js");
const { normalizarNome, normalizarTelefone } = require("./importacao.js");

// Filtro de curso válido definido pelo negócio
const FILTRO_CLASSES = "unyflex = 0 AND id > 1200 AND status = 'able'";

const TIMEOUT_QUERY_MS = 30000; // consulta que passar disso falha explícito, sem travar o app
const MARGEM_INCREMENTAL_DIAS = 3;

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
// facilitar o ajuste.
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

// Corte incremental: último sync bem-sucedido menos a margem, como
// "YYYY-MM-DD" (enrollments.updated_at é timestamp local da origem — a margem
// em dias absorve fuso e relógio).
function corteIncremental() {
  const ultimo = db
    .prepare(
      `SELECT concluido_em FROM importacoes
       WHERE tipo = 'mysql' AND status = 'concluida' ORDER BY id DESC LIMIT 1`
    )
    .get();
  if (!ultimo?.concluido_em) return null;
  const d = new Date(ultimo.concluido_em);
  if (isNaN(d)) return null;
  d.setDate(d.getDate() - MARGEM_INCREMENTAL_DIAS);
  return d.toISOString().slice(0, 10);
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

  const corte = corteIncremental();
  let conexao;
  let turmas;
  let matriculas;
  try {
    conexao = await mysql.createConnection(cred);
    try {
      [turmas] = await conexao.query({
        sql: `SELECT id, title, subtitle, start_date, end_date
              FROM classes WHERE ${FILTRO_CLASSES}`,
        timeout: TIMEOUT_QUERY_MS,
      });
      [matriculas] = await conexao.query({
        sql: `SELECT e.id, e.classes_id, e.student_id, e.wallet, e.status,
                     e.final_value, e.created_at,
                     s.name AS aluno_nome, s.email AS aluno_email,
                     s.phone AS aluno_telefone, s.city AS aluno_cidade
              FROM enrollments e
              LEFT JOIN students s ON s.id = e.student_id
              WHERE e.classes_id IN (SELECT id FROM classes WHERE ${FILTRO_CLASSES})
              ${corte ? "AND e.updated_at >= ?" : ""}`,
        timeout: TIMEOUT_QUERY_MS,
        values: corte ? [corte] : [],
      });
    } catch (err) {
      throw await enriquecerErroDeColuna(conexao, err);
    }
  } catch (err) {
    registrarErroDeSync(usuarioId, iniciadoEm, err);
    throw err;
  } finally {
    if (conexao) await conexao.end().catch(() => {});
  }

  // Vendedor pelo wallet: match exato do nome normalizado contra nome +
  // nomes_alternativos — sem palpite por primeiro nome; o que não casar é
  // listado no relatório (é onde a atribuição de venda quebra em silêncio).
  const pessoas = db
    .prepare("SELECT id, nome, wallet_nome, nomes_alternativos FROM pessoas")
    .all();
  const pessoaPorNome = new Map();
  for (const p of pessoas) {
    pessoaPorNome.set(normalizarNome(p.nome), p.id);
    if (p.wallet_nome) pessoaPorNome.set(normalizarNome(p.wallet_nome), p.id);
    for (const alt of JSON.parse(p.nomes_alternativos || "[]")) {
      pessoaPorNome.set(normalizarNome(alt), p.id);
    }
  }
  const walletsSemMatch = new Map();
  function resolverWallet(wallet) {
    if (!wallet || !String(wallet).trim()) return null;
    const id = pessoaPorNome.get(normalizarNome(wallet)) ?? null;
    if (id === null) walletsSemMatch.set(wallet, (walletsSemMatch.get(wallet) || 0) + 1);
    return id;
  }

  const agora = new Date().toISOString();
  const upsertTurma = db.prepare(
    `INSERT INTO turmas (id, nome, subtitulo, start_date, end_date, sincronizado_em)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET nome = excluded.nome, subtitulo = excluded.subtitulo,
       start_date = excluded.start_date, end_date = excluded.end_date,
       sincronizado_em = excluded.sincronizado_em`
  );
  // Upsert que NÃO toca oportunidade_id/match_* — o cruzamento é recalculado
  // depois, mas nunca se perde por causa da cópia.
  const upsertMatricula = db.prepare(
    `INSERT INTO matriculas (id, turma_id, student_id, aluno_nome, aluno_email,
       aluno_telefone, aluno_cidade, wallet, pessoa_id, status, valor_centavos,
       criada_em, sincronizado_em)
     VALUES (@id, @turma_id, @student_id, @aluno_nome, @aluno_email,
       @aluno_telefone, @aluno_cidade, @wallet, @pessoa_id, @status,
       @valor_centavos, @criada_em, @sincronizado_em)
     ON CONFLICT(id) DO UPDATE SET turma_id = excluded.turma_id,
       student_id = excluded.student_id, aluno_nome = excluded.aluno_nome,
       aluno_email = excluded.aluno_email, aluno_telefone = excluded.aluno_telefone,
       aluno_cidade = excluded.aluno_cidade, wallet = excluded.wallet,
       pessoa_id = excluded.pessoa_id, status = excluded.status,
       valor_centavos = excluded.valor_centavos, criada_em = excluded.criada_em,
       sincronizado_em = excluded.sincronizado_em`
  );
  const existeMatricula = db.prepare("SELECT 1 FROM matriculas WHERE id = ?");

  let periodoDe = null;
  let periodoAte = null;
  const resultado = db.transaction(() => {
    for (const t of turmas) {
      upsertTurma.run(t.id, t.title ?? null, t.subtitle ?? null,
        dataMysqlIso(t.start_date), dataMysqlIso(t.end_date), agora);
    }
    let novas = 0;
    let atualizadas = 0;
    let semAluno = 0;
    for (const m of matriculas) {
      if (m.student_id !== null && m.aluno_nome === null) semAluno++; // student_id órfão na origem
      const criadaEm = dataMysqlIso(m.created_at);
      if (criadaEm) {
        if (!periodoDe || criadaEm < periodoDe) periodoDe = criadaEm;
        if (!periodoAte || criadaEm > periodoAte) periodoAte = criadaEm;
      }
      if (existeMatricula.get(m.id)) atualizadas++;
      else novas++;
      upsertMatricula.run({
        id: m.id,
        turma_id: m.classes_id,
        student_id: m.student_id ?? null,
        aluno_nome: m.aluno_nome ?? null,
        aluno_email: m.aluno_email ? String(m.aluno_email).trim().toLowerCase() : null,
        aluno_telefone: normalizarTelefone(m.aluno_telefone),
        aluno_cidade: m.aluno_cidade ?? null,
        wallet: m.wallet ?? null,
        pessoa_id: resolverWallet(m.wallet),
        status: m.status || null,
        valor_centavos: m.final_value === null || m.final_value === undefined
          ? null
          : Math.round(Number(m.final_value) * 100),
        criada_em: criadaEm,
        sincronizado_em: agora,
      });
    }

    const cruzamento = cruzarMatriculas();

    const detalhes = {
      motivos: {},
      problemas: Object.fromEntries([
        ...(walletsSemMatch.size
          ? [["wallet_sem_match", {
              qtde: [...walletsSemMatch.values()].reduce((a, b) => a + b, 0),
              amostras: [...walletsSemMatch.entries()].slice(0, 20).map(([w, n]) => `"${w}" (${n}x)`),
            }]]
          : []),
        ...(semAluno
          ? [["aluno_inexistente", {
              qtde: semAluno,
              amostras: ["matrículas mantidas com dados do aluno em branco (student_id sem linha em students)"],
            }]]
          : []),
      ]),
      avisos: [
        corte
          ? `Sync incremental: matrículas com updated_at >= ${corte} (último sync menos ${MARGEM_INCREMENTAL_DIAS} dias de margem).`
          : "Primeiro sync: cópia completa das matrículas de turmas válidas.",
        periodoDe
          ? `Período coberto neste lote (created_at): ${periodoDe} a ${periodoAte}.`
          : "Nenhuma matrícula nova ou alterada neste lote.",
        `Cruzamento matrícula ↔ oportunidade: ${cruzamento.porEmail} por e-mail, ` +
          `${cruzamento.porTelefone} por telefone, ${cruzamento.semOportunidade} sem oportunidade ` +
          `(mantidas — podem ser venda fora do CRM); ${cruzamento.conquistadasSemMatricula} ` +
          `oportunidade(s) Conquistada(s) sem matrícula correspondente.`,
      ],
      periodo: { de: periodoDe, ate: periodoAte },
      cruzamento,
    };

    const info = db
      .prepare(
        `INSERT INTO importacoes (tipo, usuario_id, iniciado_em, concluido_em,
           linhas_lidas, linhas_validas, registros_novos, registros_atualizados, detalhes_json)
         VALUES ('mysql', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(usuarioId, iniciadoEm, new Date().toISOString(),
        turmas.length + matriculas.length, turmas.length + matriculas.length,
        novas, atualizadas, JSON.stringify(detalhes));
    return { importacaoId: info.lastInsertRowid, novas, atualizadas, cruzamento, detalhes };
  })();

  return {
    status: "concluida",
    importacaoId: resultado.importacaoId,
    tipo: "mysql",
    turmas: turmas.length,
    matriculas: db.prepare("SELECT COUNT(*) n FROM matriculas").get().n,
    matriculasNoLote: matriculas.length,
    registrosNovos: resultado.novas,
    registrosAtualizados: resultado.atualizadas,
    periodo: { de: periodoDe, ate: periodoAte },
    cruzamento: resultado.cruzamento,
    detalhes: resultado.detalhes,
    sincronizadoEm: agora,
  };
}

// ---------- Cruzamento matrícula ↔ oportunidade (só SQLite) ----------
// Via (a) direta: wallet → pessoas (feita no upsert, via nomes_alternativos).
// Via (b) contato: e-mail exato (minúsculas) = confiança alta; telefone pelos
// últimos 9 dígitos = média, últimos 8 = baixa (DDD e nono dígito variam entre
// as bases). Matrícula sem match NUNCA é descartada — fica com
// oportunidade_id NULL (pode ser venda de canal que não passa pelo CRM).
function cruzarMatriculas() {
  const oportunidades = db
    .prepare(
      `SELECT id, email, telefone, celular_1, celular_2, status, incluido_em
       FROM oportunidades`
    )
    .all();
  const porEmail = new Map();
  const porFone9 = new Map();
  const porFone8 = new Map();
  const indexar = (mapa, chave, o) => {
    if (!chave) return;
    (mapa.get(chave) ?? mapa.set(chave, []).get(chave)).push(o);
  };
  for (const o of oportunidades) {
    indexar(porEmail, o.email ? o.email.toLowerCase() : null, o);
    for (const fone of [o.telefone, o.celular_1, o.celular_2]) {
      const d = String(fone || "").replace(/\D/g, "");
      if (d.length >= 8) {
        indexar(porFone8, d.slice(-8), o);
        if (d.length >= 9) indexar(porFone9, d.slice(-9), o);
      }
    }
  }
  // Entre candidatas, prefere Conquistada e depois a mais recente
  const escolher = (cands) =>
    [...cands].sort((a, b) =>
      (b.status === "Conquistado") - (a.status === "Conquistado") ||
      String(b.incluido_em || "").localeCompare(String(a.incluido_em || ""))
    )[0];

  const atualizar = db.prepare(
    "UPDATE matriculas SET oportunidade_id = ?, match_metodo = ?, match_confianca = ? WHERE id = ?"
  );
  const matriculas = db
    .prepare("SELECT id, aluno_email, aluno_telefone FROM matriculas")
    .all();

  let porEmailN = 0;
  let porTelefoneN = 0;
  let sem = 0;
  for (const m of matriculas) {
    let alvo = null;
    let metodo = null;
    let confianca = null;
    const email = m.aluno_email ? m.aluno_email.toLowerCase().trim() : null;
    if (email && porEmail.has(email)) {
      alvo = escolher(porEmail.get(email));
      metodo = "email";
      confianca = "alta";
      porEmailN++;
    } else {
      const d = String(m.aluno_telefone || "").replace(/\D/g, "");
      if (d.length >= 9 && porFone9.has(d.slice(-9))) {
        alvo = escolher(porFone9.get(d.slice(-9)));
        metodo = "telefone";
        confianca = "media";
        porTelefoneN++;
      } else if (d.length >= 8 && porFone8.has(d.slice(-8))) {
        alvo = escolher(porFone8.get(d.slice(-8)));
        metodo = "telefone";
        confianca = "baixa";
        porTelefoneN++;
      }
    }
    if (!alvo) sem++;
    atualizar.run(alvo ? alvo.id : null, metodo, confianca, m.id);
  }

  const conquistadasSemMatricula = db
    .prepare(
      `SELECT COUNT(*) n FROM oportunidades o
       WHERE o.status = 'Conquistado'
         AND NOT EXISTS (SELECT 1 FROM matriculas m WHERE m.oportunidade_id = o.id)`
    )
    .get().n;

  return {
    matriculas: matriculas.length,
    porEmail: porEmailN,
    porTelefone: porTelefoneN,
    semOportunidade: sem,
    conquistadasSemMatricula,
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

module.exports = { sincronizarMysql, credenciaisMysql, cruzarMatriculas };
