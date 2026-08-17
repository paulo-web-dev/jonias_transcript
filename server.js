"use strict";

require("dotenv").config();

const path = require("path");
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
