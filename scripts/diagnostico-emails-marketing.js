"use strict";
// SOMENTE LEITURA — e-mail marketing do Gustavo (pedido de 2026-11-12).
// Responde, antes de ligar a geração automática:
//   1. quantas turmas FUTURAS (unyflex = 0, ainda no filtro da origem) há na
//      cópia local da Unyflex, e de quando é o último sync;
//   2. quantos envios a regra geraria (3 por turma: divulgação inicial,
//      intermediário, últimas vagas), nas duas regras (30/15/7 e 60/30/15);
//   3. quantos já nasceriam com o prazo vencido — os RETROATIVOS (prazo
//      anterior à ativação: não contam como atraso do Gustavo, decisão do
//      usuário de 2026-11-12) — e quantos vencem a partir de hoje.
// Prazo = data da turma − antecedência; prazo em fim de semana ou feriado vale
// o dia útil anterior (tabela `feriados`, quando existir).
// Abre o banco só para leitura; não grava nada.
//
//   node scripts/diagnostico-emails-marketing.js <banco.db> [--hoje=AAAA-MM-DD]
//   docker compose exec -T jonias node - /app/data/aula-ai.db < scripts/diagnostico-emails-marketing.js

const args = process.argv.slice(2);
const arquivo = args.find((a) => !a.startsWith("--"));
const opt = (n, p) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=")[1] : p; };
if (!arquivo) { console.error("uso: diagnostico-emails-marketing.js <banco.db> [--hoje=AAAA-MM-DD]"); process.exit(1); }
const Database = require("better-sqlite3");
const db = new Database(arquivo, { readonly: true, fileMustExist: true });

const HOJE = opt("hoje", new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()));
const somarDias = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dias = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5);
const temTabela = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const colunas = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const feriados = new Set(temTabela("feriados") ? db.prepare("SELECT data FROM feriados").all().map((r) => r.data) : []);
const util = (d) => { const w = new Date(d + "T12:00:00Z").getUTCDay(); return w !== 0 && w !== 6 && !feriados.has(d); };
const prazo = (inicio, antecedencia) => { let d = somarDias(inicio, -antecedencia); while (!util(d)) d = somarDias(d, -1); return d; };
const br = (d) => d.split("-").reverse().join("/");

const sync = db.prepare("SELECT MAX(sincronizado_em) ultimo, COUNT(*) n FROM turmas").get();
const filtroOrigem = colunas("turmas").includes("fora_da_origem_em") ? "AND fora_da_origem_em IS NULL" : "";
const turmas = db.prepare(
  `SELECT id, nome, subtitulo, date(start_date) inicio, unyflex FROM turmas
    WHERE date(start_date) > ? ${filtroOrigem} ORDER BY start_date, id`
).all(HOJE);
const validas = turmas.filter((t) => t.unyflex === 0);

console.log(`Hoje: ${br(HOJE)} · último sync da Unyflex: ${sync.ultimo || "nunca"} · ${sync.n} turma(s) na cópia local`);
console.log(`Turmas futuras: ${turmas.length} (unyflex = 0: ${validas.length}; unyflex = 1/NULL, sem e-mail: ${turmas.length - validas.length})`);
if (!validas.length) process.exit(0);

const NOMES = ["divulgação", "intermediário", "últimas vagas"];
for (const regra of [[30, 15, 7], [60, 30, 15]]) {
  let retro = 0, hoje = 0, futuros = 0, somaAtraso = 0, maxAtraso = 0;
  const porOrdem = [0, 0, 0];
  const linhas = [];
  for (const t of validas) {
    const marcas = regra.map((r, i) => {
      const p = prazo(t.inicio, r);
      if (p < HOJE) { retro++; porOrdem[i]++; const a = dias(p, HOJE); somaAtraso += a; maxAtraso = Math.max(maxAtraso, a); return `${NOMES[i]} ${br(p)} RETRO(${a}d)`; }
      if (p === HOJE) { hoje++; return `${NOMES[i]} ${br(p)} HOJE`; }
      futuros++; return `${NOMES[i]} ${br(p)}`;
    });
    linhas.push(`  ${br(t.inicio)}  #${t.id} ${String(t.nome).trim().slice(0, 45)}\n      ${marcas.join(" · ")}`);
  }
  console.log(`\n=== Regra ${regra.join("/")} dias ===`);
  console.log(`Envios: ${validas.length * 3} · retroativos (prazo antes de hoje): ${retro} [${porOrdem.map((n, i) => `${NOMES[i]} ${n}`).join(", ")}]` +
    ` · vencem hoje: ${hoje} · no prazo: ${futuros}` + (retro ? ` · prazo vencido há ${(somaAtraso / retro).toFixed(1)} dias em média (máx ${maxAtraso})` : ""));
  console.log(linhas.join("\n"));
}
