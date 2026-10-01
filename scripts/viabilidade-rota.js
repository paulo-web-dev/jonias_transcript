"use strict";
// SOMENTE LEITURA — estoque de uma campanha da Rota por consultor e por
// regional, antes de ligar a Rota em produção. Não depende de db.js (não roda
// migração nem seed); só usa tabelas que existem desde a migração 23
// (contatos_ativo, carteiras, regionais, municipios, pessoas), então roda em
// banco que ainda não tem as migrações 26+.
//
//   node scripts/viabilidade-rota.js <arquivo.db> [setor1|setor2|...]
//   docker compose exec -T jonias node - /app/data/aula-ai.db < scripts/viabilidade-rota.js
//
// Sem a lista de setores, usa os 6 de licitação aprovados em 2026-09-30.
// Regras iguais às da geração da Rota: telefone válido, não inexistente, não
// oculto; contato sem consultor ou do próprio consultor; UM item por telefone
// (o número da prefeitura se repete entre abas e setores).

const Database = require("better-sqlite3");

const [arquivo, setoresArg] = process.argv.slice(2);
if (!arquivo) {
  console.error("uso: viabilidade-rota.js <arquivo.db> [setor1|setor2|...]");
  process.exit(1);
}
const db = new Database(arquivo, { readonly: true, fileMustExist: true });
const SETORES = setoresArg
  ? setoresArg.split("|").map((s) => s.trim()).filter(Boolean)
  : ["LICITAÇÃO CM", "LICITAÇÃO PM", "LICITAÇÃO PM - com população", "Licitação CM com Papulação"];
const COTA = 45;
const dias = (n) => (n / COTA).toFixed(1);

console.log(`user_version ${db.pragma("user_version", { simple: true })}`);
console.log(`contatos por UF: ${db.prepare("SELECT uf, COUNT(*) n FROM contatos_ativo GROUP BY uf").all().map((r) => `${r.uf} ${r.n}`).join(" · ") || "nenhum"}`);
console.log(`setores: ${SETORES.join(" | ")}\n`);

const marc = SETORES.map(() => "?").join(",");
const aptos = db.prepare(
  `SELECT a.id, a.telefone, a.pessoa_id, a.uf, a.setor, m.regional_principal_id regional
   FROM contatos_ativo a JOIN municipios m ON m.codigo_ibge = a.codigo_ibge
   WHERE a.setor IN (${marc}) AND a.telefone_valido = 1 AND a.telefone IS NOT NULL
     AND COALESCE(a.contato_inexistente, 0) = 0 AND COALESCE(a.linha_oculta, 0) = 0`
).all(...SETORES);
const porSetor = db.prepare(`SELECT uf, setor, COUNT(*) n FROM contatos_ativo WHERE setor IN (${marc}) GROUP BY 1, 2 ORDER BY 1, 2`).all(...SETORES);
for (const s of porSetor) {
  const a = aptos.filter((x) => x.uf === s.uf && x.setor === s.setor).length;
  console.log(`  ${s.uf}  ${s.setor.padEnd(32)} ${String(s.n).padStart(5)} linhas · ${String(a).padStart(5)} aptas`);
}
const faltando = SETORES.filter((s) => !porSetor.some((p) => p.setor === s));
if (faltando.length) console.log(`  ⚠ setor sem nenhuma linha neste banco: ${faltando.join(", ")}`);

const carteiras = db.prepare(
  `SELECT c.pessoa_id pessoa, p.nome, c.papel, r.id regional, r.uf, r.sigla
   FROM carteiras c JOIN pessoas p ON p.id = c.pessoa_id JOIN regionais r ON r.id = c.regional_id
   ORDER BY p.nome, r.uf, r.sigla`
).all();
const vinculados = new Map();
for (const c of carteiras) vinculados.set(c.regional, (vinculados.get(c.regional) || 0) + 1);

// Telefones distintos que o consultor pode receber numa regional
const fones = (pessoa, regional) =>
  new Set(aptos.filter((a) => a.regional === regional && (a.pessoa_id === null || a.pessoa_id === pessoa)).map((a) => a.telefone));

console.log(`\nPOR CONSULTOR × REGIONAL (telefones distintos; dias a ${COTA}/dia se ele estivesse sozinho)`);
console.log(["consultor", "papel", "uf", "regional", "vinculados", "telefones", "dias"].join("\t"));
const porPessoa = new Map();
for (const c of carteiras) {
  const f = fones(c.pessoa, c.regional);
  console.log([c.nome, c.papel, c.uf, c.sigla, vinculados.get(c.regional), f.size, dias(f.size)].join("\t"));
  const t = porPessoa.get(c.nome) ?? porPessoa.set(c.nome, { fones: new Set(), partilhado: 0, regionais: 0 }).get(c.nome);
  for (const x of f) t.fones.add(x);
  t.partilhado += f.size / vinculados.get(c.regional);
  t.regionais++;
}

console.log(`\nTOTAL POR CONSULTOR (partilhado = estoque da regional dividido entre os vinculados)`);
for (const [nome, t] of porPessoa) {
  console.log(`${nome.padEnd(12)} ${t.regionais} regional(is) · ${String(t.fones.size).padStart(5)} telefones (${dias(t.fones.size)} dias) · partilhado ~${Math.round(t.partilhado)} (${dias(t.partilhado)} dias)`);
}

const daEquipe = new Set();
for (const t of porPessoa.values()) for (const x of t.fones) daEquipe.add(x);
const consultores = porPessoa.size;
console.log(`\nEQUIPE: ${daEquipe.size} telefones distintos alcançáveis · ${consultores} consultor(es) com carteira` +
  (consultores ? ` → ~${(daEquipe.size / (COTA * consultores)).toFixed(1)} dia(s) de campanha` : ""));
const foraDeCarteira = new Set(aptos.filter((a) => a.regional && !vinculados.has(a.regional)).map((a) => a.telefone));
console.log(`fora de qualquer carteira: ${foraDeCarteira.size} telefone(s) (regional sem vinculado — não entram em rota)`);

// Contato atribuído (na planilha ou no sistema) a um consultor que NÃO está
// vinculado à regional do município: não entra na rota de ninguém.
const donos = new Map();
for (const c of carteiras) (donos.get(c.regional) ?? donos.set(c.regional, new Set()).get(c.regional)).add(c.pessoa);
const orfaos = aptos.filter((a) => vinculados.has(a.regional) && a.pessoa_id !== null && !donos.get(a.regional).has(a.pessoa_id));
if (orfaos.length) {
  const nomes = new Map(db.prepare("SELECT id, nome FROM pessoas").all().map((p) => [p.id, p.nome]));
  const reg = new Map(carteiras.map((c) => [c.regional, `${c.uf} ${c.sigla}`]));
  const grupos = new Map();
  for (const o of orfaos) {
    const k = `${reg.get(o.regional)} · de ${nomes.get(o.pessoa_id) || o.pessoa_id}`;
    grupos.set(k, (grupos.get(k) || 0) + 1);
  }
  console.log(`\n⚠ ${orfaos.length} contato(s) apto(s) atribuído(s) a consultor SEM vínculo na regional — ficam fora de todas as rotas:`);
  for (const [k, n] of [...grupos].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
}
const sem = db.prepare(
  `SELECT nome FROM pessoas p WHERE tipo = 'consultor' AND ativo = 1 AND NOT EXISTS (SELECT 1 FROM carteiras c WHERE c.pessoa_id = p.id) ORDER BY nome`
).all();
console.log(`consultores ativos SEM carteira (não recebem rota): ${sem.map((s) => s.nome).join(", ") || "nenhum"}`);
