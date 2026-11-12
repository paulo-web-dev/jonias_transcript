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
        AND NOT EXISTS (SELECT 1 FROM marketing_envios e WHERE e.turma_id = t.id)`
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
  if (e.enviado_em) {
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
  };
}

const SQL_ENVIOS = `
  SELECT e.*, date(t.start_date) inicio, t.nome, t.subtitulo, t.fora_da_origem_em, u.nome enviado_por_nome
    FROM marketing_envios e JOIN turmas t ON t.id = e.turma_id LEFT JOIN usuarios u ON u.id = e.enviado_por`;

// Indicador oficial (sem os retroativos) + o bloco dos retroativos à parte
function resumir(lista) {
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
  return { hoje, config: cfg, resumo: resumir(lista), envios: lista };
}

function buscar(id) {
  const e = db.prepare(`${SQL_ENVIOS} WHERE e.id = ?`).get(Number(id));
  if (!e) throw erro("Envio não encontrado.", 404);
  return classificar(e, hojeBrasilia(), config().ativadoEm);
}

function marcarEnviado(id, usuarioId) {
  const x = buscar(id);
  if (x.situacao === "enviado") throw erro("Esse envio já está marcado como enviado.", 409);
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

module.exports = { gerarEnvios, listarEmails, marcarEnviado, desfazerEnviado, eventosDoEnvio, definirVirada, config, prazoDe, NOMES };
