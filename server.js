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
const {
  calcularMetricas, diasUteis, saudeDosDados, dadosTvCompleto,
  resumoMetas, gravarMetas, INDICADORES, INDICADORES_RECEITA, configBool,
  metricasDaPessoa, resumoMetasDaPessoa,
} = require("./metricas.js");
const { prepararFatosFeedback, gerarFeedbackMarkdown } = require("./feedback.js");
const territorio = require("./territorio.js");
const prospeccao = require("./prospeccao.js");
const cruzamento = require("./cruzamento.js");
const { PAPEIS, escopoDe, exigirAdmin, exigirSenhaTrocada, paginaInicialDe } = require("./escopo.js");
const { hashSenha, gerarSenhaInicial, validarSenhaNova } = require("./auth.js");

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
      .prepare("SELECT id, login, nome, papel, pessoa_id, senha_temporaria FROM usuarios WHERE id = ? AND ativo = 1")
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
  const u = usuarioDaSessao(req);
  if (u) return res.redirect(u.senha_temporaria ? "/trocar-senha" : paginaInicialDe(u));
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
  db.prepare("UPDATE usuarios SET ultimo_acesso_em = ? WHERE id = ?").run(new Date().toISOString(), conta.id);
  // Sessão nova a cada login (anti-fixação): o id do cookie muda
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Falha ao iniciar a sessão." });
    req.session.usuarioId = conta.id;
    req.session.papel = conta.papel;
    res.json({
      ok: true, papel: conta.papel, trocarSenha: Boolean(conta.senha_temporaria),
      destino: conta.senha_temporaria ? "/trocar-senha" : paginaInicialDe(conta),
    });
  });
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

// Preferência global de som das TVs (configuracoes.tv_som): alterada pelas
// telas autenticadas, lida aqui junto com o payload — a TV segue no próximo
// refetch (SSE ou polling). `?som=` na URL da TV é override por dispositivo.
const configSomTv = () =>
  db.prepare("SELECT valor FROM configuracoes WHERE chave = 'tv_som'").get()?.valor === "1";

app.get("/api/tv/dados", (req, res) => {
  const ok = tokenTvValido(req);
  if (ok === null) return res.status(503).json({ error: "Modo TV desabilitado." });
  if (!ok) return res.status(401).json({ error: "Token inválido." });
  res.json({ ...dadosTvCompleto(), som: configSomTv() });
});

// SSE: empurra "dados atualizados" para as TVs quando uma ingestão termina.
// A TV refaz o fetch e decide sozinha o que animar/celebrar (diff no cliente).
const conexoesTv = new Set();

app.get("/api/tv/eventos", (req, res) => {
  const ok = tokenTvValido(req);
  if (ok === null) return res.status(503).json({ error: "Modo TV desabilitado." });
  if (!ok) return res.status(401).json({ error: "Token inválido." });
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // proxies não devem bufferizar o stream
  });
  res.write(": conectado\n\n");
  conexoesTv.add(res);
  req.on("close", () => conexoesTv.delete(res));
});

// Heartbeat-comentário mantém a conexão viva através de proxies
setInterval(() => {
  for (const res of conexoesTv) res.write(": ping\n\n");
}, 25000).unref();

// tipo "dados" = ingestão concluída (a TV avisa com pulso/toast);
// tipo "config" = metas/configuração mudaram (a TV só refaz o fetch, em silêncio)
function emitirEventoTv(fonte, tipo = "dados") {
  const evento = `data: ${JSON.stringify({ tipo, fonte })}\n\n`;
  for (const res of conexoesTv) {
    try {
      res.write(evento);
    } catch (_) {
      conexoesTv.delete(res);
    }
  }
}

// Todas as demais rotas /api/* exigem login; senha temporária bloqueia tudo
// exceto a troca; rotas de gestão são só do admin (o vendedor recebe 403 —
// e as rotas que ele usa filtram por escopo na consulta, ver escopo.js)
app.use("/api", exigirLoginApi, exigirSenhaTrocada);
const PREFIXOS_SO_ADMIN = [
  "/api/importacoes", "/api/sincronizacoes", "/api/config", "/api/periodos", "/api/saude",
  "/api/usuarios", "/api/carteiras", "/api/prospeccao/cobertura", "/api/prospeccao/gerencial", "/api/prospeccao/marcacoes",
  "/api/prospeccao/status", "/api/territorio/cobertura", "/api/territorio/pendencias",
  "/api/territorio/apelidos", "/api/resumo",
];
app.use("/api", (req, res, next) => {
  const caminho = req.originalUrl.split("?")[0];
  const escrita = req.method !== "GET";
  const soAdmin =
    PREFIXOS_SO_ADMIN.some((p) => caminho === p || caminho.startsWith(p + "/")) ||
    (escrita && (caminho === "/api/metas" || caminho.startsWith("/api/metas/"))) ||
    (escrita && caminho.startsWith("/api/prospeccao/cores")) ||
    (escrita && caminho.startsWith("/api/prospeccao/cdr")) ||
    (escrita && /^\/api\/territorio\/municipios\/[^/]+\/principal$/.test(caminho));
  if (soAdmin) return exigirAdmin(req, res, next);
  next();
});

// ---------- Configurações globais (só telas autenticadas) ----------

app.get("/api/config/tv", (req, res) => res.json({ som: configSomTv() }));

app.put("/api/config/tv", (req, res) => {
  const { som } = req.body || {};
  if (typeof som !== "boolean") {
    return res.status(400).json({ error: "Informe { som: true|false }." });
  }
  db.prepare("UPDATE configuracoes SET valor = ? WHERE chave = 'tv_som'").run(som ? "1" : "0");
  res.json({ som });
});

// ---------- Metas (painel /metas) ----------
// Editar NUNCA sobrescreve o passado: cria vigência nova a partir da data
// escolhida e fecha a anterior no dia antes (ver gravarMetas em metricas.js).

app.get("/api/metas", (req, res) => {
  const escopo = escopoDe(req.usuario);
  if (!escopo) return res.json(resumoMetas());
  res.json(escopo.pessoaId ? resumoMetasDaPessoa(escopo.pessoaId) : { minha: null });
});

app.put("/api/metas", (req, res) => {
  const { pessoaId = null, escopo, vigenteDesde, valores } = req.body || {};
  const mapa = INDICADORES[escopo];
  if (!mapa) return res.status(400).json({ error: "Escopo inválido — use dia, semana, mes ou equipe." });
  if (!RE_DATA.test(vigenteDesde || "") || isNaN(new Date(vigenteDesde + "T00:00:00Z"))) {
    return res.status(400).json({ error: "Data de vigência inválida — use YYYY-MM-DD." });
  }
  let pessoa = null;
  if (pessoaId !== null) {
    if (escopo === "equipe") {
      return res.status(400).json({ error: "A meta da equipe não é por pessoa." });
    }
    pessoa = Number.isInteger(pessoaId)
      ? db.prepare("SELECT id, nome FROM pessoas WHERE id = ? AND tipo = 'consultor' AND ativo = 1").get(pessoaId)
      : null;
    if (!pessoa) return res.status(404).json({ error: "Consultor não encontrado." });
  }
  if (!valores || typeof valores !== "object") {
    return res.status(400).json({ error: "Informe `valores` com os indicadores a alterar." });
  }
  // Campo ausente = não mexe; null/"" = sem meta (pessoa: volta a herdar o
  // padrão); número em reais vira centavos nos indicadores de receita
  const porIndicador = {};
  for (const [campo, indicador] of Object.entries(mapa)) {
    if (!(campo in valores)) continue;
    const bruto = valores[campo];
    if (bruto === null || bruto === "") {
      porIndicador[indicador] = null;
      continue;
    }
    const n = typeof bruto === "number" ? bruto : Number(String(bruto).replace(",", "."));
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ error: `Valor inválido em "${campo}" — use um número ≥ 0.` });
    }
    porIndicador[indicador] = INDICADORES_RECEITA.has(indicador) ? Math.round(n * 100) : n;
  }
  if (!Object.keys(porIndicador).length) {
    return res.status(400).json({ error: "Nenhum indicador informado." });
  }
  try {
    const mudancas = gravarMetas({ pessoaId: pessoa?.id ?? null, vigenteDesde, valores: porIndicador });
    if (mudancas.length) emitirEventoTv("metas", "config");
    res.json({ mudancas, ...resumoMetas() });
  } catch (erro) {
    if (erro.status === 400) return res.status(400).json({ error: erro.message });
    throw erro;
  }
});

app.put("/api/metas/config", (req, res) => {
  const { incluiGerencial } = req.body || {};
  if (typeof incluiGerencial !== "boolean") {
    return res.status(400).json({ error: "Informe { incluiGerencial: true|false }." });
  }
  db.prepare(
    `INSERT INTO configuracoes (chave, valor) VALUES ('meta_equipe_inclui_gerencial', ?)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`
  ).run(incluiGerencial ? "1" : "0");
  emitirEventoTv("metas", "config");
  res.json({ incluiGerencial: configBool("meta_equipe_inclui_gerencial") });
});

// ---------- Páginas internas ----------

// Senha temporária: qualquer página interna redireciona para a troca
app.use(["/aulas", "/aula-ao-vivo", "/aula", "/central", "/relatorios", "/saude", "/metas", "/territorio", "/prospeccao", "/usuarios", "/meu-painel"],
  exigirLoginPagina, exigirSenhaTrocada);

app.get("/", exigirLoginPagina, (req, res) => res.redirect(req.usuario.senha_temporaria ? "/trocar-senha" : paginaInicialDe(req.usuario)));
app.get("/trocar-senha", exigirLoginPagina, (req, res) =>
  res.sendFile(path.join(__dirname, "trocar-senha.html"))
);
app.get("/usuarios", exigirLoginPagina, exigirAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "usuarios.html"))
);
app.get("/meu-painel", exigirLoginPagina, (req, res) =>
  res.sendFile(path.join(__dirname, "meu-painel.html"))
);
app.get("/aulas", exigirLoginPagina, (req, res) =>
  res.sendFile(path.join(__dirname, "aulas.html"))
);
app.get("/aula-ao-vivo", exigirLoginPagina, (req, res) =>
  res.sendFile(path.join(__dirname, "index.html"))
);
app.get("/aula", exigirLoginPagina, (req, res) =>
  res.sendFile(path.join(__dirname, "aula-view.html"))
);
app.get("/central", exigirLoginPagina, exigirAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "central.html"))
);
app.get("/relatorios", exigirLoginPagina, exigirAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "relatorios.html"))
);
app.get("/saude", exigirLoginPagina, exigirAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "saude.html"))
);
app.get("/metas", exigirLoginPagina, exigirAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "metas.html"))
);
app.get("/territorio", exigirLoginPagina, (req, res) =>
  res.sendFile(path.join(__dirname, "territorio.html"))
);
app.get("/prospeccao", exigirLoginPagina, (req, res) =>
  res.sendFile(path.join(__dirname, "prospeccao.html"))
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
  limit: "50mb", // planilhas de prospecção têm dezenas de abas (PR: 2,6 MB) — folga
});

app.post("/api/importacoes/cdr", corpoCsv, (req, res) => {
  if (typeof req.body !== "string" || !req.body.trim()) {
    return res
      .status(400)
      .json({ error: "Corpo vazio — envie o conteúdo do CSV como text/plain." });
  }
  const arquivo = String(req.query.arquivo || "cdr.csv").slice(0, 200);
  const resultado = importarCdr(req.body, arquivo, req.usuario.id);
  if (resultado.status !== "erro") emitirEventoTv("cdr");
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
  if (resultado.status !== "erro") emitirEventoTv("oportunidades");
  res.status(resultado.status === "erro" ? 422 : 200).json(resultado);
});

// Prospecção ativa: planilha de carteiras por setor (uma aba por setor); a UF
// é escolhida no upload — nunca deduzida do nome do arquivo.
app.post("/api/importacoes/prospeccao", corpoXlsx, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: "Corpo vazio — envie a planilha .xlsx como application/octet-stream." });
  }
  const uf = String(req.query.uf || "").toUpperCase();
  if (!prospeccao.UFS_ACEITAS.includes(uf)) {
    return res.status(400).json({ error: `Informe a UF da planilha em ?uf= (${prospeccao.UFS_ACEITAS.join(", ")}).` });
  }
  const arquivo = String(req.query.arquivo || "prospeccao.xlsx").slice(0, 200);
  // ?sobrescrever={"ABA": "assinatura da prévia"} — sobrescrever aba editada
  // no sistema é decisão SÓ de admin (a rota já é de gestão; conferido de novo)
  let sobrescrever = {};
  if (req.query.sobrescrever) {
    if (req.usuario.papel !== "admin") {
      return res.status(403).json({ error: "Só o admin pode sobrescrever abas editadas no sistema." });
    }
    try {
      sobrescrever = JSON.parse(String(req.query.sobrescrever));
    } catch {
      sobrescrever = null;
    }
    if (!sobrescrever || typeof sobrescrever !== "object" || Array.isArray(sobrescrever) ||
        Object.values(sobrescrever).some((v) => typeof v !== "string")) {
      return res.status(400).json({ error: "Parâmetro sobrescrever inválido (esperado {aba: assinatura})." });
    }
  }
  const resultado = await prospeccao.importarProspeccao(req.body, arquivo, uf, req.usuario.id, { sobrescrever });
  if (resultado.status === "erro") {
    console.error(`importação de prospecção recusada (${arquivo}, ${uf}, ${req.body.length} B): ${resultado.erro}`);
  }
  res.status(resultado.status === "erro" ? 422 : 200).json(resultado);
});

app.get("/api/prospeccao/cobertura", (req, res) => res.json(prospeccao.coberturaProspeccao()));

// ---------- Prospecção, Fase 2: tela de trabalho ----------
function responderErroProspeccao(rota, err, res) {
  if (err.validacao) return res.status(400).json({ error: err.message });
  if (err.naoEncontrado) return res.status(404).json({ error: err.message });
  tratarErro(rota, err, res);
}

// Todas recebem o escopo do usuário (null = admin): vendedor só alcança as
// linhas das regionais dele — linha fora do escopo responde 404
app.get("/api/prospeccao/contatos", (req, res) => {
  try {
    res.json(prospeccao.payloadTrabalho(req.query.uf, req.usuario, escopoDe(req.usuario)));
  } catch (err) {
    responderErroProspeccao("prospeccao/contatos", err, res);
  }
});

app.post("/api/prospeccao/contatos", (req, res) => {
  try {
    res.status(201).json({ linha: prospeccao.criarContato(req.body || {}, req.usuario.id, escopoDe(req.usuario)) });
  } catch (err) {
    responderErroProspeccao("prospeccao/contatos", err, res);
  }
});

app.patch("/api/prospeccao/contatos/:id", (req, res) => {
  try {
    res.json(prospeccao.atualizarContato(req.params.id, req.body || {}, req.usuario.id, escopoDe(req.usuario)));
  } catch (err) {
    responderErroProspeccao("prospeccao/contatos/:id", err, res);
  }
});

app.post("/api/prospeccao/contatos/:id/contatos", (req, res) => {
  try {
    res.status(201).json(prospeccao.registrarContato(req.params.id, req.body || {}, req.usuario.id, escopoDe(req.usuario)));
  } catch (err) {
    responderErroProspeccao("prospeccao/contatos/:id/contatos", err, res);
  }
});

app.get("/api/prospeccao/contatos/:id/historico", (req, res) => {
  try {
    res.json({ historico: prospeccao.historicoDoContato(req.params.id, escopoDe(req.usuario)) });
  } catch (err) {
    responderErroProspeccao("prospeccao/contatos/:id/historico", err, res);
  }
});

// Marcação pessoal verde/vermelho (migração 25): sempre do usuário da sessão;
// vendedor só marca contatos do escopo (404 fora)
app.put("/api/prospeccao/contatos/:id/marcacao", (req, res) => {
  try {
    res.json(prospeccao.marcarContato(req.params.id, (req.body || {}).cor ?? null, req.usuario.id, escopoDe(req.usuario)));
  } catch (err) {
    responderErroProspeccao("prospeccao/contatos/:id/marcacao", err, res);
  }
});

// Admin: marcações de outro usuário (só leitura) — prefixo em PREFIXOS_SO_ADMIN
app.get("/api/prospeccao/marcacoes", (req, res) => {
  try {
    res.json(prospeccao.marcacoesDeOutro(req.query.uf, req.query.usuario));
  } catch (err) {
    responderErroProspeccao("prospeccao/marcacoes", err, res);
  }
});

// Fase 4 — CDR × prospecção (só leitura). Ligações do número do contato e do
// município dele; vendedor vê terceiros como "outro consultor".
app.get("/api/prospeccao/contatos/:id/ligacoes", (req, res) => {
  try {
    res.json(prospeccao.ligacoesDoContato(req.params.id, escopoDe(req.usuario)));
  } catch (err) {
    responderErroProspeccao("prospeccao/contatos/:id/ligacoes", err, res);
  }
});

// Painel do CDR por regional no período: admin vê tudo (+ ambíguas para
// revisão, desconhecidas por DDD, por consultor); vendedor só as regionais e
// ligações dele (filtrado no SQL)
app.get("/api/prospeccao/cdr", (req, res) => {
  try {
    res.json(cruzamento.painelCdr(req.query.de, req.query.ate, escopoDe(req.usuario)));
  } catch (err) {
    responderErroProspeccao("prospeccao/cdr", err, res);
  }
});

// Recalcular o cruzamento inteiro (admin) — derivado, idempotente
app.post("/api/prospeccao/cdr/recruzar", (req, res) => {
  res.json(cruzamento.cruzarLigacoes());
});

app.post("/api/prospeccao/status", (req, res) => {
  try {
    res.status(201).json(prospeccao.criarStatus(req.body || {}, req.usuario.id));
  } catch (err) {
    responderErroProspeccao("prospeccao/status", err, res);
  }
});

// Exportação .xlsx (POST porque a lista de ids do filtro não cabe na URL)
app.post("/api/prospeccao/exportar", async (req, res) => {
  try {
    const { uf, ids } = req.body || {};
    const buffer = await prospeccao.exportarXlsx(uf, ids, escopoDe(req.usuario));
    const nome = `prospeccao_${String(uf || "").toUpperCase()}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${nome}"`,
    }).send(buffer);
  } catch (err) {
    responderErroProspeccao("prospeccao/exportar", err, res);
  }
});
// Vendedor recebe a lista enxuta (hex, nome, significado): os exemplos e as abas
// da lista completa trazem contatos de outras regionais
app.get("/api/prospeccao/cores", (req, res) =>
  res.json({ cores: req.usuario.papel === "admin" ? prospeccao.listarCores() : prospeccao.listarCoresEnxuto() })
);
app.put("/api/prospeccao/cores/:hex", (req, res) => {
  try {
    res.json(prospeccao.definirStatusCor(req.params.hex, req.body || {}, req.usuario.id));
  } catch (err) {
    if (err.validacao) return res.status(400).json({ error: err.message });
    tratarErro("prospeccao/cores", err, res);
  }
});

app.post("/api/sincronizacoes/mysql", async (req, res) => {
  try {
    const resultado = await sincronizarMysql(req.usuario.id);
    emitirEventoTv("mysql");
    res.json(resultado);
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
  const escopo = escopoDe(req.usuario);
  if (!escopo) return res.json(calcularMetricas(de, ate));
  // Vendedor: só o bloco dele (filtrado no SQL); sem pessoa ligada → nada
  if (!escopo.pessoaId) return res.json({ de, ate, minha: null });
  res.json(metricasDaPessoa(de, ate, escopo.pessoaId));
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

// ---------- Feedback individual com IA (Etapa 3) ----------
// A IA consome as métricas prontas do snapshot congelado — nunca produz
// números. Cada geração vira uma nova linha em `feedbacks` (trilha, como nos
// snapshots), com o dossiê de fatos exato gravado em fatos_json.

app.get("/api/periodos/:id/feedbacks", (req, res) => {
  const periodo = db.prepare("SELECT id FROM periodos WHERE id = ?").get(req.params.id);
  if (!periodo) return res.status(404).json({ error: "Período não encontrado." });
  const feedbacks = db
    .prepare(
      `SELECT f.id, f.pessoa_id, p.nome AS pessoa, f.snapshot_id, f.modelo,
              f.texto_md, f.criado_em, u.login AS usuario
       FROM feedbacks f
       JOIN pessoas p ON p.id = f.pessoa_id
       JOIN usuarios u ON u.id = f.usuario_id
       WHERE f.periodo_id = ? ORDER BY f.id DESC`
    )
    .all(periodo.id);
  const elegiveis = db
    .prepare(
      `SELECT id, nome FROM pessoas
       WHERE tipo = 'consultor' AND ativo = 1 AND entra_feedback = 1 ORDER BY nome`
    )
    .all();
  res.json({ feedbacks, elegiveis });
});

app.post("/api/periodos/:id/feedbacks", async (req, res) => {
  if (!verificarChave(res)) return;
  const periodo = db.prepare("SELECT * FROM periodos WHERE id = ?").get(req.params.id);
  if (!periodo) return res.status(404).json({ error: "Período não encontrado." });

  const pessoaId = Number(req.body?.pessoaId);
  const pessoa = Number.isInteger(pessoaId)
    ? db.prepare("SELECT * FROM pessoas WHERE id = ? AND tipo = 'consultor' AND ativo = 1").get(pessoaId)
    : null;
  if (!pessoa) return res.status(404).json({ error: "Consultor não encontrado." });
  if (!pessoa.entra_feedback) {
    return res.status(403).json({
      error: `${pessoa.nome} está fora do feedback individual (entra_feedback desativado).`,
    });
  }

  // Sempre a versão mais recente do congelamento: o texto nasce amarrado a
  // números defensáveis, nunca ao cálculo ao vivo.
  const snapshot = db
    .prepare("SELECT * FROM periodo_snapshots WHERE periodo_id = ? ORDER BY id DESC LIMIT 1")
    .get(periodo.id);
  if (!snapshot) return res.status(404).json({ error: "Período sem snapshot congelado." });

  const fatos = prepararFatosFeedback(periodo, JSON.parse(snapshot.dados_json), pessoaId);
  if (!fatos) {
    return res.status(404).json({ error: "Consultor não aparece no snapshot deste período." });
  }

  try {
    const textoMd = await gerarFeedbackMarkdown(anthropic, MODELO, fatos);
    const criadoEm = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO feedbacks (periodo_id, snapshot_id, pessoa_id, modelo, fatos_json,
                                texto_md, criado_em, usuario_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(periodo.id, snapshot.id, pessoaId, MODELO, JSON.stringify(fatos), textoMd,
        criadoEm, req.usuario.id);
    res.status(201).json({ id: info.lastInsertRowid, textoMd, criadoEm, modelo: MODELO });
  } catch (err) {
    tratarErro("periodos/:id/feedbacks", err, res);
  }
});

app.get("/api/saude", (req, res) => {
  res.json(saudeDosDados());
});

// ---------- Sessão, senha, usuários e carteiras (Fase 3 da prospecção) ----------

app.get("/api/sessao", (req, res) => {
  const u = req.usuario;
  const escopo = escopoDe(u);
  const pessoa = u.pessoa_id ? db.prepare("SELECT id, nome FROM pessoas WHERE id = ?").get(u.pessoa_id) : null;
  const regionais = escopo
    ? db.prepare(`SELECT id, uf, sigla, nome FROM regionais WHERE id IN (${escopo.regionais.map(() => "?").join(",") || "NULL"}) ORDER BY uf, sigla`).all(...escopo.regionais)
    : null;
  res.json({
    id: u.id, login: u.login, nome: u.nome || u.login, papel: u.papel, pessoa, trocarSenha: Boolean(u.senha_temporaria),
    escopo: escopo ? { regionais, ufs: escopo.ufs, municipios: escopo.municipios.size, vazio: escopo.vazio } : null,
  });
});

app.post("/api/senha", async (req, res) => {
  const senhaAtual = String(req.body?.senhaAtual || "");
  const senhaNova = String(req.body?.senhaNova || "");
  const conta = db.prepare("SELECT * FROM usuarios WHERE id = ?").get(req.usuario.id);
  if (!(await verificarSenha(conta.senha_hash, senhaAtual))) {
    registrarFalha(chavesDeLogin(req.ip, conta.login)); // troca de senha também conta no rate limit
    return res.status(401).json({ error: "Senha atual incorreta." });
  }
  const problema = validarSenhaNova(senhaNova, conta.login);
  if (problema) return res.status(400).json({ error: problema });
  if (senhaNova === senhaAtual) return res.status(400).json({ error: "A senha nova precisa ser diferente da atual." });
  db.prepare("UPDATE usuarios SET senha_hash = ?, senha_temporaria = 0, senha_trocada_em = ? WHERE id = ?")
    .run(await hashSenha(senhaNova), new Date().toISOString(), conta.id);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Senha trocada, mas a sessão precisa ser refeita — faça login de novo." });
    req.session.usuarioId = conta.id;
    req.session.papel = conta.papel;
    res.json({ ok: true, destino: paginaInicialDe(conta) });
  });
});

const listarUsuarios = () =>
  db.prepare(
    `SELECT u.id, u.login, u.nome, u.papel, u.ativo, u.pessoa_id pessoaId, p.nome pessoa, u.senha_temporaria senhaTemporaria,
            u.criado_em criadoEm, u.ultimo_acesso_em ultimoAcessoEm, u.senha_trocada_em senhaTrocadaEm
     FROM usuarios u LEFT JOIN pessoas p ON p.id = u.pessoa_id ORDER BY u.papel, u.login`
  ).all();

app.get("/api/usuarios", (req, res) => {
  const pessoas = db.prepare("SELECT id, nome, ativo FROM pessoas WHERE tipo = 'consultor' ORDER BY nome").all();
  res.json({ usuarios: listarUsuarios(), pessoas });
});

function validarPessoaDeVendedor(papel, pessoaId, usuarioId) {
  if (papel !== "vendedor") return null;
  const id = Number(pessoaId);
  if (!Number.isInteger(id) || !db.prepare("SELECT 1 FROM pessoas WHERE id = ? AND tipo = 'consultor'").get(id)) {
    throw Object.assign(new Error("Vendedor precisa estar ligado a um consultor de `pessoas`."), { status: 400 });
  }
  const dono = db.prepare("SELECT id, login FROM usuarios WHERE pessoa_id = ? AND id != COALESCE(?, -1)").get(id, usuarioId ?? null);
  if (dono) throw Object.assign(new Error(`Esse consultor já está ligado ao usuário "${dono.login}".`), { status: 400 });
  return id;
}

app.post("/api/usuarios", async (req, res) => {
  try {
    const login = String(req.body?.login || "").trim().toLowerCase();
    const nome = String(req.body?.nome || "").trim();
    const papel = String(req.body?.papel || "");
    if (!/^[a-z0-9._-]{3,40}$/.test(login)) return res.status(400).json({ error: "Login: 3–40 caracteres, letras minúsculas, números, ponto, hífen ou sublinhado." });
    if (!PAPEIS.includes(papel)) return res.status(400).json({ error: "Papel deve ser admin ou vendedor." });
    if (db.prepare("SELECT 1 FROM usuarios WHERE lower(login) = ?").get(login)) return res.status(400).json({ error: "Login já existe." });
    const pessoaId = validarPessoaDeVendedor(papel, req.body?.pessoaId, null);
    const senhaInicial = gerarSenhaInicial();
    const info = db.prepare(
      `INSERT INTO usuarios (login, senha_hash, nome, papel, ativo, criado_em, pessoa_id, senha_temporaria)
       VALUES (?, ?, ?, ?, 1, ?, ?, 1)`
    ).run(login, await hashSenha(senhaInicial), nome || login, papel, new Date().toISOString(), pessoaId);
    res.status(201).json({ usuario: listarUsuarios().find((u) => u.id === info.lastInsertRowid), senhaInicial });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    tratarErro("usuarios", err, res);
  }
});

app.patch("/api/usuarios/:id", (req, res) => {
  try {
    const alvo = db.prepare("SELECT * FROM usuarios WHERE id = ?").get(Number(req.params.id));
    if (!alvo) return res.status(404).json({ error: "Usuário não encontrado." });
    const { nome, ativo, pessoaId, papel } = req.body || {};
    const novoPapel = papel === undefined ? alvo.papel : String(papel);
    if (!PAPEIS.includes(novoPapel)) return res.status(400).json({ error: "Papel deve ser admin ou vendedor." });
    if (alvo.id === req.usuario.id && (ativo === false || ativo === 0 || novoPapel !== "admin")) {
      return res.status(400).json({ error: "Você não pode desativar ou rebaixar o próprio usuário." });
    }
    const novaPessoa = novoPapel === "vendedor"
      ? validarPessoaDeVendedor("vendedor", pessoaId === undefined ? alvo.pessoa_id : pessoaId, alvo.id)
      : (pessoaId === undefined ? alvo.pessoa_id : (pessoaId === null ? null : validarPessoaDeVendedor("vendedor", pessoaId, alvo.id)));
    db.prepare("UPDATE usuarios SET nome = ?, ativo = ?, pessoa_id = ?, papel = ? WHERE id = ?")
      .run(nome === undefined ? alvo.nome : String(nome).trim() || alvo.login, ativo === undefined ? alvo.ativo : (ativo ? 1 : 0), novaPessoa, novoPapel, alvo.id);
    if (ativo === false || ativo === 0) db.prepare("DELETE FROM sessions WHERE sess LIKE ?").run(`%"usuarioId":${alvo.id}%`); // derruba sessões abertas
    res.json({ usuario: listarUsuarios().find((u) => u.id === alvo.id) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    tratarErro("usuarios/:id", err, res);
  }
});

app.post("/api/usuarios/:id/senha-inicial", async (req, res) => {
  const alvo = db.prepare("SELECT id, login FROM usuarios WHERE id = ?").get(Number(req.params.id));
  if (!alvo) return res.status(404).json({ error: "Usuário não encontrado." });
  const senhaInicial = gerarSenhaInicial();
  db.prepare("UPDATE usuarios SET senha_hash = ?, senha_temporaria = 1 WHERE id = ?").run(await hashSenha(senhaInicial), alvo.id);
  db.prepare("DELETE FROM sessions WHERE sess LIKE ?").run(`%"usuarioId":${alvo.id}%`);
  res.json({ login: alvo.login, senhaInicial });
});

app.get("/api/carteiras", (req, res) => res.json(prospeccao.listarCarteiras()));

app.put("/api/carteiras/:regionalId", (req, res) => {
  try {
    res.json(prospeccao.gravarCarteira(req.params.regionalId, req.body || {}, req.usuario.id));
  } catch (err) {
    responderErroProspeccao("carteiras", err, res);
  }
});

app.get("/api/prospeccao/gerencial", (req, res) => res.json(prospeccao.gerencial()));

// ---------- Território: casamento cidade → município, cobertura e revisão ----------

// Período opcional: sem `de`/`ate` = base inteira; com um deles, valida os dois.
function periodoOpcional(req, res) {
  const { de, ate } = req.query;
  if (!de && !ate) return {};
  return validarIntervalo(de, ate, res) ? { de, ate } : null;
}

function responderErroTerritorio(rota, err, res) {
  if (err.validacao) return res.status(400).json({ error: err.message });
  tratarErro(rota, err, res);
}

app.get("/api/territorio/cobertura", (req, res) => {
  const p = periodoOpcional(req, res);
  if (!p) return;
  res.json(territorio.coberturaTerritorio(p.de, p.ate));
});

app.get("/api/territorio/pendencias", (req, res) => {
  res.json({ ...territorio.pendencias(), compartilhados: territorio.compartilhados() });
});

app.post("/api/territorio/apelidos", (req, res) => {
  try {
    const cruzamento = territorio.resolverApelido(req.body || {}, req.usuario.id);
    res.json({ cruzamento, cobertura: territorio.coberturaTerritorio() });
  } catch (err) {
    responderErroTerritorio("territorio/apelidos", err, res);
  }
});

// Confirmação em lote da revisão: valida tudo antes de gravar; reprocessa uma vez
app.post("/api/territorio/apelidos/lote", (req, res) => {
  try {
    const itens = Array.isArray(req.body?.itens) ? req.body.itens : null;
    if (!itens || !itens.length) return res.status(400).json({ error: "Informe { itens: [...] }." });
    const cruzamento = territorio.resolverApelidosLote(itens, req.usuario.id);
    res.json({ cruzamento, aplicados: itens.length, cobertura: territorio.coberturaTerritorio() });
  } catch (err) {
    responderErroTerritorio("territorio/apelidos/lote", err, res);
  }
});

app.get("/api/territorio/municipios", (req, res) => {
  res.json(territorio.listarMunicipiosERegionais());
});

// Fase 3: malha municipal de PR + SC (SVG do IBGE, versionada em dados/ — sem CDN)
app.get("/api/territorio/mapa", (req, res) => {
  const svg = territorio.lerMapaSvg();
  if (!svg) return res.status(503).json({ error: "dados/mapa_PR_SC.svg não encontrado — rode scripts/gerar-referencias-territorio.js." });
  res.set({ "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "private, max-age=86400" }).send(svg);
});

// Fase 2: agregação por estado/regional/município com conferência contra o total
app.get("/api/territorio/agregado", (req, res) => {
  const p = periodoOpcional(req, res);
  if (!p) return;
  res.json(territorio.agregarTerritorio(p.de, p.ate, escopoDe(req.usuario)));
});

app.get("/api/territorio/municipios/:codigo", (req, res) => {
  const p = periodoOpcional(req, res);
  if (!p) return;
  const detalhe = territorio.detalheMunicipio(req.params.codigo, p.de, p.ate, escopoDe(req.usuario));
  if (!detalhe) return res.status(404).json({ error: "Município não encontrado." });
  res.json(detalhe);
});

app.put("/api/territorio/municipios/:codigo/principal", (req, res) => {
  try {
    territorio.definirRegionalPrincipal(req.params.codigo, req.body?.regionalId);
    res.json({ compartilhados: territorio.compartilhados() });
  } catch (err) {
    responderErroTerritorio("territorio/municipios/principal", err, res);
  }
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

// Erros que escapam das rotas (corpo acima do limite do body-parser, exceção
// em rota async) respondem JSON com o motivo em /api — sem isto o Express
// devolve uma página HTML e a tela só consegue dizer "erro 413/500".
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status === 413 || err.type === "entity.too.large") {
    const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
    return res.status(413).json({
      error: `Arquivo grande demais para o servidor: ${err.length ? mb(err.length) : "?"} (limite ${err.limit ? mb(err.limit) : "?"}).`,
    });
  }
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: err.expose ? err.message : `Requisição recusada (${status}).` });
  }
  console.error(`erro não tratado em ${req.method} ${req.path}:`, err);
  if (!req.path.startsWith("/api/")) return res.status(500).send("Erro interno.");
  res.status(500).json({ error: `Erro interno: ${err.message || err}` });
});

(async () => {
  await semearAdmin(); // garante o primeiro admin e adota aulas sem dono
  // Referência territorial (dados/): idempotente, roda em todo boot
  const ref = territorio.carregarReferencias();
  console.log(
    `território: ${ref.municipios} municípios, ${ref.regionais} regionais, ${ref.vinculos} vínculos ` +
      `(${ref.compartilhados} municípios em 2 regionais${ref.principaisDefinidas ? `, ${ref.principaisDefinidas} principal(is) definida(s)` : ""}` +
      `${ref.vinculosRemovidos ? `, ${ref.vinculosRemovidos} vínculo(s) removido(s)` : ""}).`
  );
  for (const aviso of ref.avisos) console.warn("⚠  território:", aviso);
  const recruzado = territorio.recruzarSePendente();
  if (recruzado) console.log(`território: casamento reprocessado no boot (migração pendente) — ${recruzado.matriculas} matrícula(s).`);
  const cdrCruzado = cruzamento.cruzarSePendente();
  if (cdrCruzado) {
    console.log(`prospecção: CDR cruzado no boot (migração pendente) — ${cdrCruzado.ligacoes} ligação(ões): ` +
      `${cdrCruzado.prospeccao} prospecção, ${cdrCruzado.ambigua} ambígua(s), ${cdrCruzado.cliente} cliente, ${cdrCruzado.lead} lead, ` +
      `${cdrCruzado.desconhecida} desconhecida(s), ${cdrCruzado.interna} interna(s) em ${cdrCruzado.ms} ms.`);
  }
  app.listen(PORT, () => {
    console.log(`jonIAs — Assistente de Aulas rodando em http://localhost:${PORT}`);
  });
})().catch((err) => {
  console.error("✖  Falha ao iniciar o servidor:", err.message || err);
  process.exit(1);
});
