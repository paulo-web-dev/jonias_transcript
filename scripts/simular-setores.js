"use strict";
// SOMENTE LEITURA — Rota por SETOR DE VENDEDOR (decisões do usuário em
// 2026-10-27): sem regionais, cada vendedor liga para os SEUS setores em todo
// o PR e SC, a partir de 03/11. Responde, antes de codar e depois em produção:
//   1. estoque de cada vendedor em dias de rota (um item por telefone);
//   2. telefones BLOQUEADOS pelo que já aconteceu (rotas de outubro, CDR
//      atribuível, registro manual) nas primeiras datas — por contato (regra T,
//      tipos novos) e, à parte, quanto seria se o bloqueio fosse por telefone;
//   3. telefones em comum entre vendedores;
//   4. as três regras de bloqueio simuladas dia a dia (T, V, E);
//   5. COMPLEMENTOS candidatos para Bianca e Eduardo: cada um como 2º tipo da
//      fila do vendedor (o principal primeiro; o complemento só quando falta
//      estoque), quantos dias acrescenta e quantas rotas curtas sobram.
// Abre o banco só para leitura; não usa rota.js nem grava nada.
//
//   node scripts/simular-setores.js <banco.db> [--de=2026-11-03] [--ate=2026-12-31] [--cota=45] [--extra=15] [--baixa=100]
//   docker compose exec -T jonias node - /app/data/aula-ai.db < scripts/simular-setores.js
//
// Regras (todas com "um telefone por dia em todas as rotas"):
//   T  por TIPO (regra B atual — decisão do usuário): telefone 30 d dentro do
//      mesmo tipo, contato 30 d entre tipos
//   V  por VENDEDOR: telefone 30 d só para quem ligou; outro, só no mesmo dia
//   E  ESTRITA: telefone 30 d para todo mundo
// Suposições: --baixa % dos itens recebem ligação (30 d), o resto bloqueia 7 d;
// a Rota Extra é simulada como cota maior (45 + 15, todas feitas — pior caso
// para o estoque); o consultor do contato (pessoa_id) é IGNORADO (o setor
// manda); feriados = FERIADOS.

const path = require("path");
const args = process.argv.slice(2);
const arquivo = args.find((a) => !a.startsWith("--"));
const opt = (n, p) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : p; };
if (!arquivo) { console.error("uso: simular-setores.js <banco.db> [--de=AAAA-MM-DD] [--ate=AAAA-MM-DD] [--cota=45] [--extra=15] [--baixa=100]"); process.exit(1); }
const DE = opt("de", "2026-11-03"), ATE = opt("ate", "2026-12-31");
const COTA = Number(opt("cota", 45)), EXTRA = Number(opt("extra", 15));
const BAIXA = Number(opt("baixa", 100)) / 100;
const FERIADOS = new Set(["2026-11-02", "2026-11-15", "2026-11-20", "2026-12-25", "2027-01-01"]);

// Setores por vendedor (nomes EXATOS das abas), com as decisões de 2026-10-27
const PR = "PR", SC = "SC";
const VENDEDORES = [
  { nome: "Frederico", tipo: "Legislativo", setores: [
    [PR, "Legislativo CM"], [SC, "LEGISLATIVO CM"], [PR, "ASSESSOR CM"], [SC, "ASSESSOR CM"], [PR, "Servidores CM"],
    [PR, "Chefe de Gabinete CM"], [PR, "JURIDICO CM"], [SC, "JURIDICO CM"], [PR, "CONTABILIDADE CM"], [SC, "CONTABILIDADE CM"],
    [PR, "Patrimonio CM"], [SC, "PATRIMONIOFROTAS CM"], [PR, "Compras CM"],
    [PR, "COMUNICAÇÃO CM"], [SC, "COMUNICAÇÃO CM"], [PR, "Controle Interno - CM"], [SC, "CONTROLE INTERNO CM"],
    [PR, "TESOURARIA CM"], [SC, "TESOURARIA CM"], [PR, "RH CM"], [SC, "RH CM"]] },
  { nome: "Bianca", tipo: "Patrimônio", setores: [[PR, "PATRIMONIO PM"], [PR, "FROTAS E PATRIMONIO PM"], [SC, "PATRIMONIOFROTAS PM"]] },
  { nome: "Renato", tipo: "Comunicação", setores: [
    [PR, "COMUNICAÇÃO PM"], [SC, "COMUNICAÇÃO PM"], [PR, "SECOM"], [PR, "ASSESSOR PM"], [SC, "ASSESSOR PM"], [PR, "Gabinete PM"], [SC, "GABINETE PM"]] },
  { nome: "Eduardo", tipo: "Finanças", setores: [
    [PR, "TESOURARIA PM"], [SC, "TESOURARIA PM"], [PR, "CONTABILIDADE PM"], [SC, "CONTABILIDADE PM"], [PR, "FINANÇAS PM"],
    [PR, "Planejamento"], [SC, "PLANEJAMENTO"]] },
  { nome: "Agnes", tipo: "Licitação", setores: [
    [PR, "LICITAÇÃO PM"], [SC, "LICITAÇÃO PM"], [PR, "LICITAÇÃO CM"], [SC, "LICITAÇÃO CM"], [PR, "PREGOEIRO"], [SC, "PREGOEIRO"],
    [PR, "Compras PM"], [PR, "ETP E TR"], [PR, "GESTOR E FISCAL DE CONTRATOS"],
    [PR, "LICITAÇÃO PM - com população"], [PR, "Licitação CM com Papulação"], [SC, "COMPRAS"], [SC, "SAUDE LICITACAO"],
    [SC, "Agente de contrataçãoFiscais"]] },
];

// Complementos candidatos (2º tipo da fila) — só abas que não são de ninguém
const COMPLEMENTOS = {
  Bianca: [
    { nome: "Engenharia e Obras", setores: [[PR, "Engenheiros"], [SC, "ENGENHEIROS"], [PR, "Obras e Urbanismo"], [SC, "OBRAS PM "]] },
    { nome: "Controle Interno PM", setores: [[PR, "Controle interno"], [SC, "CONTROLE INTERNO PM"]] },
    { nome: "Educação (frota escolar)", setores: [[PR, "Educação"]] },
    { nome: "Meio Ambiente", setores: [[PR, "Meio Ambiente PM"], [SC, "MEIO AMBIENTE"]] },
  ],
  Eduardo: [
    { nome: "Controle Interno PM", setores: [[PR, "Controle interno"], [SC, "CONTROLE INTERNO PM"]] },
    { nome: "Tributação", setores: [[PR, "TRIBUTAÇÃO"], [SC, "PM TRIBUTAÇÃO"]] },
    { nome: "Transparência", setores: [[PR, "TRANSPARENCIA PM"]] },
    { nome: "RPPS / Autarquias", setores: [[PR, "RPPS PARANA"], [SC, "RPPS"], [PR, "Autarquia"], [PR, "AUTARQUIA PR"]] },
  ],
};

function normalizarNumero(v) {
  let n = String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if ((n.length === 12 || n.length === 13) && n.startsWith("55")) n = n.slice(2);
  return n;
}
function chaveTelefone(t) {
  const n = normalizarNumero(t);
  if (n.length < 10) return null;
  const v = new Set([n]);
  if (n.length === 11 && n[2] === "9") v.add(n.slice(0, 2) + n.slice(3));
  if (n.length === 10 && /[6-9]/.test(n[2])) v.add(n.slice(0, 2) + "9" + n.slice(2));
  return [...v].sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}
const somarDias = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const util = (iso) => { const w = new Date(`${iso}T12:00:00Z`).getUTCDay(); return w >= 1 && w <= 5 && !FERIADOS.has(iso); };
const dias = []; for (let d = DE; d <= ATE; d = somarDias(d, 1)) if (util(d)) dias.push(d);
const f1 = (n) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const pad = (s, n) => String(s).padEnd(n), lpad = (s, n) => String(s).padStart(n);

const Database = require(require.resolve("better-sqlite3", { paths: [process.cwd(), path.join(__dirname, "..")] }));
const db = new Database(arquivo, { readonly: true, fileMustExist: true });
const temTabela = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

const existentes = new Set(db.prepare("SELECT uf || '|' || setor k FROM contatos_ativo GROUP BY uf, setor").all().map((r) => r.k));
const nomes = new Map(db.prepare("SELECT id, nome FROM pessoas").all().map((p) => [p.id, p.nome]));
const qContatos = db.prepare(
  `SELECT a.id, a.telefone, a.pessoa_id pessoaId, a.codigo_ibge codigo FROM contatos_ativo a JOIN municipios m ON m.codigo_ibge = a.codigo_ibge
   WHERE a.uf = ? AND a.setor = ? AND a.telefone_valido = 1 AND a.telefone IS NOT NULL
     AND COALESCE(a.contato_inexistente, 0) = 0 AND COALESCE(a.linha_oculta, 0) = 0`);

// ---------- bloqueios que JÁ existem, com a data em que vencem ----------
// por contato (é o que vale entre tipos — tipos novos): rotas, CDR atribuível,
// registro manual. À parte, por TELEFONE das rotas (só para medir quanto seria
// se o bloqueio fosse por número, ex.: reaproveitar o tipo antigo de licitação).
const venceContato = new Map(), venceTelefone = new Map();
const maior = (mapa, k, ate) => { if (k && (mapa.get(k) ?? "") < ate) mapa.set(k, ate); };
let rotasOutubro = { itens: 0, baixas: 0, de: null, ate: null };
if (temTabela("rota_itens")) {
  for (const r of db.prepare(
    `SELECT i.contato_id id, i.telefone, r.data, i.baixa_metodo b FROM rota_itens i JOIN rotas r ON r.id = i.rota_id WHERE r.data >= ?`).all(somarDias(DE, -30))) {
    const ate = somarDias(r.data, r.b ? 30 : 7);
    maior(venceContato, r.id, ate);
    maior(venceTelefone, chaveTelefone(r.telefone), ate);
    rotasOutubro.itens++; if (r.b) rotasOutubro.baixas++;
    if (!rotasOutubro.de || r.data < rotasOutubro.de) rotasOutubro.de = r.data;
    if (!rotasOutubro.ate || r.data > rotasOutubro.ate) rotasOutubro.ate = r.data;
  }
}
for (const r of db.prepare(`SELECT contato_id id, MAX(substr(data_hora,1,10)) d FROM ligacoes WHERE contato_id IS NOT NULL AND (sentido='S' OR atendida=1) GROUP BY 1`).all())
  maior(venceContato, r.id, somarDias(r.d, 30));
for (const r of db.prepare(`SELECT id, data_ultimo_contato d FROM contatos_ativo WHERE data_ultimo_contato IS NOT NULL`).all()) maior(venceContato, r.id, somarDias(r.d, 30));
for (const r of db.prepare(`SELECT contato_id id, MAX(substr(registrado_em,1,10)) d FROM contatos_ativo_historico WHERE tipo='contato' GROUP BY 1`).all()) maior(venceContato, r.id, somarDias(r.d, 30));

console.log(`Banco: ${arquivo} · ${dias.length} dias úteis de ${DE} a ${ATE} (feriados: ${[...FERIADOS].join(", ")}) · cota ${COTA} + extra ${EXTRA} · baixa ${BAIXA * 100}%`);
console.log(`Rotas nos 30 dias antes de ${DE}: ${rotasOutubro.itens} itens (${rotasOutubro.baixas} com baixa)${rotasOutubro.de ? `, de ${rotasOutubro.de} a ${rotasOutubro.ate}` : ""}\n`);

// ---------- montagem dos pools ----------
const faltando = [];
function pool(setores, dono) {
  const contatos = [];
  for (const [uf, setor] of setores) {
    if (!existentes.has(`${uf}|${setor}`)) { faltando.push(`${dono}: ${uf} "${setor}"`); continue; }
    for (const c of qContatos.all(uf, setor)) { const chave = chaveTelefone(c.telefone); if (chave) contatos.push({ ...c, uf, setor, chave }); }
  }
  const porTelefone = new Map();
  for (const c of contatos) (porTelefone.get(c.chave) ?? porTelefone.set(c.chave, []).get(c.chave)).push(c);
  return { contatos, porTelefone };
}
for (const v of VENDEDORES) Object.assign(v, pool(v.setores, v.nome));
for (const [nome, lista] of Object.entries(COMPLEMENTOS)) for (const c of lista) Object.assign(c, pool(c.setores, `${nome}/${c.nome}`));
if (faltando.length) console.log(`⚠ abas inexistentes na base: ${faltando.join("; ")}\n`);

const livresEm = (porTelefone, d, porNumero) =>
  [...porTelefone].filter(([k, cs]) => (!porNumero || (venceTelefone.get(k) ?? "") <= d) && cs.some((c) => (venceContato.get(c.id) ?? "") <= d)).length;

// ---------- 1. estoque ----------
console.log(`1. ESTOQUE (um item por telefone; consultor do contato ignorado) — dias = telefones livres em ${DE} ÷ ${COTA}`);
console.log(`${pad("vendedor", 11)}${pad("tipo", 13)}${lpad("abas", 5)}${lpad("contatos", 10)}${lpad("telefones", 11)}${lpad(`livres ${DE.slice(5)}`, 13)}${lpad("dias", 7)}${lpad("c/ extra", 10)}${lpad("de outro", 10)}`);
for (const v of VENDEDORES) {
  const livres = livresEm(v.porTelefone, DE, false);
  const outro = v.contatos.filter((c) => c.pessoaId !== null && nomes.get(c.pessoaId) !== v.nome).length;
  console.log(`${pad(v.nome, 11)}${pad(v.tipo, 13)}${lpad(v.setores.length, 5)}${lpad(v.contatos.length, 10)}${lpad(v.porTelefone.size, 11)}${lpad(livres, 13)}${lpad(f1(livres / COTA), 7)}${lpad(f1(livres / (COTA + EXTRA)), 10)}${lpad(outro, 10)}`);
}
console.log("  de outro = contatos com OUTRO consultor no cadastro (a rota nova ignora; pela regra antiga não entrariam)\n");
for (const v of VENDEDORES) {
  const porAba = new Map();
  for (const c of v.contatos) { const k = `${c.uf} ${c.setor}`; const a = porAba.get(k) ?? porAba.set(k, { c: 0, t: new Set() }).get(k); a.c++; a.t.add(c.chave); }
  console.log(`  ${v.nome}: ${[...porAba].map(([k, a]) => `${k} ${a.c}/${a.t.size}`).join(" · ")}`);
}
console.log("  (aba: contatos aptos/telefones distintos)\n");

// ---------- 2. bloqueados pelo que já aconteceu ----------
const datasBloq = [DE, ...[7, 14, 21].map((n) => somarDias(DE, n))];
console.log("2. TELEFONES BLOQUEADOS pelo histórico (rotas de outubro, CDR atribuível, registro manual) — bloqueados / telefones do vendedor");
console.log(`${pad("vendedor", 11)}${datasBloq.map((d) => lpad(d.slice(5).split("-").reverse().join("/"), 18)).join("")}`);
for (const [rotulo, porNumero] of [["por contato (regra T — vale)", false], ["por telefone (se fosse)", true]]) {
  console.log(`  ${rotulo}`);
  for (const v of VENDEDORES) {
    console.log(pad(v.nome, 11) + datasBloq.map((d) => {
      const b = v.porTelefone.size - livresEm(v.porTelefone, d, porNumero);
      return lpad(`${b} (${Math.round((100 * b) / v.porTelefone.size)}%)`, 18);
    }).join(""));
  }
}
console.log("  por telefone = número que esteve em qualquer rota de outubro; só valeria se o tipo novo reaproveitasse o tipo antigo\n");

// ---------- 3. sobreposição ----------
console.log("3. TELEFONES EM COMUM entre vendedores (% dos telefones da linha que o da coluna também tem)");
console.log(pad("", 11) + VENDEDORES.map((v) => lpad(v.nome, 11)).join(""));
for (const a of VENDEDORES) {
  console.log(pad(a.nome, 11) + VENDEDORES.map((b) => {
    if (a === b) return lpad("—", 11);
    let n = 0; for (const k of a.porTelefone.keys()) if (b.porTelefone.has(k)) n++;
    return lpad(`${n} ${Math.round((100 * n) / a.porTelefone.size)}%`, 11);
  }).join(""));
}
const contatosComuns = [];
for (let i = 0; i < VENDEDORES.length; i++) for (let j = i + 1; j < VENDEDORES.length; j++) {
  const ids = new Set(VENDEDORES[j].contatos.map((c) => c.id));
  const n = VENDEDORES[i].contatos.filter((c) => ids.has(c.id)).length;
  if (n) contatosComuns.push(`${VENDEDORES[i].nome} × ${VENDEDORES[j].nome}: ${n}`);
}
console.log(contatosComuns.length ? `  mesmo CONTATO em dois vendedores: ${contatosComuns.join("; ")}` : "  nenhum contato em dois vendedores");
console.log();

// ---------- simulação ----------
// filas: vendedor → [tipo principal, complemento?]; cada tipo = um pool
function simular(regra, cota, complementos = {}) {
  const venceC = new Map(venceContato);
  const venceTipo = new Map();          // `${tipo}|${chave}` → data (T e V: tipo = vendedor/fila)
  const venceGlobal = new Map();        // E
  const filas = VENDEDORES.map((v) => [{ id: v.nome, ...v }, ...(complementos[v.nome] ? [{ id: `${v.nome}+${complementos[v.nome].nome}`, ...complementos[v.nome] }] : [])]);
  const r = VENDEDORES.map(() => ({ itens: 0, comp: 0, curtos: 0, primeiraCurta: null }));
  let seq = 0;
  for (const [n, d] of dias.entries()) {
    const tomados = new Set(), contatosHoje = new Set();
    const g = n % VENDEDORES.length;
    const roda = [...VENDEDORES.keys()].slice(g).concat([...VENDEDORES.keys()].slice(0, g));
    const estado = roda.map((i) => ({
      i, n: 0, fase: 0,
      listas: filas[i].map((t) => {
        const livres = [];
        for (const [k, cs] of t.porTelefone) {
          if ((venceTipo.get(`${regra === "V" ? VENDEDORES[i].nome : t.id}|${k}`) ?? "") > d) continue;
          if (regra === "E" && (venceGlobal.get(k) ?? "") > d) continue;
          const c = cs.find((x) => (venceC.get(x.id) ?? "") <= d);
          if (c) livres.push(c);
        }
        livres.sort((a, b) => a.codigo - b.codigo || a.id - b.id);
        return { t, livres, pos: 0 };
      }),
    }));
    let andou = true;
    while (andou) {
      andou = false;
      for (const s of estado) {
        while (s.n < cota && s.fase < s.listas.length) {
          const l = s.listas[s.fase];
          while (l.pos < l.livres.length && (tomados.has(l.livres[l.pos].chave) || contatosHoje.has(l.livres[l.pos].id))) l.pos++;
          if (l.pos >= l.livres.length) { s.fase++; continue; }
          const c = l.livres[l.pos++];
          tomados.add(c.chave); contatosHoje.add(c.id); s.n++; andou = true;
          if (s.fase > 0) r[s.i].comp++;
          const ate = somarDias(d, (seq++ % 100) < BAIXA * 100 ? 30 : 7);
          venceTipo.set(`${regra === "V" ? VENDEDORES[s.i].nome : l.t.id}|${c.chave}`, ate);
          if (regra === "E") venceGlobal.set(c.chave, ate);
          if (regra !== "V") venceC.set(c.id, ate);
          break; // um por vez: rodízio entre vendedores
        }
      }
    }
    for (const s of estado) {
      const x = r[s.i]; x.itens += s.n;
      if (s.n < cota) { x.curtos++; x.primeiraCurta ??= d; }
    }
  }
  return r;
}
const fmtSim = (s) => ` ${s.itens}${s.comp ? ` (${s.comp} compl.)` : ""} · ${s.curtos} curtas${s.primeiraCurta ? ` desde ${s.primeiraCurta.slice(8)}/${s.primeiraCurta.slice(5, 7)}` : ""}`;

console.log(`4. REGRAS DE BLOQUEIO ${DE} → ${ATE} (${dias.length} dias úteis), sem complemento — itens · rotas curtas`);
for (const cota of [COTA, COTA + EXTRA]) {
  console.log(`  cota ${cota}/dia (meta ${cota * dias.length})`);
  console.log(`  ${pad("regra", 22)}${VENDEDORES.map((v) => lpad(v.nome, 30)).join("")}`);
  for (const [regra, rotulo] of [["T", "T por tipo (decidida)"], ["V", "V por vendedor"], ["E", "E estrita"]])
    console.log(`  ${pad(rotulo, 22)}${simular(regra, cota).map((s) => lpad(fmtSim(s), 30)).join("")}`);
}
console.log();

// ---------- 5. complementos ----------
console.log(`5. COMPLEMENTOS (2º tipo da fila: o principal primeiro, o complemento só quando falta) — regra T`);
for (const [nome, lista] of Object.entries(COMPLEMENTOS)) {
  const v = VENDEDORES.find((x) => x.nome === nome);
  const iv = VENDEDORES.indexOf(v);
  console.log(`  ${nome} (${v.tipo}: ${v.porTelefone.size} telefones, ${f1(livresEm(v.porTelefone, DE, false) / COTA)} dias a ${COTA})`);
  console.log(`  ${pad("complemento", 26)}${lpad("abas", 5)}${lpad("contatos", 10)}${lpad("telefones", 11)}${lpad("novos", 7)}${lpad("+dias 45", 10)}${lpad(`sim. a ${COTA}`, 34)}${lpad(`sim. a ${COTA + EXTRA}`, 34)}`);
  const base = [simular("T", COTA)[iv], simular("T", COTA + EXTRA)[iv]];
  console.log(`  ${pad("(nenhum)", 26)}${lpad("", 5)}${lpad("", 10)}${lpad("", 11)}${lpad("", 7)}${lpad("", 10)}${lpad(fmtSim(base[0]), 34)}${lpad(fmtSim(base[1]), 34)}`);
  for (const c of lista) {
    const novos = [...c.porTelefone.keys()].filter((k) => !v.porTelefone.has(k)).length;
    const livres = livresEm(c.porTelefone, DE, false);
    const sims = [COTA, COTA + EXTRA].map((cota) => simular("T", cota, { [nome]: c })[iv]);
    const usados = VENDEDORES.filter((o) => o !== v && o.contatos.some((x) => c.contatos.some((y) => y.id === x.id))).map((o) => o.nome);
    console.log(`  ${pad(c.nome, 26)}${lpad(c.setores.length, 5)}${lpad(c.contatos.length, 10)}${lpad(c.porTelefone.size, 11)}${lpad(novos, 7)}${lpad(f1(livres / COTA), 10)}${lpad(fmtSim(sims[0]), 34)}${lpad(fmtSim(sims[1]), 34)}${usados.length ? `  ⚠ abas de ${usados.join(", ")}` : ""}`);
  }
  console.log();
}
console.log("  telefones = do complemento (o número geral da prefeitura conta: entre tipos o bloqueio é por contato, então ligar");
console.log("  de novo para a prefeitura pedindo outro setor é permitido); novos = números que o principal não tem.");
