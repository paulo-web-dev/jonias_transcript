"use strict";
// SOMENTE LEITURA — Rota de finalização de ano (pedido de 2026-11-10, plano
// "Resumo_Rota Final_Unyflex.pdf"). Responde, antes de codar:
//   1. as faixas alfabéticas de município casam com os municípios do IBGE?
//      (limites existem, faixas contíguas, sem lacuna nem sobreposição);
//   2. contatos APTOS de cada vendedor na faixa (regra da Rota: telefone
//      válido, não inexistente, não oculto, município casado; um item por
//      telefone), por grupo de setor da página 2 do PDF, e quantos estão
//      BLOQUEADOS POR CONTATO na data de início (rotas, CDR atribuível,
//      registro manual — tipos novos não herdam bloqueio por telefone);
//   3. faturamento de nov/dez (matrículas da cópia local, criada_em, sem
//      canceladas — a fonte da receita) por pessoa, para conferir os R$ 79.580;
//   4. dias úteis do período (tabela feriados).
// Abre o banco só para leitura; não usa rota.js nem grava nada.
//
//   node scripts/diagnostico-fim-de-ano.js <banco.db> [--inicio=2026-11-16]
//   docker compose exec -T jonias node - /app/data/aula-ai.db < scripts/diagnostico-fim-de-ano.js

const args = process.argv.slice(2);
const arquivo = args.find((a) => !a.startsWith("--"));
const opt = (n, p) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : p; };
if (!arquivo) { console.error("uso: diagnostico-fim-de-ano.js <banco.db> [--inicio=AAAA-MM-DD]"); process.exit(1); }
const INICIO = opt("inicio", "2026-11-16");
const Database = require("better-sqlite3");
const db = new Database(arquivo, { readonly: true, fileMustExist: true });

const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
  .replace(/[^A-Z0-9]+/g, " ").trim().replace(/(^| )D (?=[AEIOU])/g, "$1DO ");
const cmp = (a, b) => (norm(a) < norm(b) ? -1 : norm(a) > norm(b) ? 1 : 0);
const reais = (c) => "R$ " + (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const somarDias = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const chave = (t) => {
  let n = String(t || "").replace(/\D/g, "").replace(/^0+/, "");
  if (n.length > 11 && n.startsWith("55")) n = n.slice(2);
  if (n.length < 10) return null;
  const r = n.slice(2);
  return n.slice(0, 2) + (r.length === 9 && r[0] === "9" ? r.slice(1) : r);
};

const FAIXAS = {
  PR: [["Frederico", "ABATIA", "COLOMBO"], ["Agnes", "COLORADO", "ITAMBE"], ["Eduardo", "ITAPEJARA DO OESTE", "NOVA OLIMPIA"],
    ["Bianca", "NOVA PRATA DO IGUACU", "SALTO DO ITARARE"], ["Danilo", "SALTO DO LONTRA", "XAMBRE"]],
  SC: [["Frederico", "Abdon Batista", "Canelinha"], ["Agnes", "Canoinhas", "Ipira"], ["Eduardo", "Iporã do Oeste", "Orleans"],
    ["Bianca", "Otacílio Costa", "Santiago do Sul"], ["Danilo", "Santo Amaro da Imperatriz", "Zortéa"]],
};
// PROPOSTA de abas por setor da página 2 do PDF — a validar com o usuário
const GRUPOS = {
  "Compras e licitações": ["LICITAÇÃO PM", "LICITAÇÃO CM", "LICITAÇÃO PM - com população", "Licitação CM com Papulação", "Compras PM", "Compras CM", "COMPRAS", "PREGOEIRO", "SAUDE LICITACAO", "ETP E TR"],
  "Transparência e ouvidoria": ["TRANSPARENCIA PM", "Controle interno", "Controle Interno - CM", "CONTROLE INTERNO PM", "CONTROLE INTERNO CM"],
  "Gestão e fiscalização": ["GESTOR E FISCAL DE CONTRATOS", "Agente de contrataçãoFiscais", "JURIDICO PM", "JURIDICO CM"],
  "Patrimônio e frotas": ["PATRIMONIO PM", "FROTAS E PATRIMONIO PM", "Patrimonio CM", "PATRIMONIOFROTAS PM", "PATRIMONIOFROTAS CM"],
  "Contabilidade e tesouraria": ["CONTABILIDADE PM", "CONTABILIDADE CM", "TESOURARIA PM", "TESOURARIA CM", "FINANÇAS PM"],
  "Administração e servidores": ["RH PM", "RH CM", "Servidores CM", "Servidores Secretários", "SERVIDORES", "Planejamento", "PLANEJAMENTO"],
  "Legislativo e assessoria": ["Legislativo CM", "LEGISLATIVO CM", "ASSESSOR CM", "Chefe de Gabinete CM", "COMUNICAÇÃO CM"],
};
const grupos = Object.keys(GRUPOS);
const tem = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

console.log(`banco: ${arquivo} · user_version ${db.pragma("user_version", { simple: true })} · início ${INICIO}`);

// ---------- 1. faixas ----------
console.log("\n=== 1. FAIXAS ALFABÉTICAS × MUNICÍPIOS DO IBGE");
const dono = new Map();
for (const uf of ["PR", "SC"]) {
  const ms = db.prepare("SELECT codigo_ibge c, nome FROM municipios WHERE uf = ?").all(uf).sort((a, b) => cmp(a.nome, b.nome));
  console.log(`\n${uf}: ${ms.length} municípios`);
  let fimAnterior = -1;
  for (const [p, ini, fim] of FAIXAS[uf]) {
    const i = ms.findIndex((m) => norm(m.nome) === norm(ini));
    const j = ms.findIndex((m) => norm(m.nome) === norm(fim));
    const problema = i < 0 || j < 0 ? "  ⚠ LIMITE NÃO ENCONTRADO"
      : i !== fimAnterior + 1 ? `  ⚠ ${i > fimAnterior + 1 ? "lacuna" : "sobreposição"}: ${ms.slice(Math.min(i, fimAnterior + 1), Math.max(i, fimAnterior + 1)).map((m) => m.nome).join(", ")}` : "";
    console.log(`  ${p.padEnd(10)} ${i < 0 ? ini + " (?)" : ms[i].nome} → ${j < 0 ? fim + " (?)" : ms[j].nome}: ${i >= 0 && j >= 0 ? j - i + 1 : "?"} municípios${problema}`);
    if (i >= 0 && j >= 0) for (let k = i; k <= j; k++) dono.set(ms[k].c, p);
    fimAnterior = j;
  }
  if (fimAnterior !== ms.length - 1) console.log(`  ⚠ sobram no fim: ${ms.slice(fimAnterior + 1).map((m) => m.nome).join(", ")}`);
}

// ---------- 2. aptos e bloqueados ----------
console.log(`\n=== 2. CONTATOS APTOS NA FAIXA (bloqueio por CONTATO em ${INICIO})`);
const d30 = somarDias(INICIO, -30), d7 = somarDias(INICIO, -7);
const bloq = new Set();
if (tem("rota_itens")) for (const r of db.prepare(
  `SELECT i.contato_id FROM rota_itens i JOIN rotas r ON r.id = i.rota_id
   WHERE r.data >= ? AND (i.baixa_metodo IS NOT NULL OR r.data >= ?)`).all(d30, d7)) bloq.add(r.contato_id);
for (const r of db.prepare(`SELECT DISTINCT contato_id FROM ligacoes WHERE data_hora >= ? AND contato_id IS NOT NULL AND (sentido = 'S' OR atendida = 1)`).all(`${d30}T00:00:00`)) bloq.add(r.contato_id);
for (const r of db.prepare(`SELECT id FROM contatos_ativo WHERE data_ultimo_contato >= ? AND data_ultimo_contato <= ?`).all(d30, INICIO)) bloq.add(r.id);
for (const r of db.prepare(`SELECT DISTINCT contato_id FROM contatos_ativo_historico WHERE tipo = 'contato' AND registrado_em >= ?`).all(d30)) bloq.add(r.contato_id);

const cs = db.prepare(
  `SELECT id, uf, setor, orgao, codigo_ibge c, telefone FROM contatos_ativo
   WHERE telefone_valido = 1 AND telefone IS NOT NULL AND COALESCE(contato_inexistente, 0) = 0
     AND COALESCE(linha_oculta, 0) = 0`).all();
const t = {};
let semMunicipio = 0;
const setoresUsados = new Set(Object.values(GRUPOS).flat());
const abasForaDosGrupos = new Map();
for (const c of cs) {
  const p = dono.get(c.c);
  if (!p) { semMunicipio++; continue; }
  const k = chave(c.telefone);
  if (!k) continue;
  const x = (t[p] ??= { contatos: 0, tel: new Set(), livres: new Set(), g: {}, gl: {} });
  x.contatos++; x.tel.add(k);
  if (!bloq.has(c.id)) x.livres.add(k);
  if (!setoresUsados.has(c.setor)) abasForaDosGrupos.set(`${c.uf} ${c.setor}`, (abasForaDosGrupos.get(`${c.uf} ${c.setor}`) || 0) + 1);
  for (const g of grupos) if (GRUPOS[g].includes(c.setor)) {
    (x.g[g] ??= new Set()).add(k);
    if (!bloq.has(c.id)) (x.gl[g] ??= new Set()).add(k);
  }
}
console.log(`aptos sem município casado (fora de qualquer faixa): ${semMunicipio}`);
console.log("\nvendedor   contatos aptos · telefones distintos (livres em " + INICIO + ")");
for (const [p, x] of Object.entries(t)) console.log(`  ${p.padEnd(10)} ${String(x.contatos).padStart(5)} · ${x.tel.size} (${x.livres.size})`);
console.log("\ntelefones distintos por grupo de setor — total (livres em " + INICIO + ")  [⚠ abas por grupo = PROPOSTA]");
console.log("  " + "".padEnd(28) + Object.keys(t).map((p) => p.padStart(13)).join(""));
for (const g of grupos) console.log("  " + g.padEnd(28) + Object.values(t).map((x) => `${x.g[g]?.size || 0} (${x.gl[g]?.size || 0})`.padStart(13)).join(""));
console.log("\nabas da base FORA dos grupos (contatos aptos na faixa): " + [...abasForaDosGrupos].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(" · "));
const aut = db.prepare(`SELECT uf, setor, COUNT(*) n, SUM(telefone_valido = 1 AND COALESCE(contato_inexistente,0) = 0 AND COALESCE(linha_oculta,0) = 0) aptos
  FROM contatos_ativo WHERE orgao = 'Autarquia' GROUP BY uf, setor`).all();
console.log("autarquias/RPPS já na base: " + aut.map((a) => `${a.uf} ${a.setor} ${a.n} linhas/${a.aptos} aptas`).join(" · "));

// ---------- 3. faturamento ----------
console.log("\n=== 3. FATURAMENTO NOV/DEZ (matrículas, criada_em, sem canceladas)");
const sync = db.prepare("SELECT MAX(concluido_em) u FROM importacoes WHERE tipo = 'mysql' AND status = 'concluida'").get();
const maxCriada = db.prepare("SELECT MAX(criada_em) m FROM matriculas").get();
console.log(`último sync Unyflex concluído: ${sync?.u || "—"} · matrícula mais recente na cópia: ${maxCriada.m}`);
const linhas = db.prepare(
  `SELECT COALESCE(p.nome, '(sem atribuição)') nome, COALESCE(p.tipo, '-') tipo,
          SUM(m.status IS NULL OR m.status != 'canceled') n, SUM(CASE WHEN m.status IS NULL OR m.status != 'canceled' THEN m.valor_centavos ELSE 0 END) v,
          SUM(m.status = 'canceled') nc, SUM(CASE WHEN m.status = 'canceled' THEN m.valor_centavos ELSE 0 END) vc
   FROM matriculas m LEFT JOIN pessoas p ON p.id = m.pessoa_id
   WHERE m.criada_em >= '2026-11-01' AND m.criada_em < '2027-01-01'
   GROUP BY 1, 2 ORDER BY v DESC`).all();
const PDF = { Frederico: 2128000, Agnes: 940000, Eduardo: 2410000, Bianca: 1450000, Renato: 1030000 };
let tc = 0, te = 0, tcan = 0;
for (const l of linhas) {
  if (l.tipo === "consultor") tc += l.v || 0;
  te += l.v || 0; tcan += l.vc || 0;
  const ref = PDF[l.nome];
  console.log(`  ${l.nome.padEnd(18)} ${l.tipo.padEnd(9)} ${String(l.n || 0).padStart(3)} matr. ${reais(l.v || 0).padStart(14)}` +
    `${ref !== undefined ? `   PDF ${reais(ref)}  dif ${reais((l.v || 0) - ref)}` : ""}` +
    `${l.nc ? `   canceladas: ${l.nc} / ${reais(l.vc)}` : ""}`);
}
for (const n of Object.keys(PDF)) if (!linhas.some((l) => l.nome === n)) console.log(`  ${n.padEnd(18)} sem matrícula no período   PDF ${reais(PDF[n])}`);
console.log(`  consultores: ${reais(tc)} · empresa (com canais e sem atribuição): ${reais(te)} · PDF: R$ 79.580,00 · canceladas fora: ${reais(tcan)}`);

// ---------- 4. dias úteis ----------
console.log("\n=== 4. DIAS ÚTEIS (seg–sex fora da tabela feriados)");
const fer = new Set(tem("feriados") ? db.prepare("SELECT data FROM feriados").all().map((r) => r.data) : []);
const uteis = (de, ate) => { const r = []; for (let d = de; d <= ate; d = somarDias(d, 1)) { const w = new Date(d + "T12:00:00Z").getUTCDay(); if (w > 0 && w < 6 && !fer.has(d)) r.push(d); } return r; };
for (const [de, ate] of [["2026-11-11", "2026-12-15"], ["2026-11-16", "2026-12-15"], ["2026-11-11", "2026-12-18"]]) {
  const u = uteis(de, ate);
  const dow = (d) => "dstqqss"[new Date(d + "T12:00:00Z").getUTCDay()];
  console.log(`  ${de} a ${ate}: ${u.length} dias úteis (seg/qua/sex ${u.filter((d) => "sqs".includes(dow(d)) && [1, 3, 5].includes(new Date(d + "T12:00:00Z").getUTCDay())).length}, ter/qui ${u.filter((d) => [2, 4].includes(new Date(d + "T12:00:00Z").getUTCDay())).length})`);
}
console.log(`  feriados no intervalo: ${[...fer].filter((d) => d >= "2026-11-11" && d <= "2026-12-18").join(", ")}`);
