"use strict";
// SOMENTE LEITURA — quanto cada consultor gerou de PIPELINE por dia, antes de
// trocar a meta de leads (14/dia) pela meta de pipeline (R$ 8.400/dia).
// Não depende de db.js (não roda migração nem seed).
//
//   node scripts/diagnostico-pipeline.js <arquivo.db> [de] [ate]
//   docker compose exec -T jonias node - /app/data/aula-ai.db < scripts/diagnostico-pipeline.js
//
// Sem datas: os 10 dias úteis encerrados até ontem (hoje fica de fora porque o
// Omie de hoje pode não ter chegado). Mostra três definições lado a lado:
//   A) criado no dia  — Σ ticket das oportunidades com fase_01_em no dia
//      (ticket zero não soma nada: a regra "lead sem ticket não conta" não muda A)
//   B) avançou no dia — Σ ticket das que entraram em 02/03/04/05 no dia
//   C) em aberto agora — Σ ticket das Ativas (estoque, não é número diário)
// e o que ajuda a ler A: ticket zerado na criação, ticket preenchido depois,
// conversão histórica pipeline → venda e o frescor das importações do Omie,
// mais a blindagem: ticket retroativo, maior ticket e conversão por consultor.

const Database = require("better-sqlite3");

const [arquivo, deArg, ateArg] = process.argv.slice(2);
if (!arquivo) {
  console.error("uso: diagnostico-pipeline.js <arquivo.db> [de] [ate]");
  process.exit(1);
}
const db = new Database(arquivo, { readonly: true, fileMustExist: true });
const q = (sql, ...a) => db.prepare(sql).all(...a);
const META = 840000; // centavos

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const util = (d) => d.getDay() >= 1 && d.getDay() <= 5;
function diasUteisAte(ateIso, n) {
  const dias = [];
  const d = new Date(ateIso + "T12:00:00");
  while (dias.length < n) {
    if (util(d)) dias.unshift(iso(d));
    d.setDate(d.getDate() - 1);
  }
  return dias;
}
function diasUteisEntre(de, ate) {
  const dias = [];
  for (const d = new Date(de + "T12:00:00"); iso(d) <= ate; d.setDate(d.getDate() + 1)) if (util(d)) dias.push(iso(d));
  return dias;
}
const ontem = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return iso(d); })();
const dias = deArg ? diasUteisEntre(deArg, ateArg || ontem) : diasUteisAte(ateArg || ontem, 10);
const de = dias[0];
const ate = dias[dias.length - 1];
const fim = ate + "T23:59:59";

const reais = (c) => "R$ " + Math.round((c || 0) / 100).toLocaleString("pt-BR");
const mil = (c) => (c ? (c / 100000).toFixed(1).replace(".", ",") + "k" : "·");
const pad = (s, n) => String(s).padEnd(n);
const padE = (s, n) => String(s).padStart(n);
const mediana = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

console.log(`user_version ${db.pragma("user_version", { simple: true })}`);
console.log(`janela: ${de} a ${ate} — ${dias.length} dias úteis · meta testada: ${reais(META)}/dia\n`);

// ---------- Frescor do Omie ----------
console.log("== Importações do Omie (últimas 15) ==");
for (const r of q(`SELECT id, concluido_em, arquivo_nome, registros_novos, registros_atualizados, registros_identicos
                   FROM importacoes WHERE tipo = 'oportunidades' AND status = 'concluida' ORDER BY id DESC LIMIT 15`)) {
  console.log(`  #${r.id} ${r.concluido_em}  novos ${r.registros_novos} · atualiz ${r.registros_atualizados} · idênt ${r.registros_identicos}  ${r.arquivo_nome}`);
}
const fr = q("SELECT MAX(fase_01_em) f1, MAX(incluido_em) inc, COUNT(*) n FROM oportunidades")[0];
console.log(`  oportunidades no banco: ${fr.n} · fase_01_em mais recente ${fr.f1} · incluido_em mais recente ${fr.inc}\n`);

const consultores = q(`SELECT id, nome FROM pessoas WHERE tipo = 'consultor' AND ativo = 1 ORDER BY nome`);
const nomeLargura = Math.max(10, ...consultores.map((c) => c.nome.length)) + 1;

function tabelaDiaria(titulo, linhas) {
  // linhas: [{pessoa_id, dia, centavos, n}]
  const mapa = new Map();
  for (const l of linhas) mapa.set(`${l.pessoa_id}|${l.dia}`, l);
  console.log(`== ${titulo} ==`);
  console.log("  (valores em R$ mil por dia; · = zero)");
  console.log("  " + pad("consultor", nomeLargura) + dias.map((d) => padE(d.slice(5).replace("-", "/"), 7)).join("") +
    padE("média/dia", 12) + padE("mediana", 10) + padE("máx", 9) + padE("dias≥meta", 11) + padE("total", 13));
  const equipePorDia = dias.map(() => 0);
  for (const c of consultores) {
    const vals = dias.map((d) => mapa.get(`${c.id}|${d}`)?.centavos || 0);
    vals.forEach((v, i) => (equipePorDia[i] += v));
    const total = vals.reduce((s, v) => s + v, 0);
    console.log("  " + pad(c.nome, nomeLargura) + vals.map((v) => padE(mil(v), 7)).join("") +
      padE(reais(total / dias.length), 12) + padE(mil(mediana(vals)), 10) + padE(mil(Math.max(...vals)), 9) +
      padE(`${vals.filter((v) => v >= META).length}/${dias.length}`, 11) + padE(reais(total), 13));
  }
  const tot = equipePorDia.reduce((s, v) => s + v, 0);
  console.log("  " + pad("EQUIPE", nomeLargura) + equipePorDia.map((v) => padE(mil(v), 7)).join("") +
    padE(reais(tot / dias.length), 12) + padE("", 10) + padE("", 9) + padE("", 11) + padE(reais(tot), 13));
  const semDono = linhas.filter((l) => !consultores.some((c) => c.id === l.pessoa_id)).reduce((s, l) => s + l.centavos, 0);
  if (semDono) console.log(`  fora dos consultores (canais/sem vendedor/inativos): ${reais(semDono)} na janela`);
  console.log("");
}

// ---------- A) criado no dia ----------
const criadas = q(
  `SELECT pessoa_id, substr(fase_01_em, 1, 10) dia, SUM(COALESCE(ticket_centavos, 0)) centavos, COUNT(*) n,
          SUM(COALESCE(ticket_centavos, 0) = 0) zerados
   FROM oportunidades WHERE fase_01_em BETWEEN ? AND ? GROUP BY pessoa_id, dia`, de, fim);
tabelaDiaria("A) PIPELINE CRIADO NO DIA — Σ ticket com fase_01_em no dia (definição proposta)", criadas);

console.log("== A) leads e ticket zerado na janela, por consultor ==");
for (const c of consultores) {
  const ls = criadas.filter((l) => l.pessoa_id === c.id);
  const n = ls.reduce((s, l) => s + l.n, 0);
  const z = ls.reduce((s, l) => s + l.zerados, 0);
  const tot = ls.reduce((s, l) => s + l.centavos, 0);
  console.log(`  ${pad(c.nome, nomeLargura)} ${padE(n, 4)} leads (${(n / dias.length).toFixed(1).replace(".", ",")}/dia) · ` +
    `${padE(z, 3)} com ticket zero (${n ? Math.round((100 * z) / n) : 0}%) · ticket médio dos > 0: ${n - z ? reais(tot / (n - z)) : "—"}`);
}
const porFase = q(
  `SELECT fase_atual, status, COUNT(*) n, SUM(COALESCE(ticket_centavos, 0) = 0) zerados, SUM(COALESCE(ticket_centavos, 0)) centavos
   FROM oportunidades WHERE fase_01_em BETWEEN ? AND ? GROUP BY fase_atual, status ORDER BY fase_atual, status`, de, fim);
console.log("  criadas na janela, por fase/status atual (ticket zero é por fase?):");
for (const r of porFase) console.log(`    ${pad(r.fase_atual + " / " + r.status, 30)} ${padE(r.n, 4)} · zero ${padE(r.zerados, 4)} · ${reais(r.centavos)}`);
const semFase1 = q(`SELECT COUNT(*) n FROM oportunidades WHERE fase_01_em IS NULL AND incluido_em BETWEEN ? AND ?`, de, fim)[0].n;
console.log(`  incluídas na janela SEM fase_01_em (ficam fora de A): ${semFase1}\n`);

// ---------- Ticket muda depois da criação? ----------
const mud = q(
  `SELECT m.valor_anterior ant, m.valor_novo novo, m.observado_em obs, o.fase_01_em f1
   FROM oportunidade_mudancas m JOIN oportunidades o ON o.id = m.oportunidade_id
   WHERE m.campo = 'ticket_centavos' AND o.fase_01_em >= date(?, '-60 days')`, de);
const deZero = mud.filter((m) => !Number(m.ant) && Number(m.novo) > 0);
const atrasos = deZero.map((m) => Math.round((new Date(m.obs.slice(0, 10)) - new Date(m.f1.slice(0, 10))) / 864e5));
console.log("== Ticket alterado depois da criação (oportunidades criadas nos últimos ~70 dias) ==");
console.log(`  mudanças de ticket registradas: ${mud.length} · de zero para valor: ${deZero.length}` +
  (atrasos.length ? ` · dias até preencher: mediana ${mediana(atrasos)}, máx ${Math.max(...atrasos)}` : ""));
const sobe = mud.filter((m) => Number(m.ant) > 0 && Number(m.novo) > Number(m.ant)).length;
const desce = mud.filter((m) => Number(m.novo) < Number(m.ant)).length;
console.log(`  aumentou (já tinha valor): ${sobe} · diminuiu: ${desce}`);
console.log("  (mudança só é vista quando a oportunidade vem em duas importações — é piso, não total)\n");

// ---------- Blindagem: retroativo e concentração (por consultor) ----------
// Retroativo = aumento de ticket registrado em oportunidade_mudancas DEPOIS do
// dia de criação (só se vê quando a oportunidade aparece em duas importações:
// é piso). Concentração = parte do pipeline da janela que veio do MAIOR ticket.
console.log("== Blindagem: quanto do pipeline A veio de ticket retroativo e do maior ticket ==");
const retro = new Map(q(
  `SELECT o.pessoa_id, SUM(MAX(0, CAST(m.valor_novo AS INTEGER) - COALESCE(CAST(m.valor_anterior AS INTEGER), 0))) centavos, COUNT(*) n
   FROM oportunidade_mudancas m JOIN oportunidades o ON o.id = m.oportunidade_id
   WHERE m.campo = 'ticket_centavos' AND o.fase_01_em BETWEEN ? AND ?
     AND substr(m.observado_em, 1, 10) > substr(o.fase_01_em, 1, 10)
   GROUP BY o.pessoa_id`, de, fim).map((r) => [r.pessoa_id, r]));
for (const c of consultores) {
  const tot = criadas.filter((l) => l.pessoa_id === c.id).reduce((s, l) => s + l.centavos, 0);
  const maior = q(`SELECT conta, ticket_centavos t FROM oportunidades WHERE pessoa_id = ? AND fase_01_em BETWEEN ? AND ?
                   ORDER BY ticket_centavos DESC LIMIT 1`, c.id, de, fim)[0];
  const r = retro.get(c.id) || { centavos: 0, n: 0 };
  const p = (v) => (tot ? Math.round((100 * v) / tot) : 0) + "%";
  console.log(`  ${pad(c.nome, nomeLargura)} pipeline ${padE(reais(tot), 12)} · retroativo ${padE(reais(r.centavos), 10)} (${p(r.centavos)}, ${r.n} mudança(s))` +
    ` · maior ticket ${padE(reais(maior?.t), 10)} (${p(maior?.t || 0)})${maior?.t ? " " + maior.conta : ""}`);
}
console.log("");

// ---------- Conversão por consultor (blindagem c) ----------
// Leads criados há 30+ dias (tempo para fechar): pipeline com ticket > 0 →
// receita das matrículas ligadas (mesma fonte dos R$ 75.000) e ticket ganho.
const convAte = (() => { const d = new Date(de + "T12:00:00"); d.setDate(d.getDate() - 30); return iso(d); })();
console.log(`== Conversão por consultor — leads criados de 2026-07-01 a ${convAte} ==`);
const linhaConv = (rotulo, filtro, params) => {
  const r = db.prepare(
    `SELECT COUNT(*) n, SUM(o.ticket_centavos) pipe,
            SUM(CASE WHEN o.status = 'Conquistado' THEN o.ticket_centavos ELSE 0 END) ganho,
            (SELECT SUM(COALESCE(m.valor_centavos, 0)) FROM matriculas m JOIN oportunidades o2 ON o2.id = m.oportunidade_id
              WHERE (m.status IS NULL OR m.status != 'canceled') AND o2.fase_01_em BETWEEN '2026-07-01' AND @ate
                AND COALESCE(o2.ticket_centavos, 0) > 0 AND ${filtro.replace(/o\./g, "o2.")}) mat
     FROM oportunidades o WHERE o.fase_01_em BETWEEN '2026-07-01' AND @ate AND COALESCE(o.ticket_centavos, 0) > 0 AND ${filtro}`
  ).get({ ate: convAte + "T23:59:59", ...params });
  const p = (v) => (r.pipe ? ((100 * (v || 0)) / r.pipe).toFixed(1).replace(".", ",") + "%" : "—");
  console.log(`  ${pad(rotulo, nomeLargura)} ${padE(r.n, 4)} leads · pipeline ${padE(reais(r.pipe), 13)} · matrículas ligadas ${padE(reais(r.mat), 12)} (${p(r.mat)})` +
    ` · ticket ganho ${padE(reais(r.ganho), 11)} (${p(r.ganho)})`);
};
for (const c of consultores) linhaConv(c.nome, "o.pessoa_id = @pid", { pid: c.id });
linhaConv("EQUIPE", "o.pessoa_id IN (SELECT id FROM pessoas WHERE tipo = 'consultor')", {});
console.log("");

// ---------- B) avançou de fase no dia ----------
const avancos = db.prepare(
  `SELECT pessoa_id, dia, SUM(centavos) centavos, COUNT(*) n FROM (
     ${["02", "03", "04", "05"].map((f) =>
       `SELECT pessoa_id, substr(fase_${f}_em, 1, 10) dia, COALESCE(ticket_centavos, 0) centavos FROM oportunidades WHERE fase_${f}_em BETWEEN @de AND @fim`
     ).join(" UNION ALL ")}
   ) GROUP BY pessoa_id, dia`).all({ de, fim });
tabelaDiaria("B) VALOR QUE AVANÇOU NO DIA — Σ ticket das entradas em 02/03/04/05 (alternativa)", avancos);

// ---------- C) em aberto agora ----------
console.log("== C) EM ABERTO AGORA — Σ ticket das oportunidades Ativas (estoque, não é diário) ==");
const ultimaImp = q("SELECT MAX(id) id FROM importacoes WHERE tipo = 'oportunidades' AND status = 'concluida'")[0].id;
for (const c of consultores) {
  const r = q(`SELECT COUNT(*) n, SUM(COALESCE(ticket_centavos, 0)) centavos,
                      SUM(CASE WHEN importacao_id = ? THEN COALESCE(ticket_centavos, 0) ELSE 0 END) ultimo
               FROM oportunidades WHERE status = 'Ativo' AND pessoa_id = ?`, ultimaImp, c.id)[0];
  console.log(`  ${pad(c.nome, nomeLargura)} ${padE(r.n, 4)} ativas · ${padE(reais(r.centavos), 14)} · das que vieram no último arquivo: ${reais(r.ultimo)}`);
}
console.log("");

// ---------- Conversão histórica ----------
console.log("== Conversão histórica: de cada R$ 1 de pipeline criado, quanto virou venda ==");
for (const [ini, fimC] of [["2026-07-01", "2026-07-31"], ["2026-08-01", "2026-08-31"]]) {
  const r = q(`SELECT COUNT(*) n, SUM(COALESCE(ticket_centavos, 0)) tot,
                      SUM(CASE WHEN status = 'Conquistado' THEN COALESCE(ticket_centavos, 0) ELSE 0 END) ganho,
                      SUM(status = 'Conquistado') nganho, SUM(status = 'Ativo') nativo
               FROM oportunidades WHERE fase_01_em BETWEEN ? AND ?`, ini, fimC + "T23:59:59")[0];
  const mat = q(`SELECT SUM(COALESCE(m.valor_centavos, 0)) v FROM matriculas m JOIN oportunidades o ON o.id = m.oportunidade_id
                 WHERE o.fase_01_em BETWEEN ? AND ? AND (m.status IS NULL OR m.status != 'canceled')`, ini, fimC + "T23:59:59")[0].v;
  const du = diasUteisEntre(ini, fimC).length;
  console.log(`  criadas em ${ini.slice(0, 7)}: ${r.n} · pipeline ${reais(r.tot)} (${reais(r.tot / du)}/dia útil da equipe) · ` +
    `conquistado ${reais(r.ganho)} (${r.tot ? ((100 * r.ganho) / r.tot).toFixed(1).replace(".", ",") : "—"}%, ${r.nganho} vendas) · ` +
    `matrículas ligadas ${reais(mat)} · ainda ativas ${r.nativo}`);
}
console.log("");

// ---------- Mensal ----------
const hoje = iso(new Date());
const mesDe = hoje.slice(0, 8) + "01";
const ultimoDia = (() => { const d = new Date(hoje + "T12:00:00"); return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)); })();
const du = diasUteisEntre(mesDe, ultimoDia).length;
console.log("== Meta mensal derivada ==");
console.log(`  ${hoje.slice(0, 7)}: ${du} dias úteis × ${reais(META)} = ${reais(META * du)} por consultor`);
console.log(`  semana × 52 ÷ 12 = ${reais((META * 5 * 52) / 12)} por consultor`);
