"use strict";
// SOMENTE LEITURA — saída de um vendedor do plano de FIM DE ANO (pedido de
// 2026-11-19, saída do Danilo). Mede, antes de decidir e de codar a migração:
//   1. o que existe no nome dele (ramal e vigências, contatos, órgãos novos,
//      carteiras, usuário, campanhas, ligações, oportunidades, matrículas) —
//      nada disto é apagado na saída; serve para o "antes" e o "depois";
//   2. a faixa alfabética dele e as DUAS opções de redistribuição
//      (A = dividir em quatro blocos alfabéticos contíguos, equilibrados por
//      itens possíveis; B = inteira para quem tem menos itens livres),
//      com itens possíveis/livres e dias de estoque (÷ 45) de cada um contra os
//      dias úteis que faltam até 15/12;
//   3. os órgãos novos dele, nas mesmas duas opções (20 por dia);
//   4. as rotas já geradas depois da saída (dele e dos outros — as dos outros
//      precisam ser refeitas para ver a faixa nova);
//   5. cotas individuais e contador: o que ele vendeu em nov/dez; coletivo
//      fixo, cotas dos que ficam sem mudança, a cota dele vira lacuna sem dono
//      (decisão do usuário, 2026-11-19).
// Não usa db.js nem rota.js e não grava nada.
//
//   node scripts/diagnostico-saida-vendedor.js <banco.db> --pessoa=Danilo --saida=AAAA-MM-DD
//   docker compose exec -T jonias node - /app/data/aula-ai.db --pessoa=Danilo --saida=AAAA-MM-DD < scripts/diagnostico-saida-vendedor.js

const args = process.argv.slice(2);
const arquivo = args.find((a) => !a.startsWith("--"));
const opt = (n, p) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : p; };
const NOME = opt("pessoa", "Danilo");
const SAIDA = opt("saida", null); // último dia de trabalho
if (!arquivo || !/^\d{4}-\d{2}-\d{2}$/.test(SAIDA || "")) {
  console.error("uso: diagnostico-saida-vendedor.js <banco.db> --pessoa=Nome --saida=AAAA-MM-DD (último dia)");
  process.exit(1);
}
const Database = require("better-sqlite3");
const db = new Database(arquivo, { readonly: true, fileMustExist: true });

const FIM = "2026-12-15";
const COTA = 45;
const NOVOS_POR_DIA = 20;
const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
  .replace(/[^A-Z0-9]+/g, " ").trim().replace(/(^| )D (?=[AEIOU])/g, "$1DO ");
const reais = (c) => "R$ " + ((c || 0) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const somarDias = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const chave = (t) => {
  let n = String(t || "").replace(/\D/g, "").replace(/^0+/, "");
  if (n.length > 11 && n.startsWith("55")) n = n.slice(2);
  if (n.length < 10) return null;
  const r = n.slice(2);
  return n.slice(0, 2) + (r.length === 9 && r[0] === "9" ? r.slice(1) : r);
};
const tem = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const q = (sql, ...a) => db.prepare(sql).all(...a);
const g = (sql, ...a) => db.prepare(sql).get(...a);

const DESDE = somarDias(SAIDA, 1); // primeiro dia sem ele
const HOJE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
// A redistribuição só vale para rota ainda não começada: de amanhã em diante
// (saída no passado) ou do dia seguinte à saída (saída no futuro)
const REFAZ = DESDE > HOJE ? DESDE : somarDias(HOJE, 1);
const fer = new Set(tem("feriados") ? q("SELECT data FROM feriados").map((r) => r.data) : []);
const uteis = (de, ate) => { const r = []; for (let d = de; d <= ate; d = somarDias(d, 1)) { const w = new Date(d + "T12:00:00Z").getUTCDay(); if (w > 0 && w < 6 && !fer.has(d)) r.push(d); } return r; };
const diasRestantes = uteis(REFAZ, FIM).length;

const p = g("SELECT * FROM pessoas WHERE nome = ?", NOME);
if (!p) { console.error(`pessoa "${NOME}" não encontrada`); process.exit(1); }
console.log(`banco: ${arquivo} · user_version ${db.pragma("user_version", { simple: true })}`);
console.log(`${p.nome} (id ${p.id}) · último dia ${SAIDA} · sem ele desde ${DESDE} · hoje ${HOJE} · redistribuição vale de ${REFAZ} (${diasRestantes} dia(s) útil(eis) até ${FIM})`);

// ---------- 1. o que existe no nome dele ----------
console.log("\n=== 1. NO NOME DELE (nada disto é apagado)");
console.log(`pessoas: ativo ${p.ativo} · entra_painel ${p.entra_painel} · entra_tv ${p.entra_tv} · entra_feedback ${p.entra_feedback} · ramal ${p.ramal ?? "—"} · wallet "${p.wallet_nome ?? "—"}"`);
for (const v of q("SELECT ramal, pessoa_id, vigente_desde, vigente_ate FROM ramal_vigencias WHERE ramal IN (SELECT ramal FROM ramal_vigencias WHERE pessoa_id = ?) ORDER BY ramal, vigente_desde", p.id)) {
  const dono = g("SELECT nome FROM pessoas WHERE id = ?", v.pessoa_id)?.nome;
  console.log(`  ramal ${v.ramal}: ${dono} ${v.vigente_desde ?? "(início)"} → ${v.vigente_ate ?? "(aberto)"}`);
}
const lig = g("SELECT COUNT(*) n, MIN(data_hora) a, MAX(data_hora) b FROM ligacoes WHERE pessoa_id = ?", p.id);
console.log(`ligações: ${lig.n} (${lig.a ?? "—"} → ${lig.b ?? "—"})`);
if (p.ramal) {
  const depois = g("SELECT COUNT(*) n FROM ligacoes WHERE ramal = ? AND data_hora >= ?", p.ramal, `${DESDE}T00:00:00`).n;
  console.log(`  ligações do ramal ${p.ramal} depois da saída (ficariam sem dono): ${depois}`);
}
console.log(`oportunidades por status: ${q("SELECT status, COUNT(*) n FROM oportunidades WHERE pessoa_id = ? GROUP BY status", p.id).map((r) => `${r.status} ${r.n}`).join(" · ") || "nenhuma"}`);
const mt = q(`SELECT substr(criada_em, 1, 7) mes, SUM(status IS NULL OR status != 'canceled') n, SUM(CASE WHEN status IS NULL OR status != 'canceled' THEN valor_centavos ELSE 0 END) v,
  SUM(status = 'canceled') nc FROM matriculas WHERE pessoa_id = ? GROUP BY 1 ORDER BY 1`, p.id);
console.log(`matrículas: ${mt.map((r) => `${r.mes} ${r.n} / ${reais(r.v)}${r.nc ? ` (+${r.nc} canceladas)` : ""}`).join(" · ") || "nenhuma"}`);
console.log(`  wallets na cópia casados com ele: ${q("SELECT wallet, COUNT(*) n FROM matriculas WHERE pessoa_id = ? GROUP BY wallet", p.id).map((r) => `"${r.wallet}" ${r.n}`).join(" · ") || "—"}`);
console.log(`contatos com ele como consultor: ${q("SELECT COALESCE(origem, '?') o, COUNT(*) n FROM contatos_ativo WHERE pessoa_id = ? GROUP BY 1", p.id).map((r) => `${r.o} ${r.n}`).join(" · ") || "nenhum"}`);
console.log(`carteiras: ${q("SELECT r.sigla, c.papel FROM carteiras c JOIN regionais r ON r.id = c.regional_id WHERE c.pessoa_id = ?", p.id).map((r) => `${r.sigla} (${r.papel})`).join(", ") || "nenhuma"}`);
console.log(`usuários: ${q("SELECT login, papel, ativo FROM usuarios WHERE pessoa_id = ?", p.id).map((u) => `${u.login} ${u.papel} ativo=${u.ativo}`).join(", ") || "nenhum"}`);
console.log(`campanhas próprias: ${q("SELECT id, modo, vale_desde, tipo_id FROM rota_campanhas WHERE pessoa_id = ? ORDER BY vale_desde", p.id).map((c) => `#${c.id} ${c.modo} desde ${c.vale_desde}${c.tipo_id ? "" : " (encerrada)"}`).join(" · ") || "nenhuma"}`);
if (tem("marcacoes_prospeccao")) console.log(`marcações pessoais (do usuário dele): ${g("SELECT COUNT(*) n FROM marcacoes_prospeccao m JOIN usuarios u ON u.id = m.usuario_id WHERE u.pessoa_id = ?", p.id).n}`);
console.log(`baixas de rota feitas: ${g("SELECT COUNT(*) n FROM rota_itens i JOIN rotas r ON r.id = i.rota_id WHERE r.pessoa_id = ? AND i.baixa_metodo IS NOT NULL", p.id).n}`);

// ---------- 2. faixa ----------
const faixas = q(`SELECT f.id, f.pessoa_id pid, x.nome, f.uf, f.inicio, f.fim FROM faixas_vendedor f JOIN pessoas x ON x.id = f.pessoa_id
  WHERE f.vigente_desde <= ? AND (f.vigente_ate IS NULL OR f.vigente_ate >= ?) ORDER BY f.uf, f.id`, SAIDA, SAIDA);
const outros = [...new Map(faixas.filter((f) => f.pid !== p.id).map((f) => [f.pid, f.nome])).entries()].map(([id, nome]) => ({ id, nome }));
const dono = new Map(); // código IBGE → pid
const ordemUf = {};     // uf → municípios da faixa dele, em ordem alfabética
for (const uf of [...new Set(faixas.map((f) => f.uf))]) {
  const ms = q("SELECT codigo_ibge c, nome FROM municipios WHERE uf = ?", uf).map((m) => ({ ...m, n: norm(m.nome) })).sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
  for (const f of faixas.filter((x) => x.uf === uf)) {
    const i = ms.findIndex((m) => m.n === norm(f.inicio)), j = ms.findIndex((m) => m.n === norm(f.fim));
    if (i < 0 || j < 0) { console.log(`⚠ faixa ${f.nome} ${uf} não casou com o IBGE`); continue; }
    for (let k = i; k <= j; k++) dono.set(ms[k].c, f.pid);
    if (f.pid === p.id) ordemUf[uf] = ms.slice(i, j + 1);
  }
}
// bloqueio por CONTATO no primeiro dia sem ele (mesma régua do diagnóstico do
// fim de ano: rota com baixa 30 d / sem baixa 7 d, CDR atribuível, registro manual)
const d30 = somarDias(REFAZ, -30), d7 = somarDias(REFAZ, -7);
const bloq = new Set();
for (const r of q(`SELECT i.contato_id FROM rota_itens i JOIN rotas r ON r.id = i.rota_id WHERE r.data >= ? AND r.data < ? AND (i.baixa_metodo IS NOT NULL OR r.data >= ?)`, d30, REFAZ, d7)) bloq.add(r.contato_id);
for (const r of q(`SELECT DISTINCT contato_id FROM ligacoes WHERE data_hora >= ? AND contato_id IS NOT NULL AND (sentido = 'S' OR atendida = 1)`, `${d30}T00:00:00`)) bloq.add(r.contato_id);
for (const r of q(`SELECT id FROM contatos_ativo WHERE data_ultimo_contato >= ? AND data_ultimo_contato <= ?`, d30, REFAZ)) bloq.add(r.id);
for (const r of q(`SELECT DISTINCT contato_id FROM contatos_ativo_historico WHERE tipo = 'contato' AND registrado_em >= ?`, d30)) bloq.add(r.contato_id);

// Capacidade = Σ por CURSO do fim de ano (tipos de fim_ano_cursos, sem o de
// órgãos novos) dos telefones distintos daquele curso na faixa: dentro de um
// curso o telefone não se repete; entre cursos o bloqueio é por CONTATO, então
// o mesmo número volta com outro setor. É o que a geração consegue pôr nas 45.
const tiposFa = q(`SELECT c.tipo_id id, t.setores_json s FROM fim_ano_cursos c JOIN rota_tipos t ON t.id = c.tipo_id WHERE c.papel != 'novos' AND t.ativo = 1`);
const tiposDaAba = new Map(); // "uf|setor" → [tipoId]
for (const t of tiposFa) for (const s of JSON.parse(t.s || "[]")) {
  const k = `${s.uf}|${s.setor}`; (tiposDaAba.get(k) ?? tiposDaAba.set(k, []).get(k)).push(t.id);
}
const aptos = q(`SELECT id, uf, setor, codigo_ibge c, telefone FROM contatos_ativo WHERE COALESCE(origem, '') != 'orgaos_novos'
  AND telefone_valido = 1 AND telefone IS NOT NULL AND COALESCE(contato_inexistente, 0) = 0 AND COALESCE(linha_oculta, 0) = 0`);
// por município × curso: telefones aptos e livres
const porMun = new Map(); // código → Map(tipo → {tel, livres})
for (const c of aptos) {
  const k = chave(c.telefone); if (!k || !c.c) continue;
  for (const tipo of tiposDaAba.get(`${c.uf}|${c.setor}`) || []) {
    const m = porMun.get(c.c) ?? porMun.set(c.c, new Map()).get(c.c);
    const x = m.get(tipo) ?? m.set(tipo, { tel: new Set(), livres: new Set() }).get(tipo);
    x.tel.add(k); if (!bloq.has(c.id)) x.livres.add(k);
  }
}
function medir(atribuicao) { // código → pid; devolve {mun, tel: n, livres: n} somando por curso
  const acc = new Map();
  for (const [c, pid] of atribuicao) {
    const x = acc.get(pid) ?? acc.set(pid, { mun: 0, t: new Map() }).get(pid);
    x.mun++;
    for (const [tipo, v] of porMun.get(c) || []) {
      const y = x.t.get(tipo) ?? x.t.set(tipo, { tel: new Set(), livres: new Set() }).get(tipo);
      v.tel.forEach((z) => y.tel.add(z)); v.livres.forEach((z) => y.livres.add(z));
    }
  }
  const r = new Map();
  for (const [pid, x] of acc) {
    let tel = 0, livres = 0;
    for (const y of x.t.values()) { tel += y.tel.size; livres += y.livres.size; }
    r.set(pid, { mun: x.mun, tel: { size: tel }, livres: { size: livres } });
  }
  return r;
}
const atual = medir(dono);
const dias = (n) => (n / COTA).toFixed(1).replace(".", ",");
function tabela(titulo, cenario, extra = () => "") {
  console.log(`\n${titulo}`);
  console.log("  vendedor     municípios   itens possíveis   livres   dias de estoque (livres ÷ 45)   vs " + diasRestantes + " dias úteis");
  for (const o of outros) {
    const a = atual.get(o.id), b = cenario.get(o.id);
    const linha = (x) => `${String(x.mun).padStart(4)} ${String(x.tel.size).padStart(6)} ${String(x.livres.size).padStart(6)} ${dias(x.livres.size).padStart(6)}`;
    console.log(`  ${o.nome.padEnd(10)} ${linha(a)}  →  ${linha(b)}   ${b.livres.size / COTA >= diasRestantes ? "sobra" : "CURTO"} ${extra(o)}`);
  }
}
const dele = atual.get(p.id) || { mun: 0, tel: new Set(), livres: new Set() };
console.log(`\n=== 2. FAIXA DELE: ${faixas.filter((f) => f.pid === p.id).map((f) => `${f.uf} ${f.inicio} → ${f.fim}`).join(" · ")}`);
console.log(`${dele.mun} municípios · ${dele.tel.size} itens possíveis · ${dele.livres.size} livres em ${REFAZ} (${dias(dele.livres.size)} dias de 45)`);
console.log(`(itens possíveis = Σ por curso do fim de ano dos telefones distintos na faixa; livres = sem bloqueio por contato no 1º dia sem ele;`);
console.log(` não desconta as rotas já geradas à frente — a geração do período inteiro já reservou parte disto)`);
tabela("Hoje (sem redistribuir):", atual);

// A — dividir em quatro: cada UF em blocos alfabéticos contíguos com ~1/4 dos
// itens possíveis; o bloco i vai para o i-ésimo vendedor, na ordem das faixas.
const atribA = new Map(dono);
const blocosA = [];
const pesoMun = (c) => [...(porMun.get(c)?.values() || [])].reduce((s, v) => s + v.tel.size, 0);
for (const [uf, ms] of Object.entries(ordemUf)) {
  const pesos = ms.map((m) => pesoMun(m.c));
  const total = pesos.reduce((s, x) => s + x, 0);
  let acum = 0, i = 0;
  outros.forEach((o, k) => {
    const alvo = (total * (k + 1)) / outros.length;
    const ini = i;
    while (i < ms.length && (k === outros.length - 1 || acum + pesos[i] / 2 <= alvo)) { acum += pesos[i]; atribA.set(ms[i].c, o.id); i++; }
    if (i > ini) blocosA.push(`${o.nome} ${uf} ${ms[ini].nome} → ${ms[i - 1].nome} (${i - ini} mun.)`);
  });
}
console.log("\nOPÇÃO A — dividir em quatro (blocos alfabéticos contíguos, ~¼ dos itens possíveis cada):");
blocosA.forEach((b) => console.log("  " + b));
tabela("Impacto (A):", medir(atribA));

// B — inteira para quem tem menos itens LIVRES no primeiro dia sem ele
const menor = [...outros].sort((a, b) => atual.get(a.id).livres.size - atual.get(b.id).livres.size)[0];
const atribB = new Map(dono);
for (const ms of Object.values(ordemUf)) for (const m of ms) atribB.set(m.c, menor.id);
console.log(`\nOPÇÃO B — inteira para ${menor.nome} (menos itens livres hoje)`);
tabela("Impacto (B):", medir(atribB));

// ---------- 3. órgãos novos ----------
console.log(`\n=== 3. ÓRGÃOS NOVOS (origem = 'orgaos_novos'; ${NOVOS_POR_DIA} por dia)`);
const og = q(`SELECT pessoa_id pid, COUNT(*) n, SUM(telefone_valido = 1) tel FROM contatos_ativo WHERE origem = 'orgaos_novos' GROUP BY pessoa_id`);
const ogDe = (id) => og.find((r) => r.pid === id) || { n: 0, tel: 0 };
const feitos = (id) => g(`SELECT COUNT(DISTINCT i.contato_id) n FROM rota_itens i JOIN rotas r ON r.id = i.rota_id JOIN contatos_ativo c ON c.id = i.contato_id
  WHERE c.origem = 'orgaos_novos' AND c.pessoa_id = ? AND i.baixa_metodo IS NOT NULL`, id).n;
const dOg = ogDe(p.id);
console.log(`dele: ${dOg.n} órgãos (${dOg.tel || 0} com telefone; ${feitos(p.id)} já com baixa em rota)`);
const repartido = Math.floor(dOg.n / outros.length), resto = dOg.n % outros.length;
console.log("  vendedor     hoje   A (divididos)   B (todos para " + menor.nome + ")   dias de órgãos novos (÷ 20): hoje → A → B");
outros.forEach((o, k) => {
  const h = ogDe(o.id).n, a = h + repartido + (k < resto ? 1 : 0), b = h + (o.id === menor.id ? dOg.n : 0);
  const d = (n) => (n / NOVOS_POR_DIA).toFixed(1).replace(".", ",");
  console.log(`  ${o.nome.padEnd(10)} ${String(h).padStart(5)} ${String(a).padStart(10)} ${String(b).padStart(16)}            ${d(h)} → ${d(a)} → ${d(b)}`);
});

// ---------- 4. rotas futuras ----------
console.log(`\n=== 4. ROTAS JÁ GERADAS DE ${DESDE} A ${FIM}`);
for (const r of q(`SELECT x.nome, COUNT(DISTINCT r.id) rotas, MIN(r.data) de, MAX(r.data) ate,
    SUM(i.extra = 0) base, SUM(i.extra = 1) extra, SUM(i.extra = 2) novos, SUM(i.baixa_metodo IS NOT NULL) baixas,
    COUNT(DISTINCT CASE WHEN i.baixa_metodo IS NOT NULL THEN r.id END) rotasComBaixa
  FROM rotas r JOIN pessoas x ON x.id = r.pessoa_id LEFT JOIN rota_itens i ON i.rota_id = r.id
  WHERE r.data BETWEEN ? AND ? GROUP BY x.id ORDER BY x.nome`, DESDE, FIM)) {
  console.log(`  ${r.nome.padEnd(10)} ${r.rotas} rota(s) ${r.de} → ${r.ate} · itens base ${r.base} / extra ${r.extra} / órgãos ${r.novos} · ${r.baixas} baixa(s) em ${r.rotasComBaixa} rota(s)`);
}
console.log(`  plano (fim_ano_plano) dele de ${DESDE} em diante: ${g("SELECT COUNT(*) n FROM fim_ano_plano WHERE pessoa_id = ? AND data >= ?", p.id, DESDE).n} célula(s)`);
const posSaida = q(`SELECT i.baixa_metodo m, COUNT(*) n FROM rota_itens i JOIN rotas r ON r.id = i.rota_id
  WHERE r.pessoa_id = ? AND r.data >= ? AND i.baixa_metodo IS NOT NULL GROUP BY 1`, p.id, DESDE);
console.log(`  baixas nas rotas DELE depois da saída: ${posSaida.map((x) => `${x.m} ${x.n}`).join(" · ") || "nenhuma"}` +
  (posSaida.length ? "  ⚠ alguém trabalhou essas rotas (ramal dele no CDR ou registro manual) — decidir antes de descartar" : ""));

// ---------- 5. cotas e contador ----------
console.log("\n=== 5. COTAS INDIVIDUAIS E CONTADOR (matrículas nov/dez por criada_em, sem canceladas, só consultores)");
const vend = new Map(q(`SELECT m.pessoa_id pid, SUM(m.valor_centavos) v FROM matriculas m JOIN pessoas x ON x.id = m.pessoa_id
  WHERE x.tipo = 'consultor' AND m.criada_em BETWEEN '2026-11-01T00:00:00' AND '2026-12-31T23:59:59' AND (m.status IS NULL OR m.status != 'canceled')
  GROUP BY m.pessoa_id`).map((r) => [r.pid, r.v || 0]));
const total = [...vend.values()].reduce((s, v) => s + v, 0);
const sync = g("SELECT MAX(concluido_em) u FROM importacoes WHERE tipo = 'mysql' AND status = 'concluida'")?.u;
console.log(`último sync Unyflex: ${sync ?? "—"} · contador (todos os consultores): ${reais(total)} · ${p.nome}: ${reais(vend.get(p.id) || 0)}`);
const meta = (ind, pid) => g(`SELECT valor FROM metas WHERE indicador = ? AND (pessoa_id = ? OR pessoa_id IS NULL) AND vigente_desde <= ? AND (vigente_ate IS NULL OR vigente_ate >= ?)
  ORDER BY pessoa_id IS NULL, vigente_desde DESC LIMIT 1`, ind, pid, HOJE, HOJE)?.valor ?? null;
// Decisão do usuário (2026-11-19): coletivo fica em R$ 500/400 mil, as cotas
// dos que ficam NÃO sobem, e a cota de quem saiu vira lacuna coletiva sem dono.
const diasCota = uteis(HOJE, FIM).length; // como o contador: hoje incluído
for (const [ind, rot, coletiva] of [["cota_fim_ano_super", "SUPERMETA", 50000000], ["cota_fim_ano_base", "BASE", 40000000]]) {
  const soma = outros.reduce((s, o) => s + (meta(ind, o.id) || 0), 0);
  console.log(`\n${rot}: coletivo ${reais(coletiva)} · cotas dos ${outros.length} somam ${reais(soma)} · lacuna sem dono ${reais(coletiva - soma)} (cota de ${p.nome}: ${reais(meta(ind, p.id))}, não repassada)`);
  console.log("  vendedor     vendido nov/dez   cota            falta          por dia útil (hoje incluído)");
  for (const o of outros) {
    const m = meta(ind, o.id), v = vend.get(o.id) || 0;
    console.log(`  ${o.nome.padEnd(10)} ${reais(v).padStart(15)}   ${reais(m).padEnd(15)} ${reais(Math.max(0, m - v)).padEnd(14)} ${reais(Math.ceil(Math.max(0, m - v) / Math.max(1, diasCota)))}`);
  }
}
console.log(`\nfora das cotas depois da migração (contam no coletivo): ${q("SELECT id, nome FROM pessoas WHERE tipo = 'consultor'").filter((x) => !outros.some((o) => o.id === x.id) && vend.get(x.id)).map((x) => `${x.nome} ${reais(vend.get(x.id))}`).join(" · ") || "ninguém"}`);
console.log(`(${diasCota} dias úteis de ${HOJE} a ${FIM}, hoje incluído, como o contador)`);
