"use strict";
// SOMENTE LEITURA sobre o banco real — simula a FILA de campanhas da Rota dia
// a dia numa CÓPIA do banco (API de backup do SQLite, num arquivo temporário
// apagado ao fim), usando o próprio rota.js: mesmos bloqueios, mesma geração,
// mesmas carteiras. Responde "a campanha N ainda tem estoque quando a N-1
// acaba?" com as regras reais (opção B: por telefone dentro do tipo, por
// contato entre tipos; 30 dias com baixa, 7 sem; um telefone por dia) e a
// regra da fila do código que estiver rodando (cíclica desde a migração 32).
//
//   node scripts/simular-fila.js <banco.db> [--dias=45] [--baixa=100] [--refazer] [--licitacao=editar|novo] [--setores]
//   docker compose exec -T jonias node - /app/data/aula-ai.db --setores < scripts/simular-fila.js
//
// --dias      dias úteis simulados (padrão 45 ≈ dois meses)
// --baixa     % dos itens que recebem baixa (padrão 100 = a equipe liga tudo);
//             item sem baixa bloqueia só 7 dias e volta antes
// --refazer   descarta, na cópia, as rotas futuras que ninguém começou (como
//             "refazer as rotas futuras" do painel) — senão a simulação começa
//             depois da rota de amanhã já gerada
// --licitacao editar (padrão) = a campanha 1 é o tipo "Licitação" existente,
//             renomeado e com as abas novas (mantém o bloqueio por telefone de
//             quem já ligou); novo = um tipo separado
// --setores   imprime antes a lista de abas por UF com as linhas aptas
//
// Suposições: rotas de hoje em diante já geradas recebem baixa pela mesma
// regra; nenhuma ligação nova do CDR nem registro manual fora da rota;
// feriados não existem (dia útil = seg–sex, como na geração).

const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2);
const arquivo = args.find((a) => !a.startsWith("--"));
const opt = (n, padrao) => {
  const a = args.find((x) => x === `--${n}` || x.startsWith(`--${n}=`));
  return a === undefined ? padrao : a.includes("=") ? a.split("=")[1] : true;
};
if (!arquivo) {
  console.error("uso: simular-fila.js <banco.db> [--dias=45] [--baixa=100] [--refazer] [--licitacao=editar|novo] [--setores]");
  process.exit(1);
}
const DIAS = Number(opt("dias", 45));
const BAIXA = Number(opt("baixa", 100)) / 100;
const REFAZER = !!opt("refazer", false);
const LICITACAO = opt("licitacao", "editar");

// Proposta de 2026-10-06 (curso → abas). "CM" = todas as abas com órgão CM.
const MAPA = [
  { nome: "Licitação com IA", editar: "Licitação", setores: [
    ["PR", "LICITAÇÃO PM"], ["PR", "LICITAÇÃO CM"], ["PR", "LICITAÇÃO PM - com população"], ["PR", "Licitação CM com Papulação"],
    ["SC", "LICITAÇÃO PM"], ["SC", "LICITAÇÃO CM"],
    ["PR", "Compras PM"], ["PR", "Compras CM"], ["SC", "COMPRAS"], ["PR", "PREGOEIRO"], ["SC", "PREGOEIRO"],
    ["SC", "SAUDE LICITACAO"], ["PR", "ETP E TR"], ["PR", "GESTOR E FISCAL DE CONTRATOS"], ["SC", "Agente de contrataçãoFiscais"]] },
  { nome: "Comunicação Pública 360º", setores: [
    ["PR", "COMUNICAÇÃO PM"], ["PR", "COMUNICAÇÃO CM"], ["PR", "SECOM"], ["SC", "COMUNICAÇÃO PM"], ["SC", "COMUNICAÇÃO CM"],
    ["PR", "ASSESSOR PM"], ["PR", "ASSESSOR CM"], ["SC", "ASSESSOR PM"], ["SC", "ASSESSOR CM"]] },
  { nome: "Portal e Ouvidoria", setores: [
    ["PR", "TRANSPARENCIA PM"], ["PR", "Controle interno"], ["PR", "Controle Interno - CM"],
    ["SC", "CONTROLE INTERNO PM"], ["SC", "CONTROLE INTERNO CM"]] },
  { nome: "Patrimônio", setores: [
    ["PR", "PATRIMONIO PM"], ["PR", "FROTAS E PATRIMONIO PM"], ["PR", "Patrimonio CM"],
    ["SC", "PATRIMONIOFROTAS PM"], ["SC", "PATRIMONIOFROTAS CM"]] },
  { nome: "Finanças", setores: [
    ["PR", "FINANÇAS PM"], ["PR", "TESOURARIA PM"], ["PR", "TESOURARIA CM"], ["PR", "CONTABILIDADE PM"], ["PR", "CONTABILIDADE CM"],
    ["SC", "TESOURARIA PM"], ["SC", "TESOURARIA CM"], ["SC", "CONTABILIDADE PM"], ["SC", "CONTABILIDADE CM"]] },
  { nome: "Tributação Municipal", setores: [["PR", "TRIBUTAÇÃO"], ["SC", "PM TRIBUTAÇÃO"]] },
  { nome: "IA na Câmara Municipal", setores: "CM" },
];

(async () => {
  const Database = require(require.resolve("better-sqlite3", { paths: [process.cwd(), path.join(__dirname, "..")] }));
  const origem = new Database(arquivo, { readonly: true, fileMustExist: true });
  const copia = path.join(os.tmpdir(), `simular-fila-${process.pid}.db`);
  await origem.backup(copia);
  origem.close();
  const limpar = () => { for (const s of ["", "-wal", "-shm"]) try { fs.unlinkSync(copia + s); } catch {} };
  process.on("exit", limpar);

  // o boot do db.js (migrações, seeds) roda na CÓPIA e fala muito: silenciado
  process.env.DB_PATH = copia;
  const raiz = fs.existsSync(path.join(process.cwd(), "rota.js")) ? process.cwd() : path.join(__dirname, "..");
  const log = console.log, warn = console.warn;
  console.log = console.warn = () => {};
  const db = require(path.join(raiz, "db.js"));
  const rota = require(path.join(raiz, "rota.js"));
  console.log = log;
  const avisosRota = new Map();
  console.warn = (...a) => { const k = a.join(" "); avisosRota.set(k, (avisosRota.get(k) || 0) + 1); };

  const { data: hoje } = rota.agoraBrasilia();
  log(`banco: ${arquivo} (cópia temporária) · hoje ${hoje} · ${DIAS} dias úteis · baixa ${Math.round(BAIXA * 100)}%` +
    `${REFAZER ? " · refazendo rotas futuras" : ""} · Licitação: ${LICITACAO}`);

  const disponiveis = rota.setoresDisponiveis();
  if (opt("setores", false)) {
    log("\nABAS (setor) POR UF — linhas · aptas (telefone válido, não inexistente, não oculta)");
    for (const s of disponiveis) log(`  ${s.uf}  ${s.setor.padEnd(34)} ${String(s.linhas).padStart(5)} · ${String(s.aptas).padStart(5)}`);
  }
  const existe = new Set(disponiveis.map((s) => `${s.uf}|${s.setor}`));
  // todas as abas CM; as do público do curso primeiro (o contato escolhido
  // para cada telefone segue a ordem das abas — ~5 abas CM por número da câmara)
  const PRIMEIRO_CM = /legislativ|gabinete|assessor|servidores/i;
  const cm = db.prepare("SELECT DISTINCT uf, setor FROM contatos_ativo WHERE orgao = 'CM' ORDER BY uf, setor").all()
    .sort((a, b) => !PRIMEIRO_CM.test(a.setor) - !PRIMEIRO_CM.test(b.setor));

  // tipos e fila na cópia: com a migração 32 já vêm do db.js (a cópia migra
  // ao abrir); numa imagem anterior, o MAPA abaixo cria tudo
  const daMigracao = MAPA.every((c) => db.prepare("SELECT 1 FROM rota_tipos WHERE nome = ? AND ativo = 1").get(c.nome));
  const fila = [];
  if (daMigracao) for (const c of MAPA) fila.push(rota.lerTipo(db.prepare("SELECT id FROM rota_tipos WHERE nome = ?").get(c.nome).id));
  for (const c of daMigracao ? [] : MAPA) {
    const lista = c.setores === "CM" ? cm.map((s) => [s.uf, s.setor]) : c.setores;
    const faltam = lista.filter(([u, s]) => !existe.has(`${u}|${s}`));
    if (faltam.length) log(`⚠ ${c.nome}: aba(s) inexistente(s) neste banco, ignorada(s): ${faltam.map(([u, s]) => `${u} "${s}"`).join(", ")}`);
    const setores = lista.filter(([u, s]) => existe.has(`${u}|${s}`)).map(([uf, setor]) => ({ uf, setor }));
    const atual = c.editar && LICITACAO === "editar" ? db.prepare("SELECT id FROM rota_tipos WHERE nome = ?").get(c.editar) : null;
    const repetido = db.prepare("SELECT id FROM rota_tipos WHERE nome = ?").get(c.nome);
    const tipo = rota.gravarTipo({ id: atual?.id ?? repetido?.id, nome: c.nome, setores, cota: 45 }, null);
    fila.push(tipo);
  }

  // campanha na cópia
  if (REFAZER) {
    db.prepare(`DELETE FROM rotas WHERE data > ? AND NOT EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = rotas.id AND i.baixa_metodo IS NOT NULL)`).run(hoje);
  }
  const inicio = rota.proximaDataSemRota(hoje);
  const vigente = rota.campanhaVigente(inicio);
  if (vigente?.fila.map((t) => t.id).join() !== fila.map((t) => t.id).join()) {
    db.prepare("INSERT INTO rota_campanhas (tipo_id, fila_json, vale_desde, criada_em) VALUES (?, ?, ?, ?)")
      .run(fila[0].id, JSON.stringify(fila.map((t) => t.id)), inicio, new Date().toISOString());
  }
  const cicloNaRota = !!db.prepare("SELECT 1 FROM pragma_table_info('rotas') WHERE name = 'ciclo'").get();
  log(`regra da fila: ${cicloNaRota ? "CÍCLICA (migração 32 — cada um anda do 1º ao último e só então volta ao 1º)" : "volta ao primeiro tipo com estoque (migração 31)"}`);

  // baixa determinística: o mesmo item sempre cai do mesmo lado
  const recebeBaixa = (id) => ((id * 2654435761) % 1000) / 1000 < BAIXA;
  const darBaixa = db.prepare("UPDATE rota_itens SET baixa_em = ?, baixa_metodo = 'manual' WHERE id = ?");
  const baixarDia = (data) => {
    for (const i of db.prepare(`SELECT i.id FROM rota_itens i JOIN rotas r ON r.id = i.rota_id WHERE r.data = ? AND i.baixa_metodo IS NULL`).all(data)) {
      if (recebeBaixa(i.id)) darBaixa.run(`${data}T12:00:00`, i.id);
    }
  };
  for (const r of db.prepare("SELECT DISTINCT data FROM rotas WHERE data >= ? AND data < ? ORDER BY data").all(hoje, inicio)) baixarDia(r.data);

  const curto = new Map(fila.map((t, k) => [t.id, `${k + 1}`]));
  const curtoAntigo = (id) => curto.get(id) ?? "L";  // item de um tipo fora da fila (a Licitação antiga, se --licitacao=novo)
  const pessoas = new Map(db.prepare("SELECT id, nome FROM pessoas").all().map((p) => [p.id, p.nome]));
  const porTipo = new Map(fila.map((t) => [t.id, { itens: 0, primeiro: null, ultimo: null, dias: 0 }]));
  const diasCurtos = new Map();
  log(`\nDIA A DIA a partir de ${inicio} (por consultor: itens, e de qual campanha da fila — 1 a ${fila.length})`);
  let data = inicio;
  for (let n = 0; n < DIAS; n++) {
    rota.gerarRotas(data);
    const itens = db.prepare(
      `SELECT r.pessoa_id p, r.cota, COALESCE(i.tipo_id, r.tipo_id) t, COUNT(i.id) n
       FROM rotas r LEFT JOIN rota_itens i ON i.rota_id = r.id WHERE r.data = ? GROUP BY 1, 2, 3`
    ).all(data);
    const porPessoa = new Map();
    for (const x of itens) {
      const p = porPessoa.get(x.p) ?? porPessoa.set(x.p, { total: 0, cota: x.cota, partes: [] }).get(x.p);
      if (!x.n) continue;
      p.total += x.n;
      p.partes.push(`${curtoAntigo(x.t)}:${x.n}`);
      const t = porTipo.get(x.t);
      if (t) { t.itens += x.n; t.primeiro ??= data; if (t.ultimo !== data) t.dias++; t.ultimo = data; }
    }
    const linha = [...porPessoa].map(([id, p]) => {
      if (p.total < p.cota) diasCurtos.set(id, (diasCurtos.get(id) || 0) + 1);
      return `${(pessoas.get(id) || id).slice(0, 10)} ${p.total}${p.total < p.cota ? "!" : ""} (${p.partes.join(" ") || "—"})`;
    });
    log(`${data}  ${linha.join(" · ") || "nenhuma rota (sem carteira?)"}`);
    baixarDia(data);
    data = rota.proximoDiaUtil(data);
  }

  log(`\nPOR CAMPANHA (dias = dias úteis em que alguém recebeu item dela)`);
  fila.forEach((t, k) => {
    const x = porTipo.get(t.id);
    log(`  ${k + 1}. ${t.nome.padEnd(26)} ${String(x.itens).padStart(5)} itens · ${String(x.dias).padStart(2)} dia(s)` +
      (x.primeiro ? ` · de ${x.primeiro} a ${x.ultimo}` : " · NUNCA ALCANÇADA no período"));
  });
  if (cicloNaRota) {
    const voltas = db.prepare(
      `SELECT r.data, r.ciclo, r.pessoa_id p,
         (SELECT MIN(x.data) FROM rotas x WHERE x.pessoa_id = r.pessoa_id AND x.ciclo = r.ciclo) inicio,
         (SELECT COUNT(*) FROM rotas x WHERE x.pessoa_id = r.pessoa_id AND x.ciclo = r.ciclo) dias
       FROM rotas r WHERE r.ciclo_concluido = 1 AND r.data >= ? ORDER BY r.data, r.pessoa_id`).all(inicio);
    log(`
VOLTAS COMPLETAS (o dia em que o consultor passou do ${fila.length}º para o 1º)`);
    for (const v of voltas) log(`  ${(pessoas.get(v.p) || v.p).padEnd(10)} volta ${v.ciclo}: ${v.inicio} → ${v.data} · ${v.dias} dias úteis de rota`);
    if (!voltas.length) log("  nenhuma no período");
  }
  if (diasCurtos.size) log(`\nrota curta (abaixo da cota) — dias: ${[...diasCurtos].map(([id, n]) => `${pessoas.get(id) || id} ${n}`).join(" · ")}`);
  for (const [k, n] of avisosRota) log(`aviso do rota.js (${n}×): ${k}`);
  db.close();  // no Windows o arquivo aberto não sai
  limpar();
  log("\n(cópia temporária apagada; o banco original não foi alterado)");
})().catch((e) => { console.error(e); process.exit(1); });
