"use strict";

require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const SqliteStore = require("better-sqlite3-session-store")(session);
const Anthropic = require("@anthropic-ai/sdk");

const db = require("./db.js");
const {
  verificarSenha,
  verificarSenhaFantasma,
  semearAdmin,
  chavesDeLogin,
  bloqueioAtivo,
  registrarFalha,
  limparFalhas,
} = require("./auth.js");
const { gerarPdf, gerarDocx, nomeDeArquivo } = require("./exportacao.js");
const { importarCdr, importarOportunidadesOmie } = require("./importacao.js");
const { sincronizarMysql, credenciaisMysql } = require("./sincronizacao.js");
const { calcularMetricas, diasUteis, saudeDosDados, dadosTv } = require("./metricas.js");

const app = express();
const PORT = process.env.PORT || 8000;
const MODELO = "claude-haiku-4-5";

app.use(express.json({ limit: "2mb" }));

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "\n⚠  ANTHROPIC_API_KEY não encontrada. Copie .env.example para .env e adicione sua chave.\n"
  );
}
if (!process.env.SESSION_SECRET) {
  console.error(
    "✖  SESSION_SECRET é obrigatório no .env — o servidor não sobe sem ele.\n" +
      "   Gere um valor aleatório com:\n" +
      "   node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"\n"
  );
  process.exit(1);
}

// Atrás de proxy reverso (nginx/caddy): respeita X-Forwarded-* para req.ip
// e para o cookie `secure` funcionar.
app.set("trust proxy", 1);

app.use(
  session({
    // Sessões persistidas no mesmo SQLite (tabela sessions): sobrevivem a
    // restart e substituem o MemoryStore, que não serve para produção.
    store: new SqliteStore({
      client: db,
      expired: { clear: true, intervalMs: 15 * 60 * 1000 },
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 12, // 12 horas
    },
  })
);

const anthropic = new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente

// ---------- Arquivos estáticos (somente css/js — páginas passam pelo login) ----------
app.use("/css", express.static(path.join(__dirname, "css")));
app.use("/js", express.static(path.join(__dirname, "js")));

// ---------- Autenticação ----------

// Carrega o usuário da sessão; sessão órfã (usuário removido/inativo) não vale.
function usuarioDaSessao(req) {
  if (!req.session.usuarioId) return null;
  return (
    db
      .prepare("SELECT id, login, nome, papel FROM usuarios WHERE id = ? AND ativo = 1")
      .get(req.session.usuarioId) || null
  );
}

function exigirLoginPagina(req, res, next) {
  const usuario = usuarioDaSessao(req);
  if (usuario) {
    req.usuario = usuario;
    return next();
  }
  req.session.destroy(() => res.redirect("/login"));
}

function exigirLoginApi(req, res, next) {
  const usuario = usuarioDaSessao(req);
  if (usuario) {
    req.usuario = usuario;
    return next();
  }
  req.session.destroy(() =>
    res.status(401).json({ error: "Não autenticado. Faça login novamente." })
  );
}

app.get("/login", (req, res) => {
  if (usuarioDaSessao(req)) return res.redirect("/aulas");
  res.sendFile(path.join(__dirname, "login.html"));
});

app.post("/api/login", async (req, res) => {
  const usuario = String(req.body?.usuario || "").trim();
  const senha = String(req.body?.senha || "");

  const chaves = chavesDeLogin(req.ip, usuario);
  if (bloqueioAtivo(chaves)) {
    return res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos." });
  }

  const conta = usuario
    ? db.prepare("SELECT * FROM usuarios WHERE login = ?").get(usuario)
    : undefined;
  // Login inexistente verifica um hash de sacrifício para o tempo de resposta
  // não revelar se o usuário existe.
  const senhaOk = conta
    ? await verificarSenha(conta.senha_hash, senha)
    : await verificarSenhaFantasma(senha);

  if (!conta || !senhaOk || !conta.ativo) {
    registrarFalha(chaves);
    return res.status(401).json({ error: "Usuário ou senha incorretos." });
  }

  limparFalhas(chaves);
  req.session.usuarioId = conta.id;
  req.session.papel = conta.papel;
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- Modo TV (fora do auth de sessão: token de dispositivo) ----------
// A tela fica exposta numa sala — o payload é tratado como público e o corte
// do que aparece é feito no servidor (dadosTv não contém receita por
// consultor, taxa/TMA individual nem qualquer comparativo qualitativo).
function tokenTvValido(req) {
  const esperado = process.env.TV_TOKEN;
  if (!esperado) return null; // modo TV desabilitado
  const recebido = String(req.query.token || "");
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get("/tv", (req, res) => {
  const ok = tokenTvValido(req);
  if (ok === null) return res.status(503).send("Modo TV desabilitado — defina TV_TOKEN no .env.");
  if (!ok) return res.status(401).send("Token inválido.");
  res.sendFile(path.join(__dirname, "tv.html"));
});

app.get("/api/tv/dados", (req, res) => {
  const ok = tokenTvValido(req);
  if (ok === null) return res.status(503).json({ error: "Modo TV desabilitado." });
  if (!ok) return res.status(401).json({ error: "Token inválido." });
  res.json(dadosTv());
});

// Todas as demais rotas /api/* exigem login
app.use("/api", exigirLoginApi);

// ---------- Páginas internas ----------

app.get("/", exigirLoginPagina, (req, res) => res.redirect("/aulas"));
app.get("/aulas", exigirLoginPagina, (req, res) =>
  res.sendFile(path.join(__dirname, "aulas.html"))
);
app.get("/aula-ao-vivo", exigirLoginPagina, (req, res) =>
  res.sendFile(path.join(__dirname, "index.html"))
);
app.get("/aula", exigirLoginPagina, (req, res) =>
  res.sendFile(path.join(__dirname, "aula-view.html"))
);
app.get("/central", exigirLoginPagina, (req, res) =>
  res.sendFile(path.join(__dirname, "central.html"))
);
app.get("/relatorios", exigirLoginPagina, (req, res) =>
  res.sendFile(path.join(__dirname, "relatorios.html"))
);
app.get("/saude", exigirLoginPagina, (req, res) =>
  res.sendFile(path.join(__dirname, "saude.html"))
);

// ---------- CRUD de aulas ----------

// Aula de outro usuário responde o mesmo 404 de aula inexistente — não
// revelamos que o recurso existe.
function buscarAula(id, usuarioId, res) {
  const aula = db
    .prepare("SELECT * FROM aulas WHERE id = ? AND usuario_id = ?")
    .get(id, usuarioId);
  if (!aula) {
    res.status(404).json({ error: "Aula não encontrada." });
    return null;
  }
  return aula;
}

app.get("/api/aulas", (req, res) => {
  const busca = `%${String(req.query.busca || "").trim()}%`;
  const aulas = db
    .prepare(
      `SELECT a.id, a.nome, a.data_criacao, a.status, a.duracao,
              (SELECT COUNT(*) FROM anotacoes n WHERE n.aula_id = a.id) AS total_anotacoes
       FROM aulas a
       WHERE a.usuario_id = ? AND a.nome LIKE ?
       ORDER BY a.data_criacao DESC`
    )
    .all(req.usuario.id, busca);
  res.json({ aulas });
});

app.post("/api/aulas", (req, res) => {
  const nome = String(req.body?.nome || "").trim();
  if (!nome) return res.status(400).json({ error: "Informe o nome da aula." });
  const info = db
    .prepare("INSERT INTO aulas (nome, data_criacao, usuario_id) VALUES (?, ?, ?)")
    .run(nome, new Date().toISOString(), req.usuario.id);
  res.status(201).json({ id: info.lastInsertRowid, nome });
});

app.get("/api/aulas/:id", (req, res) => {
  const aula = buscarAula(req.params.id, req.usuario.id, res);
  if (!aula) return;
  const anotacoes = db
    .prepare("SELECT id, texto, timestamp FROM anotacoes WHERE aula_id = ? ORDER BY id")
    .all(aula.id);
  res.json({ ...aula, anotacoes });
});

app.patch("/api/aulas/:id", (req, res) => {
  const aula = buscarAula(req.params.id, req.usuario.id, res);
  if (!aula) return;
  const nome = String(req.body?.nome || "").trim();
  if (!nome) return res.status(400).json({ error: "Informe o novo nome." });
  db.prepare("UPDATE aulas SET nome = ? WHERE id = ?").run(nome, aula.id);
  res.json({ ok: true });
});

app.delete("/api/aulas/:id", (req, res) => {
  const aula = buscarAula(req.params.id, req.usuario.id, res);
  if (!aula) return;
  db.prepare("DELETE FROM aulas WHERE id = ?").run(aula.id);
  res.json({ ok: true });
});

// ---------- Prompts ----------

const SYSTEM_ANOTACOES =
  'Você é um assistente que gera anotações de aula em tempo real para alunos. ' +
  'Receba o trecho transcrito e as anotações já existentes. Retorne APENAS um JSON ' +
  'no formato {"topicos": ["...", "..."]} com 2 a 5 tópicos NOVOS (não repita os ' +
  'anteriores). Ignore ruídos de transcrição e conversas irrelevantes.';

const SYSTEM_RESUMO =
  "Você é um assistente que gera resumos de aula para alunos. Receba a transcrição " +
  "completa de uma aula e retorne um resumo estruturado em Markdown, em português do Brasil, com: " +
  "um título descritivo (# ), uma seção '## Tópicos principais' em lista, uma seção " +
  "'## Conceitos-chave' com cada termo em negrito seguido de definição curta, e uma seção " +
  "'## Pontos de revisão' com itens que merecem estudo adicional ou podem cair em prova. " +
  "Retorne APENAS o Markdown, sem comentários adicionais. Ignore ruídos de transcrição.";

async function gerarResumoMarkdown(transcricao) {
  const response = await anthropic.messages.create({
    model: MODELO,
    max_tokens: 2048,
    system: SYSTEM_RESUMO,
    messages: [
      { role: "user", content: `Transcrição completa da aula:\n\n${transcricao}` },
    ],
  });
  return response.content.find((b) => b.type === "text")?.text ?? "";
}

function verificarChave(res) {
  if (process.env.ANTHROPIC_API_KEY) return true;
  res.status(500).json({
    error:
      "ANTHROPIC_API_KEY não configurada no servidor. Copie .env.example para .env, adicione sua chave e reinicie (npm start).",
  });
  return false;
}

// ---------- Anotações em tempo real ----------
// { textoNovo, anotacoesAnteriores, aulaId, transcricaoParcial } -> { topicos }
// Cada tópico é gravado no banco imediatamente. aulaId é obrigatório e precisa
// ser uma aula do usuário logado, ainda em andamento.
app.post("/api/anotacoes", async (req, res) => {
  if (!verificarChave(res)) return;
  const { textoNovo, anotacoesAnteriores, aulaId } = req.body || {};
  if (!textoNovo || !String(textoNovo).trim()) {
    return res.status(400).json({ error: "textoNovo é obrigatório" });
  }
  const idAula = Number(aulaId);
  if (!Number.isInteger(idAula) || idAula <= 0) {
    return res.status(400).json({ error: "aulaId é obrigatório" });
  }
  // Valida posse e status antes de gastar tokens com a API
  const aula = db
    .prepare("SELECT id, status FROM aulas WHERE id = ? AND usuario_id = ?")
    .get(idAula, req.usuario.id);
  if (!aula) return res.status(404).json({ error: "Aula não encontrada." });
  if (aula.status === "encerrada") {
    return res.status(409).json({ error: "A aula já foi encerrada." });
  }

  const anteriores = Array.isArray(anotacoesAnteriores) ? anotacoesAnteriores : [];
  const listaAnteriores = anteriores.length
    ? anteriores.map((t) => `- ${t}`).join("\n")
    : "(nenhuma ainda)";

  try {
    const response = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 1024,
      system: SYSTEM_ANOTACOES,
      // Garante que a resposta é um JSON válido no formato esperado
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              topicos: { type: "array", items: { type: "string" } },
            },
            required: ["topicos"],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: "user",
          content:
            `Anotações já existentes:\n${listaAnteriores}\n\n` +
            `Trecho transcrito da aula:\n${textoNovo}`,
        },
      ],
    });

    const texto = response.content.find((b) => b.type === "text")?.text ?? "{}";
    const dados = JSON.parse(texto);
    const topicos = Array.isArray(dados.topicos) ? dados.topicos : [];

    // Recheca o status na hora de gravar: a aula pode ter sido encerrada
    // enquanto a chamada à API estava em voo — gravar aqui sobrescreveria a
    // transcrição completa com uma parcial mais antiga.
    const statusAtual = db
      .prepare("SELECT status FROM aulas WHERE id = ? AND usuario_id = ?")
      .get(idAula, req.usuario.id)?.status;
    if (statusAtual !== "em_andamento") {
      return res.status(409).json({ error: "A aula já foi encerrada." });
    }

    // Persistência em tempo real: anotações e transcrição parcial vão para o
    // banco a cada bloco — se o navegador cair, perde-se no máximo o texto
    // pendente desde o último bloco.
    const { transcricaoParcial } = req.body;
    const inserir = db.prepare(
      "INSERT INTO anotacoes (aula_id, texto, timestamp) VALUES (?, ?, ?)"
    );
    const agora = new Date().toISOString();
    db.transaction(() => {
      for (const t of topicos) inserir.run(idAula, t, agora);
      if (typeof transcricaoParcial === "string" && transcricaoParcial.trim()) {
        db.prepare("UPDATE aulas SET transcricao_completa = ? WHERE id = ?").run(
          transcricaoParcial,
          idAula
        );
      }
    })();

    res.json({ topicos });
  } catch (err) {
    tratarErro("anotacoes", err, res);
  }
});

// ---------- Encerramento da aula ----------
// { transcricao, duracao } -> salva tudo e gera o resumo.
// A transcrição/duração são salvas mesmo se o resumo falhar.
app.post("/api/aulas/:id/encerrar", async (req, res) => {
  const aula = buscarAula(req.params.id, req.usuario.id, res);
  if (!aula) return;

  const transcricao = String(req.body?.transcricao || "").trim();
  const duracao = Math.max(0, Math.round(Number(req.body?.duracao) || 0));

  db.prepare(
    "UPDATE aulas SET status = 'encerrada', duracao = ?, transcricao_completa = ? WHERE id = ?"
  ).run(duracao, transcricao, aula.id);

  const palavras = transcricao.split(/\s+/).filter(Boolean).length;
  if (!process.env.ANTHROPIC_API_KEY || palavras < 20) {
    return res.json({ resumo: "", erroResumo: palavras < 20 ? null : "Chave da API não configurada." });
  }

  try {
    const resumo = await gerarResumoMarkdown(transcricao);
    db.prepare("UPDATE aulas SET resumo_md = ? WHERE id = ?").run(resumo, aula.id);
    res.json({ resumo });
  } catch (err) {
    console.error("[/api/aulas/:id/encerrar]", err.message || err);
    res.json({
      resumo: "",
      erroResumo: "A aula foi salva, mas o resumo não pôde ser gerado.",
    });
  }
});

// Rota da Etapa 2 mantida por compatibilidade
app.post("/api/resumo", async (req, res) => {
  if (!verificarChave(res)) return;
  const { transcricao } = req.body || {};
  if (!transcricao || !String(transcricao).trim()) {
    return res.status(400).json({ error: "transcricao é obrigatória" });
  }
  try {
    res.json({ resumo: await gerarResumoMarkdown(transcricao) });
  } catch (err) {
    tratarErro("resumo", err, res);
  }
});

// ---------- Exportação ----------

app.get("/api/aulas/:id/pdf", async (req, res) => {
  const aula = buscarAula(req.params.id, req.usuario.id, res);
  if (!aula) return;
  const anotacoes = db
    .prepare("SELECT texto, timestamp FROM anotacoes WHERE aula_id = ? ORDER BY id")
    .all(aula.id);
  try {
    const pdf = await gerarPdf(aula, anotacoes);
    res
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${nomeDeArquivo(aula.nome, "pdf")}"`,
      })
      .send(Buffer.from(pdf));
  } catch (err) {
    console.error("[/api/aulas/:id/pdf]", err.message || err);
    res.status(500).json({ error: "Falha ao gerar o PDF. Verifique se o Google Chrome está instalado." });
  }
});

app.get("/api/aulas/:id/docx", async (req, res) => {
  const aula = buscarAula(req.params.id, req.usuario.id, res);
  if (!aula) return;
  const anotacoes = db
    .prepare("SELECT texto, timestamp FROM anotacoes WHERE aula_id = ? ORDER BY id")
    .all(aula.id);
  try {
    const docx = await gerarDocx(aula, anotacoes);
    res
      .set({
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${nomeDeArquivo(aula.nome, "docx")}"`,
      })
      .send(docx);
  } catch (err) {
    console.error("[/api/aulas/:id/docx]", err.message || err);
    res.status(500).json({ error: "Falha ao gerar o documento Word." });
  }
});

// ---------- Central de dados: importações ----------

// Uploads chegam com o conteúdo do arquivo no corpo (nome na query string):
// CDR como text/plain (o navegador lê com file.text()); planilha do Omie como
// binário (arrayBuffer() + application/octet-stream).
const corpoCsv = express.text({ type: ["text/plain", "text/csv"], limit: "25mb" });
const corpoXlsx = express.raw({
  type: [
    "application/octet-stream",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  limit: "25mb",
});

app.post("/api/importacoes/cdr", corpoCsv, (req, res) => {
  if (typeof req.body !== "string" || !req.body.trim()) {
    return res
      .status(400)
      .json({ error: "Corpo vazio — envie o conteúdo do CSV como text/plain." });
  }
  const arquivo = String(req.query.arquivo || "cdr.csv").slice(0, 200);
  const resultado = importarCdr(req.body, arquivo, req.usuario.id);
  res.status(resultado.status === "erro" ? 422 : 200).json(resultado);
});

app.post("/api/importacoes/oportunidades", corpoXlsx, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({
      error: "Corpo vazio — envie o .xlsx do Omie como application/octet-stream.",
    });
  }
  const arquivo = String(req.query.arquivo || "oportunidades.xlsx").slice(0, 200);
  const resultado = await importarOportunidadesOmie(req.body, arquivo, req.usuario.id);
  res.status(resultado.status === "erro" ? 422 : 200).json(resultado);
});

app.post("/api/sincronizacoes/mysql", async (req, res) => {
  try {
    res.json(await sincronizarMysql(req.usuario.id));
  } catch (err) {
    if (err.semCredenciais) return res.status(503).json({ error: err.message });
    console.error("[/api/sincronizacoes/mysql]", err.message || err);
    res.status(502).json({ error: `Falha na sincronização: ${err.message}` });
  }
});

// Estado da central: última sincronização e se o MySQL está configurado
app.get("/api/sincronizacoes/status", (req, res) => {
  const ultima = db
    .prepare(
      `SELECT id, status, erro, iniciado_em, concluido_em
       FROM importacoes WHERE tipo = 'mysql' ORDER BY id DESC LIMIT 1`
    )
    .get();
  res.json({
    mysqlConfigurado: Boolean(credenciaisMysql()),
    ultimaSincronizacao: ultima || null,
    turmas: db.prepare("SELECT COUNT(*) n FROM turmas").get().n,
    matriculas: db.prepare("SELECT COUNT(*) n FROM matriculas").get().n,
  });
});

app.get("/api/importacoes", (req, res) => {
  const importacoes = db
    .prepare(
      `SELECT i.id, i.tipo, i.arquivo_nome, i.linhas_lidas, i.linhas_validas,
              i.linhas_ignoradas, i.registros_novos, i.registros_atualizados,
              i.registros_identicos, i.status, i.erro, i.iniciado_em,
              i.concluido_em, u.login AS usuario
       FROM importacoes i JOIN usuarios u ON u.id = i.usuario_id
       ORDER BY i.id DESC LIMIT 50`
    )
    .all();
  res.json({ importacoes });
});

app.get("/api/importacoes/:id", (req, res) => {
  const importacao = db
    .prepare(
      `SELECT i.*, u.login AS usuario
       FROM importacoes i JOIN usuarios u ON u.id = i.usuario_id
       WHERE i.id = ?`
    )
    .get(req.params.id);
  if (!importacao) return res.status(404).json({ error: "Importação não encontrada." });
  let detalhes = {};
  try {
    detalhes = JSON.parse(importacao.detalhes_json || "{}");
  } catch (_) {}
  res.json({ ...importacao, detalhes });
});

// ---------- Etapa 2: métricas, períodos congelados e saúde ----------

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
function validarIntervalo(de, ate, res) {
  if (!RE_DATA.test(de || "") || !RE_DATA.test(ate || "")) {
    res.status(400).json({ error: "Datas inválidas — use YYYY-MM-DD em `de` e `ate`." });
    return false;
  }
  if (ate < de) {
    res.status(400).json({ error: "`ate` não pode ser anterior a `de`." });
    return false;
  }
  return true;
}

// Cálculo ao vivo (preview). Os números defensáveis vêm dos períodos congelados.
app.get("/api/metricas", (req, res) => {
  const { de, ate } = req.query;
  if (!validarIntervalo(de, ate, res)) return;
  res.json(calcularMetricas(de, ate));
});

app.get("/api/periodos", (req, res) => {
  const periodos = db
    .prepare(
      `SELECT p.id, p.nome, p.data_inicio, p.data_fim, p.criado_em,
              COUNT(s.id) AS versoes, MAX(s.criado_em) AS congelado_em
       FROM periodos p LEFT JOIN periodo_snapshots s ON s.periodo_id = p.id
       GROUP BY p.id ORDER BY p.data_inicio DESC`
    )
    .all();
  res.json({ periodos });
});

function congelarPeriodo(periodo, usuarioId) {
  const dados = calcularMetricas(periodo.data_inicio, periodo.data_fim);
  const info = db
    .prepare(
      `INSERT INTO periodo_snapshots (periodo_id, criado_em, usuario_id, dias_uteis, dados_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(periodo.id, new Date().toISOString(), usuarioId, dados.diasUteis, JSON.stringify(dados));
  return info.lastInsertRowid;
}

// Criar um período congela imediatamente (snapshot v1): consultar depois
// devolve sempre os mesmos números, mesmo que novos dados tenham entrado.
app.post("/api/periodos", (req, res) => {
  const nome = String(req.body?.nome || "").trim().slice(0, 120);
  const de = String(req.body?.de || "");
  const ate = String(req.body?.ate || "");
  if (!nome) return res.status(400).json({ error: "Informe o nome do período." });
  if (!validarIntervalo(de, ate, res)) return;
  try {
    const resultado = db.transaction(() => {
      const info = db
        .prepare("INSERT INTO periodos (nome, data_inicio, data_fim, criado_em) VALUES (?, ?, ?, ?)")
        .run(nome, de, ate, new Date().toISOString());
      const periodo = { id: info.lastInsertRowid, data_inicio: de, data_fim: ate };
      congelarPeriodo(periodo, req.usuario.id);
      return periodo.id;
    })();
    res.status(201).json({ id: resultado });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "Já existe um período com essas datas." });
    }
    console.error("[/api/periodos]", err.message);
    res.status(500).json({ error: "Falha ao criar o período." });
  }
});

// Snapshot vigente (ou uma versão específica via ?versao=) + trilha de versões
app.get("/api/periodos/:id", (req, res) => {
  const periodo = db.prepare("SELECT * FROM periodos WHERE id = ?").get(req.params.id);
  if (!periodo) return res.status(404).json({ error: "Período não encontrado." });
  const versoes = db
    .prepare(
      `SELECT s.id, s.criado_em, s.dias_uteis, u.login AS usuario
       FROM periodo_snapshots s JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.periodo_id = ? ORDER BY s.id`
    )
    .all(periodo.id);
  const versaoId = req.query.versao ? Number(req.query.versao) : versoes.at(-1)?.id;
  const snapshot = db
    .prepare("SELECT * FROM periodo_snapshots WHERE id = ? AND periodo_id = ?")
    .get(versaoId, periodo.id);
  if (!snapshot) return res.status(404).json({ error: "Versão não encontrada." });
  res.json({
    periodo,
    versoes,
    versaoAtual: snapshot.id,
    congeladoEm: snapshot.criado_em,
    dados: JSON.parse(snapshot.dados_json),
  });
});

// Recongelar: recalcula e grava NOVA versão — as anteriores ficam guardadas
app.post("/api/periodos/:id/recongelar", (req, res) => {
  const periodo = db.prepare("SELECT * FROM periodos WHERE id = ?").get(req.params.id);
  if (!periodo) return res.status(404).json({ error: "Período não encontrado." });
  const snapshotId = congelarPeriodo(periodo, req.usuario.id);
  res.json({ ok: true, snapshotId });
});

app.delete("/api/periodos/:id", (req, res) => {
  const info = db.prepare("DELETE FROM periodos WHERE id = ?").run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: "Período não encontrado." });
  res.json({ ok: true });
});

app.get("/api/saude", (req, res) => {
  res.json(saudeDosDados());
});

// ---------- Erros ----------

function tratarErro(rota, err, res) {
  console.error(`[/api/${rota}]`, err.message || err);
  if (err instanceof Anthropic.AuthenticationError) {
    return res.status(500).json({
      error: "Chave da API inválida ou ausente. Verifique o arquivo .env (ANTHROPIC_API_KEY).",
    });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return res.status(429).json({
      error: "Limite de requisições atingido. Aguarde alguns instantes.",
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return res.status(502).json({ error: "Falha de conexão com a API da Anthropic." });
  }
  if (err instanceof Anthropic.APIError) {
    return res.status(502).json({ error: `Erro da API da Anthropic (${err.status}).` });
  }
  return res.status(500).json({ error: "Erro interno ao processar a solicitação." });
}

(async () => {
  await semearAdmin(); // garante o primeiro admin e adota aulas sem dono
  app.listen(PORT, () => {
    console.log(`jonIAs — Assistente de Aulas rodando em http://localhost:${PORT}`);
  });
})().catch((err) => {
  console.error("✖  Falha ao iniciar o servidor:", err.message || err);
  process.exit(1);
});
