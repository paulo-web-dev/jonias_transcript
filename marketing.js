"use strict";

// MARKETING — Fase 1: e-mail marketing do Gustavo (migração 39; decisões do
// usuário, 2026-11-12). Zero IA. É o "equivalente da Rota" para o marketing:
// o sistema lê as TURMAS FUTURAS da cópia local da Unyflex e gera sozinho 3
// envios por turma; o Gustavo só dá o check quando envia.
//
// Regras:
// - Só turmas `unyflex = 0` (minissérie e assinatura não geram e-mail) que
//   ainda estão no filtro da origem (`fora_da_origem_em IS NULL`) e começam
//   DEPOIS de hoje. Cada turma ganha os 3 envios uma vez; nunca apagados.
// - Antecedência = a regra vigente NO DIA EM QUE O ENVIO NASCE, gravada nele
//   (`antecedencia_dias`) e nunca recalculada: 30/15/7 antes da virada
//   (`configuracoes.marketing_email_virada`, 01/01/2027), 60/30/15 desde ela.
// - Prazo = data da turma − antecedência (derivado na leitura: turma adiada
//   leva o prazo junto); prazo em fim de semana ou feriado vale o dia útil
//   ANTERIOR (feriados.js).
// - Atraso em dias CORRIDOS. Enviar no dia do prazo = 0 dias. Pendente no dia
//   do prazo = "vence hoje"; no dia seguinte, 1 dia de atraso.
// - RETROATIVO: prazo anterior à ativação do sistema
//   (`configuracoes.marketing_ativado_em`). Continua na lista (a turma
//   acontece, precisa ser enviado), mas fica FORA do indicador de atraso — o
//   indicador do Gustavo começa limpo.
// - NASCEU ATRASADO: depois da ativação, a turma chegou ao sistema com o prazo
//   já vencido. Aparece em vermelho e conta no indicador, mas o atraso conta a
//   partir do dia em que o envio nasceu (não dá para cobrar antes de a turma
//   existir no sistema).
// - Turma que já começou (data ≤ hoje) ou saiu da origem: sai das pendências;
//   envio sem check vira "não enviado" no histórico (conta no indicador, se
//   não for retroativo).
// - TURMA EXCLUÍDA (migração 40): o admin marca, caso a caso, turma que não
//   gera e-mail (assinatura recorrente). Não ganha envios novos; os já gerados
//   ficam no banco como "excluída", fora das pendências e do indicador, e
//   voltam se ela for reincluída.

const db = require("./db.js");
const feriados = require("./feriados.js");

const NOMES = { 1: "Divulgação inicial", 2: "Intermediário", 3: "Últimas vagas" };
const REGRA_ANTES = [30, 15, 7];
const REGRA_DEPOIS = [60, 30, 15];
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

const formatoBrasilia = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
const hojeBrasilia = () => formatoBrasilia.format(new Date());
const diaBrasilia = (iso) => formatoBrasilia.format(new Date(iso));
const somarDias = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const diasEntre = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 864e5);

function erro(msg, status = 400) {
  return Object.assign(new Error(msg), { status });
}

const lerConfig = (chave) => db.prepare("SELECT valor FROM configuracoes WHERE chave = ?").get(chave)?.valor ?? null;
function config() {
  const virada = lerConfig("marketing_email_virada") || "2027-01-01";
  return {
    ativadoEm: lerConfig("marketing_ativado_em") || hojeBrasilia(),
    virada,
    regraAntes: REGRA_ANTES,
    regraDepois: REGRA_DEPOIS,
    regraHoje: hojeBrasilia() < virada ? REGRA_ANTES : REGRA_DEPOIS,
  };
}

function prazoDe(inicio, antecedencia) {
  let d = somarDias(inicio, -antecedencia);
  while (!feriados.diaUtil(d)) d = somarDias(d, -1);
  return d;
}

// Gera os envios das turmas futuras que ainda não têm. Idempotente (UNIQUE
// turma+ordem). Chamado no boot, no tique de 10 min e ao fim de cada sync.
function gerarEnvios() {
  const hoje = hojeBrasilia();
  const { regraHoje, ativadoEm } = config();
  const agora = new Date().toISOString();
  const turmas = db.prepare(
    `SELECT t.id, date(t.start_date) inicio FROM turmas t
      WHERE t.unyflex = 0 AND t.fora_da_origem_em IS NULL AND date(t.start_date) > ?
        AND NOT EXISTS (SELECT 1 FROM marketing_envios e WHERE e.turma_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM marketing_turmas_excluidas x WHERE x.turma_id = t.id)`
  ).all(hoje);
  const ins = db.prepare("INSERT OR IGNORE INTO marketing_envios (turma_id, ordem, antecedencia_dias, nasceu_em) VALUES (?, ?, ?, ?)");
  let envios = 0, nascidosAtrasados = 0, retroativos = 0;
  db.transaction(() => {
    for (const t of turmas) {
      regraHoje.forEach((dias, i) => {
        envios += ins.run(t.id, i + 1, dias, agora).changes;
        const p = prazoDe(t.inicio, dias);
        if (p < ativadoEm) retroativos++;
        else if (p < hoje) nascidosAtrasados++;
      });
    }
  })();
  if (envios) {
    console.log(`marketing: ${envios} envio(s) de e-mail gerado(s) para ${turmas.length} turma(s) (regra ${regraHoje.join("/")})` +
      (nascidosAtrasados ? ` — ${nascidosAtrasados} nasceram atrasados` : "") + (retroativos ? `, ${retroativos} retroativo(s)` : ""));
  }
  return { turmas: turmas.length, envios, nascidosAtrasados, retroativos };
}

// Situação de um envio na data `hoje` (ver regras no topo)
function classificar(e, hoje, ativadoEm) {
  const prazo = prazoDe(e.inicio, e.antecedencia_dias);
  const nasceu = diaBrasilia(e.nasceu_em);
  const retroativo = prazo < ativadoEm;
  const nasceuAtrasado = !retroativo && prazo < nasceu;
  const referencia = nasceuAtrasado ? nasceu : prazo; // a partir de quando o atraso conta
  const encerrada = e.fora_da_origem_em ? "cancelada" : e.inicio <= hoje ? "aconteceu" : null;
  let situacao, atrasoDias = null, venceEmDias = null;
  if (e.excluida_em) {
    situacao = "excluida";
  } else if (e.enviado_em) {
    situacao = "enviado";
    atrasoDias = Math.max(0, diasEntre(referencia, diaBrasilia(e.enviado_em)));
  } else if (encerrada) {
    situacao = "nao_enviado";
    atrasoDias = Math.max(0, diasEntre(referencia, e.fora_da_origem_em ? diaBrasilia(e.fora_da_origem_em) : e.inicio));
  } else {
    const d = diasEntre(referencia, hoje);
    situacao = d > 0 ? "atrasado" : d === 0 ? "vence_hoje" : "no_prazo";
    if (d > 0) atrasoDias = d;
    else venceEmDias = -d;
  }
  return {
    id: e.id, turmaId: e.turma_id, turma: (e.nome || "").trim(), subtitulo: (e.subtitulo || "").trim(), inicio: e.inicio,
    ordem: e.ordem, envio: NOMES[e.ordem], antecedencia: e.antecedencia_dias, prazo, nasceuEm: e.nasceu_em,
    enviadoEm: e.enviado_em, enviadoPor: e.enviado_por_nome || null, situacao, atrasoDias, venceEmDias,
    retroativo, nasceuAtrasado, encerrada, prazoRetroDias: retroativo ? diasEntre(prazo, ativadoEm) : null,
    excluida: e.excluida_em ? { em: e.excluida_em, motivo: e.excluida_motivo } : null,
  };
}

const SQL_ENVIOS = `
  SELECT e.*, date(t.start_date) inicio, t.nome, t.subtitulo, t.fora_da_origem_em, u.nome enviado_por_nome,
         x.em excluida_em, x.motivo excluida_motivo
    FROM marketing_envios e JOIN turmas t ON t.id = e.turma_id LEFT JOIN usuarios u ON u.id = e.enviado_por
    LEFT JOIN marketing_turmas_excluidas x ON x.turma_id = e.turma_id`;

// Indicador oficial (sem os retroativos) + o bloco dos retroativos à parte
function resumir(lista) {
  lista = lista.filter((x) => x.situacao !== "excluida");
  const oficiais = lista.filter((x) => !x.retroativo);
  const enviados = oficiais.filter((x) => x.situacao === "enviado");
  const atrasados = oficiais.filter((x) => x.situacao === "atrasado");
  const comAtraso = enviados.filter((x) => x.atrasoDias > 0);
  const retro = lista.filter((x) => x.retroativo);
  return {
    pendentesAtrasados: atrasados.length,
    maiorAtraso: atrasados.reduce((m, x) => Math.max(m, x.atrasoDias), 0),
    venceHoje: oficiais.filter((x) => x.situacao === "vence_hoje").length,
    proximos7: oficiais.filter((x) => x.situacao === "no_prazo" && x.venceEmDias <= 7).length,
    noPrazo: oficiais.filter((x) => x.situacao === "no_prazo").length,
    enviados: enviados.length,
    enviadosNoPrazo: enviados.length - comAtraso.length,
    enviadosComAtraso: comAtraso.length,
    atrasoMedioEnviados: enviados.length ? Math.round((enviados.reduce((s, x) => s + x.atrasoDias, 0) / enviados.length) * 10) / 10 : null,
    naoEnviados: oficiais.filter((x) => x.situacao === "nao_enviado").length,
    nascidosAtrasados: oficiais.filter((x) => x.nasceuAtrasado).length,
    retroativos: {
      total: retro.length,
      enviados: retro.filter((x) => x.situacao === "enviado").length,
      pendentes: retro.filter((x) => x.situacao !== "enviado" && x.situacao !== "nao_enviado").length,
      naoEnviados: retro.filter((x) => x.situacao === "nao_enviado").length,
    },
  };
}

function listarEmails() {
  const hoje = hojeBrasilia();
  const cfg = config();
  const lista = db.prepare(`${SQL_ENVIOS} ORDER BY date(t.start_date), t.id, e.ordem`).all().map((e) => classificar(e, hoje, cfg.ativadoEm));
  const excluidas = db.prepare(
    `SELECT x.turma_id turmaId, t.nome turma, t.subtitulo, date(t.start_date) inicio, x.motivo, x.em, u.nome usuario
       FROM marketing_turmas_excluidas x JOIN turmas t ON t.id = x.turma_id LEFT JOIN usuarios u ON u.id = x.usuario_id
      ORDER BY date(t.start_date) DESC`
  ).all();
  return { hoje, config: cfg, resumo: resumir(lista), envios: lista, excluidas };
}

function buscar(id) {
  const e = db.prepare(`${SQL_ENVIOS} WHERE e.id = ?`).get(Number(id));
  if (!e) throw erro("Envio não encontrado.", 404);
  return classificar(e, hojeBrasilia(), config().ativadoEm);
}

function marcarEnviado(id, usuarioId) {
  const x = buscar(id);
  if (x.situacao === "enviado") throw erro("Esse envio já está marcado como enviado.", 409);
  if (x.situacao === "excluida") throw erro("A turma foi excluída do e-mail marketing.", 409);
  if (x.situacao === "nao_enviado") {
    throw erro(x.encerrada === "cancelada" ? "A turma saiu da origem (cancelada) — o envio fica no histórico." : "A turma já começou — o envio fica no histórico como não enviado.", 409);
  }
  const agora = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE marketing_envios SET enviado_em = ?, enviado_por = ? WHERE id = ? AND enviado_em IS NULL").run(agora, usuarioId, x.id);
    db.prepare("INSERT INTO marketing_eventos (envio_id, tipo, usuario_id, em) VALUES (?, 'enviado', ?, ?)").run(x.id, usuarioId, agora);
  })();
  return buscar(x.id);
}

// Só admin (a rota confere): desfaz um check marcado por engano. Fica na trilha.
function desfazerEnviado(id, usuarioId, observacao) {
  const x = buscar(id);
  if (x.situacao !== "enviado") throw erro("Esse envio não está marcado como enviado.", 409);
  const agora = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE marketing_envios SET enviado_em = NULL, enviado_por = NULL WHERE id = ?").run(x.id);
    db.prepare("INSERT INTO marketing_eventos (envio_id, tipo, usuario_id, em, observacao) VALUES (?, 'desfeito', ?, ?, ?)")
      .run(x.id, usuarioId, agora, String(observacao || "").trim().slice(0, 300) || null);
  })();
  return buscar(x.id);
}

function eventosDoEnvio(id) {
  buscar(id);
  return db.prepare(
    `SELECT ev.tipo, ev.em, ev.observacao, u.nome usuario FROM marketing_eventos ev LEFT JOIN usuarios u ON u.id = ev.usuario_id
      WHERE ev.envio_id = ? ORDER BY ev.id`
  ).all(Number(id));
}

// Data de virada 30/15/7 → 60/30/15. Só hoje em diante: envio já nascido
// guarda a regra dele, então mudar a data só afeta turmas que ainda vão entrar.
function definirVirada(data) {
  data = String(data || "");
  if (!RE_DATA.test(data) || isNaN(new Date(`${data}T12:00:00Z`))) throw erro("Data inválida — use AAAA-MM-DD.");
  if (data < hojeBrasilia()) throw erro("A virada não pode ser no passado — os envios já nascidos guardam a regra deles.");
  db.prepare("INSERT INTO configuracoes (chave, valor) VALUES ('marketing_email_virada', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(data);
  return config();
}

// ---------- Trilha comum (migração 40) ----------
function registrar(area, ref, acao, detalhe, usuarioId) {
  db.prepare("INSERT INTO marketing_log (area, ref, acao, detalhe, usuario_id, em) VALUES (?, ?, ?, ?, ?, ?)")
    .run(area, ref == null ? null : String(ref), acao, detalhe == null ? null : JSON.stringify(detalhe), usuarioId ?? null, new Date().toISOString());
}

// ---------- Exclusão de turma do e-mail (só admin; a rota confere) ----------
function excluirTurma(turmaId, motivo, usuarioId) {
  const t = db.prepare("SELECT id, nome FROM turmas WHERE id = ?").get(Number(turmaId));
  if (!t) throw erro("Turma não encontrada.", 404);
  if (db.prepare("SELECT 1 FROM marketing_turmas_excluidas WHERE turma_id = ?").get(t.id)) throw erro("A turma já está excluída.", 409);
  motivo = String(motivo || "").trim().slice(0, 200) || null;
  db.transaction(() => {
    db.prepare("INSERT INTO marketing_turmas_excluidas (turma_id, motivo, usuario_id, em) VALUES (?, ?, ?, ?)").run(t.id, motivo, usuarioId, new Date().toISOString());
    registrar("email", t.id, "turma_excluida", { motivo }, usuarioId);
  })();
  return { turmaId: t.id, turma: t.nome };
}

function reincluirTurma(turmaId, usuarioId) {
  const n = db.prepare("DELETE FROM marketing_turmas_excluidas WHERE turma_id = ?").run(Number(turmaId)).changes;
  if (!n) throw erro("A turma não está excluída.", 404);
  registrar("email", Number(turmaId), "turma_reincluida", null, usuarioId);
  return gerarEnvios(); // turma futura sem envios ganha os 3 agora (regra de hoje)
}

// ---------- Campanhas de ADS: 5 slots fixos (migração 40) ----------
// Slot vazio ou com o curso já realizado = alerta vermelho; "ativos" conta só
// os slots com campanha cujo curso ainda não aconteceu. Trocar o curso encerra
// a campanha anterior HOJE e abre a nova — o histórico por setor fica.
const SETORES_ADS = [
  { setor: "licitacao", nome: "Licitação" },
  { setor: "comunicacao", nome: "Comunicação" },
  { setor: "reforma_tributaria", nome: "Reforma Tributária" },
  { setor: "financas", nome: "Finanças" },
  { setor: "portal", nome: "Portal" },
];
const nomeSetor = (s) => SETORES_ADS.find((x) => x.setor === s)?.nome;

const SQL_ADS = `
  SELECT a.*, t.nome turma, t.subtitulo, date(t.start_date) turma_inicio, t.fora_da_origem_em, uc.nome criada_por_nome, ue.nome encerrada_por_nome
    FROM marketing_ads a JOIN turmas t ON t.id = a.turma_id
    LEFT JOIN usuarios uc ON uc.id = a.criada_por LEFT JOIN usuarios ue ON ue.id = a.encerrada_por`;

function campanhaDe(a, hoje) {
  const fim = a.encerrada_em ? diaBrasilia(a.encerrada_em) : null;
  return {
    id: a.id, setor: a.setor, turmaId: a.turma_id, turma: (a.turma || "").trim(), subtitulo: (a.subtitulo || "").trim(),
    inicio: a.inicio, dataCurso: a.data_curso, orcamentoDiarioCentavos: a.orcamento_diario_centavos,
    criadaEm: a.criada_em, criadaPor: a.criada_por_nome, encerradaEm: a.encerrada_em, encerradaPor: a.encerrada_por_nome, motivoFim: a.motivo_fim,
    dias: diasEntre(a.inicio, fim || hoje) + 1,
    cursoPassou: a.data_curso < hoje, turmaCancelada: !!a.fora_da_origem_em,
  };
}

function painelAds() {
  const hoje = hojeBrasilia();
  const todas = db.prepare(`${SQL_ADS} ORDER BY a.id DESC`).all().map((a) => campanhaDe(a, hoje));
  const setores = SETORES_ADS.map((s) => {
    const ativa = todas.find((c) => c.setor === s.setor && !c.encerradaEm) || null;
    const situacao = !ativa ? "vazio" : ativa.cursoPassou ? "curso_passou" : ativa.turmaCancelada ? "turma_cancelada" : "ok";
    return { ...s, situacao, ativa, historico: todas.filter((c) => c.setor === s.setor && c.encerradaEm) };
  });
  const turmas = db.prepare(
    `SELECT id, nome, subtitulo, date(start_date) inicio FROM turmas
      WHERE fora_da_origem_em IS NULL AND date(start_date) >= ? ORDER BY date(start_date), nome`
  ).all(hoje).map((t) => ({ id: t.id, nome: (t.nome || "").trim(), subtitulo: (t.subtitulo || "").trim(), inicio: t.inicio }));
  return {
    hoje, setores, turmas,
    ativos: setores.filter((s) => s.situacao === "ok").length,
    totalSlots: SETORES_ADS.length,
    orcamentoDiarioTotalCentavos: setores.reduce((soma, s) => soma + (s.ativa ? s.ativa.orcamentoDiarioCentavos : 0), 0),
  };
}

function lerCampanha(corpo, ativaAtual) {
  const turmaId = corpo.turmaId === undefined && ativaAtual ? ativaAtual.turma_id : Number(corpo.turmaId);
  const turma = db.prepare("SELECT id, date(start_date) inicio FROM turmas WHERE id = ?").get(turmaId);
  if (!turma) throw erro("Escolha a turma da campanha.");
  const inicio = corpo.inicio === undefined && ativaAtual ? ativaAtual.inicio : String(corpo.inicio || "");
  if (!RE_DATA.test(inicio)) throw erro("Data de início da campanha inválida.");
  const dataCurso = corpo.dataCurso === undefined || corpo.dataCurso === "" ? (ativaAtual && corpo.turmaId === undefined ? ativaAtual.data_curso : turma.inicio) : String(corpo.dataCurso);
  if (!RE_DATA.test(dataCurso || "")) throw erro("Data do curso inválida.");
  let centavos = ativaAtual?.orcamento_diario_centavos;
  if (corpo.orcamentoDiario !== undefined || !ativaAtual) {
    const v = Number(String(corpo.orcamentoDiario ?? "").replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(v) || v < 0 || String(corpo.orcamentoDiario ?? "").trim() === "") throw erro("Orçamento diário inválido (em reais).");
    centavos = Math.round(v * 100);
  }
  return { turmaId: turma.id, inicio, dataCurso, centavos };
}

// Nova campanha no slot: encerra a ativa (se houver) hoje e abre a nova
function definirCampanhaAds(setor, corpo, usuarioId) {
  if (!nomeSetor(setor)) throw erro("Setor inválido.");
  const c = lerCampanha(corpo || {}, null);
  const agora = new Date().toISOString();
  return db.transaction(() => {
    const ativa = db.prepare("SELECT id, turma_id FROM marketing_ads WHERE setor = ? AND encerrada_em IS NULL").get(setor);
    if (ativa) {
      db.prepare("UPDATE marketing_ads SET encerrada_em = ?, encerrada_por = ?, motivo_fim = ? WHERE id = ?").run(agora, usuarioId, "troca de curso", ativa.id);
      registrar("ads", ativa.id, "encerrada", { setor, motivo: "troca de curso" }, usuarioId);
    }
    const id = db.prepare(
      `INSERT INTO marketing_ads (setor, turma_id, inicio, data_curso, orcamento_diario_centavos, criada_em, criada_por) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(setor, c.turmaId, c.inicio, c.dataCurso, c.centavos, agora, usuarioId).lastInsertRowid;
    registrar("ads", id, "criada", { setor, ...c }, usuarioId);
    return painelAds();
  })();
}

// Ajuste da campanha ATIVA (início, data do curso, orçamento) — sem trocar o curso
function editarCampanhaAds(setor, corpo, usuarioId) {
  const ativa = db.prepare("SELECT * FROM marketing_ads WHERE setor = ? AND encerrada_em IS NULL").get(setor);
  if (!ativa) throw erro("Não há campanha ativa nesse setor.", 404);
  const { turmaId, ...resto } = corpo || {};
  const c = lerCampanha(resto, ativa);
  const de = { inicio: ativa.inicio, dataCurso: ativa.data_curso, centavos: ativa.orcamento_diario_centavos };
  db.transaction(() => {
    db.prepare("UPDATE marketing_ads SET inicio = ?, data_curso = ?, orcamento_diario_centavos = ? WHERE id = ?").run(c.inicio, c.dataCurso, c.centavos, ativa.id);
    registrar("ads", ativa.id, "editada", { de, para: { inicio: c.inicio, dataCurso: c.dataCurso, centavos: c.centavos } }, usuarioId);
  })();
  return painelAds();
}

// Encerrar sem substituto: o slot fica VAZIO (alerta vermelho)
function encerrarCampanhaAds(setor, motivo, usuarioId) {
  const ativa = db.prepare("SELECT id FROM marketing_ads WHERE setor = ? AND encerrada_em IS NULL").get(setor);
  if (!ativa) throw erro("Não há campanha ativa nesse setor.", 404);
  motivo = String(motivo || "").trim().slice(0, 200) || "encerrada sem substituta";
  db.transaction(() => {
    db.prepare("UPDATE marketing_ads SET encerrada_em = ?, encerrada_por = ?, motivo_fim = ? WHERE id = ?").run(new Date().toISOString(), usuarioId, motivo, ativa.id);
    registrar("ads", ativa.id, "encerrada", { setor, motivo }, usuarioId);
  })();
  return painelAds();
}

// ---------- Grupos de WhatsApp: check semanal (migração 40) ----------
// Um check por semana, devido no 1º dia útil (segunda; feriado → o seguinte).
// Só a semana CORRENTE pode ser marcada: semana que passou sem check fica
// vermelha no histórico. EXCEÇÃO (migração 42): o ADMIN registra uma semana
// passada, informando a data em que foi feito (é ela que conta para o atraso);
// quem marcou e quando ficam em registrado_por/registrado_em.
// Atraso = dias corridos do devido ao dia em que foi feito.
// Semana sem dia útil não é cobrada; semana com devido antes de
// marketing_whatsapp_desde também não (o controle começa limpo).
const segundaDe = (d) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return somarDias(d, -((w + 6) % 7)); };
function devidoDaSemana(segunda) {
  for (let i = 0; i < 5; i++) { const d = somarDias(segunda, i); if (feriados.diaUtil(d)) return d; }
  return null;
}

function painelWhatsapp() {
  const hoje = hojeBrasilia();
  const desde = lerConfig("marketing_whatsapp_desde") || hoje;
  const checks = new Map(db.prepare(
    `SELECT w.*, u.nome feito_por_nome, r.nome registrado_por_nome FROM marketing_whatsapp w
       LEFT JOIN usuarios u ON u.id = w.feito_por LEFT JOIN usuarios r ON r.id = w.registrado_por`
  ).all().map((c) => [c.semana, c]));
  const semanas = [];
  for (let s = segundaDe(desde); s <= segundaDe(hoje); s = somarDias(s, 7)) {
    const devido = devidoDaSemana(s);
    if (!devido || devido < desde) continue;
    const c = checks.get(s);
    const atual = s === segundaDe(hoje);
    let situacao, atrasoDias = null;
    if (c) { situacao = "feito"; atrasoDias = Math.max(0, diasEntre(devido, diaBrasilia(c.feito_em))); }
    else if (!atual) situacao = "nao_feito";
    else if (hoje < devido) situacao = "aguardando";
    else if (hoje === devido) situacao = "hoje";
    else { situacao = "atrasado"; atrasoDias = diasEntre(devido, hoje); }
    semanas.push({
      semana: s, devido, atual, situacao, atrasoDias, feitoEm: c?.feito_em || null, feitoPor: c?.feito_por_nome || null, observacao: c?.observacao || null,
      informadoAdmin: !!c?.informado_admin, registradoEm: c?.registrado_em || null, registradoPor: c?.registrado_por_nome || null,
    });
  }
  semanas.reverse();
  const fechadas = semanas.filter((x) => x.situacao === "feito" || x.situacao === "nao_feito");
  const feitas = fechadas.filter((x) => x.situacao === "feito");
  // semana atual sem dia devido ainda (controle começou depois do devido desta semana)
  const atualSemCobranca = !semanas.some((x) => x.atual);
  return {
    hoje, desde, semanas, atual: semanas.find((x) => x.atual) || null, atualSemCobranca,
    proximaSemana: atualSemCobranca ? { semana: somarDias(segundaDe(hoje), 7), devido: devidoDaSemana(somarDias(segundaDe(hoje), 7)) } : null,
    resumo: {
      semanas: fechadas.length, // semanas já decididas (feitas + não feitas), a atual inclusa só se já tem check
      feitas: feitas.length,
      noDia: feitas.filter((x) => x.atrasoDias === 0).length,
      comAtraso: feitas.filter((x) => x.atrasoDias > 0).length,
      naoFeitas: fechadas.filter((x) => x.situacao === "nao_feito").length,
      atrasoMedio: feitas.length ? Math.round((feitas.reduce((s, x) => s + x.atrasoDias, 0) / feitas.length) * 10) / 10 : null,
    },
  };
}

// corpo: { observacao, semana?, feitoEm? }. Sem `semana` (ou a corrente) = o
// check normal, carimbado agora. Semana PASSADA = só admin, com `feitoEm`
// (AAAA-MM-DD, entre a segunda da semana e hoje; padrão = o dia devido).
function marcarWhatsapp(usuario, corpo = {}) {
  const p = painelWhatsapp();
  const observacao = String(corpo.observacao || "").trim().slice(0, 300) || null;
  const agora = new Date().toISOString();
  const semana = corpo.semana ? String(corpo.semana) : p.atual?.semana;
  const alvo = p.semanas.find((s) => s.semana === semana);
  if (!alvo) throw erro(corpo.semana ? "Essa semana não é cobrada." : "Esta semana não é cobrada (o controle começa na próxima semana, ou não há dia útil).", 409);
  if (alvo.situacao === "feito") throw erro("O check dessa semana já foi dado.", 409);
  let feitoEm = agora, informado = 0;
  if (!alvo.atual) {
    if (usuario.papel !== "admin") throw erro("Semana passada só o administrador registra.", 403);
    const data = String(corpo.feitoEm || alvo.devido);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || isNaN(new Date(`${data}T12:00:00Z`))) throw erro("Data em que foi feito inválida — use AAAA-MM-DD.");
    if (data < alvo.semana || data > p.hoje) throw erro("A data em que foi feito precisa estar entre a segunda dessa semana e hoje.");
    feitoEm = new Date(`${data}T12:00:00-03:00`).toISOString(); // meio-dia de Brasília: o dia não muda com o fuso
    informado = 1;
  }
  db.transaction(() => {
    db.prepare(`INSERT INTO marketing_whatsapp (semana, devido_em, feito_em, feito_por, observacao, registrado_em, registrado_por, informado_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(alvo.semana, alvo.devido, feitoEm, informado ? null : usuario.id, observacao, agora, usuario.id, informado);
    registrar("whatsapp", alvo.semana, informado ? "feito_registrado_admin" : "feito", { observacao, feitoEm: informado ? feitoEm.slice(0, 10) : undefined }, usuario.id);
  })();
  return painelWhatsapp();
}

// Só admin (a rota confere): desfaz o check de uma semana (fica na trilha)
function desfazerWhatsapp(semana, usuarioId) {
  const c = db.prepare("SELECT * FROM marketing_whatsapp WHERE semana = ?").get(String(semana));
  if (!c) throw erro("Não há check nessa semana.", 404);
  db.transaction(() => {
    db.prepare("DELETE FROM marketing_whatsapp WHERE semana = ?").run(c.semana);
    registrar("whatsapp", c.semana, "desfeito", { feitoEm: c.feito_em, feitoPor: c.feito_por }, usuarioId);
  })();
  return painelWhatsapp();
}

// ---------- TV do marketing (Fase 3; decisões do usuário, 2026-11-12) ----------
// Uma tela "MARKETING" na rotação da TV, Kesley × Gustavo (nomes curtos).
// - Interruptor `marketing_tv` (admin, na /marketing), nasce DESLIGADO: o
//   usuário quer uma semana de uso real antes de pôr o desempenho na parede.
//   Desligado, o payload público da TV não leva NADA do marketing.
// - RETROATIVOS FORA DA TV (e de todo contador): só entra o que venceu depois
//   do início do controle — "dívida do sistema não vai para a parede". Turma
//   excluída do e-mail e post que saiu do plano também ficam fora.
// - ZERO POSITIVO: `emDia` = nada atrasado; a tela mostra em verde, com
//   destaque (mesma lógica do "0 ✓" das rotas).
// - O payload é público na sala: nomes, números e o título curto do post
//   pendente; nunca link, motivo ou observação.
const tvLigada = () => lerConfig("marketing_tv") === "1";
function definirTv(ativo) {
  db.prepare("INSERT INTO configuracoes (chave, valor) VALUES ('marketing_tv', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(ativo ? "1" : "0");
  return { ativo: tvLigada() };
}

function painelTvMarketing({ previa = false } = {}) {
  if (!tvLigada() && !previa) return { ativo: false };
  const planner = require("./planner.js"); // planner.js não depende deste módulo
  const hoje = hojeBrasilia();
  const seg = segundaDe(hoje), dom = somarDias(seg, 6);
  const naSemana = (d) => d >= seg && d <= dom;
  const curto = (s, n = 70) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

  // ---- Kesley: planner ----
  const posts = planner.listarPosts().filter((p) => !p.retroativo && !p.foraDoPlano);
  const deQuem = (r) => posts.filter((p) => p.responsavel === r);
  const indK = planner.indicador(posts, "kesley", seg, dom);
  const atrasadosK = deQuem("kesley").filter((p) => p.situacao === "atrasado").sort((a, b) => b.atrasoDias - a.atrasoDias);
  const semanaK = deQuem("kesley").filter((p) => naSemana(p.data));
  const extras = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(conversas), 0) c FROM planner_extras WHERE data BETWEEN ? AND ?").get(seg, dom);
  const conversas = posts.filter((p) => naSemana(p.data)).reduce((s, p) => s + (p.conversas || 0), 0) + extras.c;
  const kesley = {
    nome: "Kesley",
    planejados: semanaK.length,
    publicados: semanaK.filter((p) => p.situacao === "publicado").length,
    devidos: indK.devidos, noPrazo: indK.noPrazo, pctNoPrazo: indK.pctNoPrazo, atrasoMedio: indK.atrasoMedio, naoVaiSair: indK.naoVaiSair,
    atrasados: atrasadosK.length, maiorAtraso: atrasadosK[0]?.atrasoDias || 0,
    pendentes: atrasadosK.slice(0, 4).map((p) => ({ titulo: curto(p.gancho || p.cursoTexto), canal: p.canal, dias: p.atrasoDias })),
    conversas, metaConversas: Number(lerConfig("marketing_meta_conversas") || 5), extras: extras.n,
  };
  kesley.emDia = kesley.atrasados === 0;

  // ---- Gustavo: ADS, e-mail, WhatsApp e os posts dele no planner ----
  const ads = painelAds();
  const envios = listarEmails().envios.filter((e) => !e.retroativo && e.situacao !== "excluida");
  const atrasadosE = envios.filter((e) => e.situacao === "atrasado").sort((a, b) => b.atrasoDias - a.atrasoDias);
  const semanaE = envios.filter((e) => naSemana(e.prazo));
  const wa = painelWhatsapp();
  const indG = planner.indicador(posts, "gustavo", seg, dom);
  const atrasadosPostsG = deQuem("gustavo").filter((p) => p.situacao === "atrasado").length;
  const gustavo = {
    nome: "Gustavo",
    ads: {
      vivas: ads.ativos, total: ads.totalSlots,
      problemas: ads.setores.filter((s) => s.situacao !== "ok").map((s) => ({ setor: s.nome, situacao: s.situacao, dataCurso: s.ativa?.dataCurso || null })),
    },
    email: {
      semana: { enviados: semanaE.filter((e) => e.situacao === "enviado").length, pendentes: semanaE.filter((e) => ["no_prazo", "vence_hoje", "atrasado"].includes(e.situacao)).length },
      atrasados: atrasadosE.length, maiorAtraso: atrasadosE[0]?.atrasoDias || 0,
    },
    whatsapp: wa.atual ? { situacao: wa.atual.situacao, atrasoDias: wa.atual.atrasoDias, devido: wa.atual.devido } : null,
    posts: { planejados: indG.planejados, publicados: deQuem("gustavo").filter((p) => naSemana(p.data) && p.situacao === "publicado").length, atrasados: atrasadosPostsG },
  };
  gustavo.emDia = gustavo.ads.vivas === gustavo.ads.total && gustavo.email.atrasados === 0 &&
    !["atrasado"].includes(gustavo.whatsapp?.situacao) && atrasadosPostsG === 0;

  return { ativo: true, previa: !tvLigada(), semana: { de: seg, ate: dom }, hoje, kesley, gustavo };
}

module.exports = {
  gerarEnvios, listarEmails, marcarEnviado, desfazerEnviado, eventosDoEnvio, definirVirada, config, prazoDe, NOMES,
  excluirTurma, reincluirTurma,
  SETORES_ADS, painelAds, definirCampanhaAds, editarCampanhaAds, encerrarCampanhaAds,
  painelWhatsapp, marcarWhatsapp, desfazerWhatsapp, segundaDe, devidoDaSemana,
  painelTvMarketing, definirTv, tvLigada,
};
