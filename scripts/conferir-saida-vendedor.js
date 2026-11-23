"use strict";
// SOMENTE LEITURA — conferência DEPOIS da migração de saída de um vendedor do
// plano de fim de ano (migração 46, saída do Danilo, 2026-11-23):
//   1. contador coletivo (matrículas nov/dez por criada_em, sem canceladas, só
//      consultores — a mesma conta de fimdeano.contador) e cotas × coletivo;
//   2. o que sobrou no nome de quem saiu (flags, ramal, faixas, rotas,
//      células do plano, contatos);
//   3. por vendedor que ficou: municípios do bloco NOVO e quantos itens das
//      rotas caem nele na data e no período até 15/12, itens fora da faixa e
//      rotas curtas;
//   4. telefone repetido no mesmo dia.
// Não usa db.js nem rota.js e não grava nada.
//
//   node scripts/conferir-saida-vendedor.js <banco.db> --pessoa=Danilo --data=2026-11-24
//   docker compose exec -T jonias node - /app/data/aula-ai.db --pessoa=Danilo --data=2026-11-24 < scripts/conferir-saida-vendedor.js

const args = process.argv.slice(2);
const arquivo = args.find((a) => !a.startsWith("--"));
const opt = (n, p) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : p; };
const NOME = opt("pessoa", "Danilo");
const DATA = opt("data", null);
if (!arquivo || !/^\d{4}-\d{2}-\d{2}$/.test(DATA || "")) {
  console.error("uso: conferir-saida-vendedor.js <banco.db> --pessoa=Nome --data=AAAA-MM-DD (1º dia refeito)");
  process.exit(1);
}
const Database = require("better-sqlite3");
const db = new Database(arquivo, { readonly: true, fileMustExist: true });
const FIM = "2026-12-15";
const q = (sql, ...a) => db.prepare(sql).all(...a);
const g = (sql, ...a) => db.prepare(sql).get(...a);
const reais = (c) => "R$ " + ((c || 0) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
  .replace(/[^A-Z0-9]+/g, " ").trim().replace(/(^| )D (?=[AEIOU])/g, "$1DO ");
const somarDias = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

const p = g("SELECT * FROM pessoas WHERE nome = ?", NOME);
if (!p) { console.error(`pessoa "${NOME}" não encontrada`); process.exit(1); }
console.log(`banco: ${arquivo} · user_version ${db.pragma("user_version", { simple: true })} · conferência de ${DATA} a ${FIM}`);

// ---------- 1. contador e cotas
const vend = new Map(q(`SELECT m.pessoa_id pid, SUM(m.valor_centavos) v FROM matriculas m JOIN pessoas x ON x.id = m.pessoa_id
  WHERE x.tipo = 'consultor' AND m.criada_em BETWEEN '2026-11-01T00:00:00' AND '2026-12-31T23:59:59' AND (m.status IS NULL OR m.status != 'canceled')
  GROUP BY m.pessoa_id`).map((r) => [r.pid, r.v || 0]));
const total = [...vend.values()].reduce((s, v) => s + v, 0);
const sync = g("SELECT MAX(concluido_em) u FROM importacoes WHERE tipo = 'mysql' AND status = 'concluida'")?.u;
console.log(`\n=== 1. CONTADOR: ${reais(total)} (último sync Unyflex ${sync ?? "—"}) · ${NOME}: ${reais(vend.get(p.id) || 0)}`);

// faixas vigentes numa data → pessoaId → Set(código)
function faixasEm(data) {
  const fx = q(`SELECT f.pessoa_id pid, x.nome, f.uf, f.inicio, f.fim FROM faixas_vendedor f JOIN pessoas x ON x.id = f.pessoa_id
    WHERE f.vigente_desde <= ? AND (f.vigente_ate IS NULL OR f.vigente_ate >= ?)`, data, data);
  const mapa = new Map();
  for (const uf of [...new Set(fx.map((f) => f.uf))]) {
    const ms = q("SELECT codigo_ibge c, nome FROM municipios WHERE uf = ?", uf).map((m) => ({ ...m, n: norm(m.nome) })).sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
    for (const f of fx.filter((x) => x.uf === uf)) {
      const i = ms.findIndex((m) => m.n === norm(f.inicio)), j = ms.findIndex((m) => m.n === norm(f.fim));
      if (i < 0 || j < 0) { console.log(`⚠ faixa ${f.nome} ${uf} ${f.inicio} → ${f.fim} não casou com o IBGE`); continue; }
      const s = mapa.get(f.pid) ?? mapa.set(f.pid, { nome: f.nome, mun: new Set() }).get(f.pid);
      for (let k = i; k <= j; k++) s.mun.add(ms[k].c);
    }
  }
  return mapa;
}
const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const diaCota = hoje < "2026-11-11" ? "2026-11-11" : hoje > FIM ? FIM : hoje;
const comCota = faixasEm(diaCota);
const meta = (ind, pid) => g(`SELECT valor FROM metas WHERE indicador = ? AND (pessoa_id = ? OR pessoa_id IS NULL) AND vigente_desde <= ? AND (vigente_ate IS NULL OR vigente_ate >= ?)
  ORDER BY pessoa_id IS NULL, vigente_desde DESC LIMIT 1`, ind, pid, hoje, hoje)?.valor ?? 0;
for (const [ind, rot, col] of [["cota_fim_ano_super", "supermeta", 50000000], ["cota_fim_ano_base", "base", 40000000]]) {
  const soma = [...comCota.keys()].reduce((s, pid) => s + meta(ind, pid), 0);
  console.log(`cotas ${rot}: ${[...comCota.values()].map((x) => x.nome).join(", ")} somam ${reais(soma)} de ${reais(col)} · lacuna sem dono ${reais(col - soma)}`);
}
console.log(`${NOME} com cota hoje? ${comCota.has(p.id) ? "SIM ⚠" : "não ✓"}`);

// ---------- 2. o que sobrou no nome dele
console.log(`\n=== 2. ${NOME.toUpperCase()}`);
console.log(`ativo ${p.ativo} · painel ${p.entra_painel} · tv ${p.entra_tv} · feedback ${p.entra_feedback} · ramal ${p.ramal ?? "—"}`);
for (const v of q("SELECT ramal, vigente_desde, vigente_ate FROM ramal_vigencias WHERE pessoa_id = ?", p.id)) console.log(`  ramal ${v.ramal}: ${v.vigente_desde ?? "(início)"} → ${v.vigente_ate ?? "(aberto) ⚠"}`);
for (const f of q("SELECT uf, inicio, fim, vigente_desde, vigente_ate FROM faixas_vendedor WHERE pessoa_id = ?", p.id)) console.log(`  faixa ${f.uf} ${f.inicio} → ${f.fim}: ${f.vigente_desde} → ${f.vigente_ate ?? "(aberta)"}`);
console.log(`  rotas de ${DATA} em diante: ${g("SELECT COUNT(*) n FROM rotas WHERE pessoa_id = ? AND data >= ?", p.id, DATA).n} · células do plano: ${q("SELECT data FROM fim_ano_plano WHERE pessoa_id = ? ORDER BY data", p.id).map((r) => r.data).join(", ") || "nenhuma"}`);
console.log(`  contatos com ele como consultor: ${g("SELECT COUNT(*) n FROM contatos_ativo WHERE pessoa_id = ?", p.id).n}`);
console.log(`  órgãos novos por vendedor: ${q("SELECT x.nome, COUNT(*) n FROM contatos_ativo c JOIN pessoas x ON x.id = c.pessoa_id WHERE c.origem = 'orgaos_novos' GROUP BY 1 ORDER BY 1").map((r) => `${r.nome} ${r.n}`).join(" · ")}`);

// ---------- 3. blocos novos nas rotas
console.log(`\n=== 3. ROTAS COM O BLOCO NOVO (itens obrigatórios + Extra; órgãos novos à parte)`);
const antes = faixasEm(somarDias(DATA, -1)), depois = faixasEm(DATA);
console.log("  vendedor     bloco novo   itens do bloco em " + DATA + "   no período até 15/12   fora da faixa   rotas (curtas)");
for (const [pid, x] of depois) {
  const novo = [...x.mun].filter((c) => !antes.get(pid)?.mun.has(c));
  const s = new Set(novo);
  const itens = (de, ate) => q(`SELECT i.codigo_ibge c, i.extra FROM rota_itens i JOIN rotas r ON r.id = i.rota_id WHERE r.pessoa_id = ? AND r.data BETWEEN ? AND ? AND i.extra != 2`, pid, de, ate);
  const dia = itens(DATA, DATA), per = itens(DATA, FIM);
  const fora = per.filter((i) => !x.mun.has(i.c)).length;
  const rotas = q(`SELECT r.cota, SUM(i.extra = 0) base FROM rotas r LEFT JOIN rota_itens i ON i.rota_id = r.id WHERE r.pessoa_id = ? AND r.data BETWEEN ? AND ? GROUP BY r.id`, pid, DATA, FIM);
  const curtas = rotas.filter((r) => (r.base || 0) < r.cota).length;
  console.log(`  ${x.nome.padEnd(10)} ${String(novo.length).padStart(5)} mun.   ${`${dia.filter((i) => s.has(i.c)).length} de ${dia.length}`.padStart(12)}          ${`${per.filter((i) => s.has(i.c)).length} de ${per.length}`.padStart(12)}   ${String(fora).padStart(8)}${fora ? " ⚠" : "  "}     ${rotas.length} (${curtas}${curtas ? " ⚠" : ""})`);
}

// ---------- 4. telefone repetido
const rep = g(`SELECT COUNT(*) n FROM (SELECT r.data, i.telefone FROM rota_itens i JOIN rotas r ON r.id = i.rota_id
  WHERE r.data BETWEEN ? AND ? AND i.telefone <> '' GROUP BY 1, 2 HAVING COUNT(*) > 1)`, DATA, FIM).n;
console.log(`\n=== 4. telefone repetido no mesmo dia (${DATA} a ${FIM}): ${rep}${rep ? " ⚠" : " ✓"}`);
