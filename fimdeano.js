"use strict";

// ROTA FINALIZAÇÃO DE ANO (migração 36; decisões do usuário em 2026-11-10,
// plano "Resumo_Rota Final_Unyflex.pdf"). Zero IA.
//
// - FAIXA ALFABÉTICA de município por vendedor (faixas_vendedor, vigência
//   temporária 11/11–15/12): substitui o setor-sem-geografia da migração 34.
//   Nome do município comparado sem acento/caixa/pontuação e com "d'" + vogal
//   = "do" (Itapejara d'Oeste); limites casados com o IBGE — diagnóstico em
//   scripts/diagnostico-fim-de-ano.js.
// - CURSO DO DIA por vendedor (fim_ano_plano): rascunho automático (um curso
//   por dia, rodízio entre os cursos com captação aberta, ponderado pelo
//   estoque do vendedor; LicitaExpo até 13/11; Turmas 2027 em 14–15/12),
//   ajustado pelo admin e PUBLICADO. Só depois de publicado vale para a
//   geração (rota.js: campanha própria modo 'plano'). O curso do dia é o
//   setor principal; os outros cursos abertos completam a cota se faltar
//   estoque.
// - Três blocos na rota: 45 da base (faixa + curso do dia), 15 da Rota Extra
//   e 20 de ÓRGÃOS NOVOS (rota_itens.extra = 2, todo dia; não contam nas 45,
//   no prêmio nem na TV — indicador próprio no painel).
// - CONTADOR dos R$ 500 mil: matrículas de nov/dez por criada_em, sem
//   canceladas, dos CONSULTORES (é a soma dos R$ 79.580 do PDF: os cinco +
//   Renato; canais Unyflex/Gerencial e sem atribuição ficam fora). Só aparece
//   depois que o admin liga (configuracoes.fim_ano_contador = '1'), para
//   conferir o número antes de publicar.

const db = require("./db.js");
const { diaUtil } = require("./feriados.js");

const INICIO = "2026-11-11";
const FIM = "2026-12-15";
const COTA = 45;
const NOVOS_POR_DIA = 20;
const META_BASE = 40000000;   // R$ 400 mil (centavos)
const SUPERMETA = 50000000;   // R$ 500 mil
const PERIODO_VENDAS = ["2026-11-01", "2026-12-31"];

const erro = (msg, status = 400) => Object.assign(new Error(msg), { status });
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const somarDias = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hojeBrasilia = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const config = (k) => db.prepare("SELECT valor FROM configuracoes WHERE chave = ?").get(k)?.valor ?? null;
const gravarConfig = (k, v) => db.prepare("INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(k, v);
const rotaJs = () => require("./rota.js"); // carga tardia: rota.js também usa este módulo

const normNome = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
  .replace(/[^A-Z0-9]+/g, " ").trim().replace(/(^| )D (?=[AEIOU])/g, "$1DO ");

function diasUteis(de = INICIO, ate = FIM) {
  const r = [];
  for (let d = de; d <= ate; d = somarDias(d, 1)) if (diaUtil(d)) r.push(d);
  return r;
}

// ---------- faixas ----------

function faixasVigentes(data) {
  return db.prepare(
    `SELECT f.id, f.pessoa_id pessoaId, p.nome, f.uf, f.inicio, f.fim, f.vigente_desde desde, f.vigente_ate ate
     FROM faixas_vendedor f JOIN pessoas p ON p.id = f.pessoa_id
     WHERE f.vigente_desde <= ? AND (f.vigente_ate IS NULL OR f.vigente_ate >= ?) ORDER BY f.uf, f.id`).all(data, data);
}
let cacheFaixas = { chave: null, mapa: null, problemas: [] };
// pessoaId → Set(códigos IBGE) da faixa vigente na data
function municipiosPorPessoa(data) {
  const faixas = faixasVigentes(data);
  const chave = faixas.map((f) => `${f.id}`).join(",");
  if (cacheFaixas.chave === chave) return cacheFaixas.mapa;
  const mapa = new Map();
  const problemas = [];
  for (const uf of [...new Set(faixas.map((f) => f.uf))]) {
    const ms = db.prepare("SELECT codigo_ibge c, nome FROM municipios WHERE uf = ?").all(uf)
      .map((m) => ({ ...m, n: normNome(m.nome) })).sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
    for (const f of faixas.filter((x) => x.uf === uf)) {
      const i = ms.findIndex((m) => m.n === normNome(f.inicio));
      const j = ms.findIndex((m) => m.n === normNome(f.fim));
      if (i < 0 || j < 0 || j < i) { problemas.push(`${f.nome} ${uf}: ${f.inicio} → ${f.fim} não casou com o IBGE`); continue; }
      const s = mapa.get(f.pessoaId) ?? mapa.set(f.pessoaId, new Set()).get(f.pessoaId);
      for (let k = i; k <= j; k++) s.add(ms[k].c);
    }
  }
  if (problemas.length) console.warn(`⚠ fim de ano: ${problemas.join("; ")}`);
  cacheFaixas = { chave, mapa, problemas };
  return mapa;
}
const municipiosDaFaixa = (pessoaId, data) => municipiosPorPessoa(data).get(pessoaId) || new Set();

// Vendedores do plano, na ordem das faixas (Frederico, Agnes, Eduardo, Bianca, Danilo)
function vendedores() {
  return db.prepare(
    `SELECT p.id, p.nome, p.ramal, MIN(f.id) ordem FROM faixas_vendedor f JOIN pessoas p ON p.id = f.pessoa_id
     WHERE p.ativo = 1 AND f.vigente_desde <= ? AND (f.vigente_ate IS NULL OR f.vigente_ate >= ?)
     GROUP BY p.id ORDER BY ordem`).all(FIM, INICIO);
}

// ---------- cursos ----------

function cursos() {
  return db.prepare(
    `SELECT c.tipo_id tipoId, c.curso, c.setor, c.turma, c.captacao_de de, c.captacao_ate ate, c.ordem, c.papel, t.nome tipoNome, t.ativo
     FROM fim_ano_cursos c JOIN rota_tipos t ON t.id = c.tipo_id ORDER BY c.ordem`).all();
}
const cursoDoTipo = (tipoId) => cursos().find((c) => c.tipoId === Number(tipoId)) || null;
const tipoNovos = () => cursos().find((c) => c.papel === "novos") || null;
// cursos com captação aberta na data, o que fecha antes primeiro
const abertos = (data, lista = cursos()) =>
  lista.filter((c) => c.papel === "curso" && c.ativo && c.de <= data && data <= c.ate).sort((a, b) => a.ate.localeCompare(b.ate) || a.ordem - b.ordem);
// curso "fixo" da data (LicitaExpo até 13/11, Turmas 2027 em 14–15/12), se houver
const fixoDaData = (data, lista = cursos()) =>
  lista.find((c) => (c.papel === "licitaexpo" || c.papel === "2027") && c.ativo && c.de <= data && data <= c.ate) || null;

// Oferta para um órgão novo na data: dos "cursos aderentes" da planilha, o
// primeiro com captação aberta (o que fecha antes); sem nenhum aberto, o
// primeiro aderente. Nomes da planilha casados por prefixo com os cursos.
function ofertaOrgao(aderentes, data) {
  const lista = String(aderentes || "").split(";").map((s) => s.trim()).filter(Boolean);
  if (!lista.length) return null;
  const todos = cursos().filter((c) => c.papel === "curso");
  const casar = (txt) => {
    const t = normNome(txt);
    return todos.find((c) => normNome(c.curso).startsWith(t) || t.startsWith(normNome(c.curso))) ||
      todos.find((c) => normNome(c.curso).split(" ").slice(0, 2).join(" ") === t.split(" ").slice(0, 2).join(" ")) || null;
  };
  const casados = lista.map((txt) => ({ txt, c: casar(txt) }));
  const aberto = casados.filter((x) => x.c && x.c.de <= data && data <= x.c.ate).sort((a, b) => a.c.ate.localeCompare(b.c.ate))[0];
  const x = aberto || casados[0];
  return x.c ? { curso: x.c.curso, turma: x.c.turma, aberto: !!aberto } : { curso: x.txt, turma: null, aberto: false };
}

// ---------- estoque (telefones distintos do vendedor por tipo, sem bloqueio) ----------

function estoques(pessoas, lista = cursos()) {
  const { chaveTelefone } = rotaJs();
  const est = new Map(); // `${pessoaId}|${tipoId}` → telefones
  for (const c of lista) {
    if (c.papel === "novos") continue;
    const tipo = db.prepare("SELECT setores_json FROM rota_tipos WHERE id = ?").get(c.tipoId);
    const setores = JSON.parse(tipo?.setores_json || "[]");
    if (!setores.length) continue;
    const linhas = db.prepare(
      `SELECT telefone, codigo_ibge codigo FROM contatos_ativo WHERE (uf, setor) IN (VALUES ${setores.map(() => "(?, ?)").join(", ")})
         AND telefone_valido = 1 AND telefone IS NOT NULL AND COALESCE(contato_inexistente, 0) = 0 AND COALESCE(linha_oculta, 0) = 0`
    ).all(...setores.flatMap((s) => [s.uf, s.setor]));
    for (const p of pessoas) {
      const mun = municipiosDaFaixa(p.id, INICIO);
      const tel = new Set();
      for (const l of linhas) if (mun.has(l.codigo)) { const k = chaveTelefone(l.telefone); if (k) tel.add(k); }
      est.set(`${p.id}|${c.tipoId}`, tel.size);
    }
  }
  return est;
}

// ---------- plano ----------

const publicadoEm = () => config("fim_ano_publicado_em");

function linhasDoPlano(pessoaId = null) {
  return db.prepare(
    `SELECT pessoa_id pessoaId, data, tipo_id tipoId, manual FROM fim_ano_plano WHERE (? IS NULL OR pessoa_id = ?) ORDER BY data`
  ).all(pessoaId, pessoaId);
}

// Rascunho automático: um curso principal por dia e vendedor. Nos dias com
// captação aberta, o curso escolhido é o que tem a MENOR fração do estoque já
// planejada (dias × 45 ÷ telefones do vendedor); empate = a janela que fecha
// antes, e o vendedor v começa o rodízio pelo v-ésimo curso (escalonado).
// Célula ajustada à mão (manual) não é tocada; com o plano publicado, data que
// já tem rota gerada também não.
function gerarRascunho(usuarioId = null) {
  const lista = cursos();
  const pessoas = vendedores();
  const est = estoques(pessoas, lista);
  const datas = diasUteis();
  const existentes = new Map(linhasDoPlano().map((l) => [`${l.pessoaId}|${l.data}`, l]));
  const comRota = new Set(db.prepare("SELECT pessoa_id || '|' || data k FROM rotas WHERE data BETWEEN ? AND ?").all(INICIO, FIM).map((r) => r.k));
  const publicado = !!publicadoEm();
  const agora = new Date().toISOString();
  const grava = db.prepare(
    `INSERT INTO fim_ano_plano (pessoa_id, data, tipo_id, manual, atualizado_em, usuario_id) VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(pessoa_id, data) DO UPDATE SET tipo_id = excluded.tipo_id, manual = 0, atualizado_em = excluded.atualizado_em, usuario_id = excluded.usuario_id`);
  let gravadas = 0;
  db.transaction(() => {
    pessoas.forEach((p, v) => {
      const dias = new Map(); // tipoId → dias planejados
      for (const data of datas) {
        const k = `${p.id}|${data}`;
        const atual = existentes.get(k);
        if (atual && (atual.manual || (publicado && comRota.has(k)))) { dias.set(atual.tipoId, (dias.get(atual.tipoId) || 0) + 1); continue; }
        let escolhido = fixoDaData(data, lista);
        if (!escolhido) {
          const abertosHoje = abertos(data, lista).filter((c) => (est.get(`${p.id}|${c.tipoId}`) || 0) > 0);
          if (!abertosHoje.length) continue;
          const fracao = (c) => ((dias.get(c.tipoId) || 0) * COTA) / est.get(`${p.id}|${c.tipoId}`);
          const menor = Math.min(...abertosHoje.map(fracao));
          const empatados = abertosHoje.filter((c) => fracao(c) - menor < 1e-9);
          escolhido = empatados[v % empatados.length];
        }
        dias.set(escolhido.tipoId, (dias.get(escolhido.tipoId) || 0) + 1);
        if (!atual || atual.tipoId !== escolhido.tipoId || atual.manual) { grava.run(p.id, data, escolhido.tipoId, agora, usuarioId); gravadas++; }
      }
    });
  })();
  console.log(`fim de ano: rascunho do plano gerado — ${gravadas} célula(s) gravada(s)`);
  return { gravadas, plano: planoCompleto(true) };
}

// Admin troca o curso de uma célula. Com o plano publicado e rota já gerada
// para a data (futura, ninguém começou), a rota é descartada e gerada de novo.
function ajustarCelula({ pessoaId, data, tipoId }, usuarioId) {
  pessoaId = Number(pessoaId);
  if (!vendedores().some((p) => p.id === pessoaId)) throw erro("Vendedor fora do plano.", 404);
  if (!RE_DATA.test(String(data || "")) || data < INICIO || data > FIM || !diaUtil(data)) throw erro("Data fora do plano (dias úteis de 11/11 a 15/12).");
  const c = cursoDoTipo(tipoId);
  if (!c || c.papel === "novos") throw erro("Curso inválido.");
  const hoje = hojeBrasilia();
  if (data <= hoje && publicadoEm() && db.prepare("SELECT 1 FROM rotas WHERE pessoa_id = ? AND data = ?").get(pessoaId, data)) {
    throw erro("A rota deste dia já começou — o curso só muda de amanhã em diante.");
  }
  db.prepare(
    `INSERT INTO fim_ano_plano (pessoa_id, data, tipo_id, manual, atualizado_em, usuario_id) VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(pessoa_id, data) DO UPDATE SET tipo_id = excluded.tipo_id, manual = 1, atualizado_em = excluded.atualizado_em, usuario_id = excluded.usuario_id`
  ).run(pessoaId, data, c.tipoId, new Date().toISOString(), usuarioId);
  let refeita = false;
  if (publicadoEm()) {
    const r = db.prepare(
      `DELETE FROM rotas WHERE pessoa_id = ? AND data = ? AND data > ?
         AND NOT EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = rotas.id AND i.baixa_metodo IS NOT NULL)`).run(pessoaId, data, hoje);
    if (r.changes) { refeita = true; rotaJs().gerarRotas(data); }
  }
  return { pessoaId, data, tipoId: c.tipoId, curso: c.curso, refeita };
}

// PUBLICAR: o plano passa a valer para a geração a partir do próximo dia útil
// sem rota começada (rotas futuras sem baixa — de todos os consultores — são
// descartadas e geradas de novo). Cada vendedor do plano ganha a campanha
// própria modo 'plano'; quem tem campanha própria e não está no plano (Renato)
// fica com a campanha encerrada na mesma data (decisão do usuário). Publicar
// de novo só refaz as rotas futuras que ninguém começou.
function publicar(usuarioId) {
  const pessoas = vendedores();
  if (!pessoas.length) throw erro("Nenhum vendedor com faixa vigente.");
  const plano = linhasDoPlano();
  const faltam = pessoas.filter((p) => !plano.some((l) => l.pessoaId === p.id));
  if (faltam.length) throw erro(`Plano sem dias para: ${faltam.map((p) => p.nome).join(", ")} — gere o rascunho antes.`);
  const rota = rotaJs();
  const hoje = hojeBrasilia();
  const agora = new Date().toISOString();
  const resultado = db.transaction(() => {
    const descartadas = db.prepare(
      `DELETE FROM rotas WHERE data > ? AND NOT EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = rotas.id AND i.baixa_metodo IS NOT NULL)`
    ).run(hoje).changes;
    let vale = rota.proximaDataSemRota(hoje);
    if (vale < INICIO) vale = INICIO;
    const ids = cursos().map((c) => c.tipoId);
    const primeiro = cursos().find((c) => c.papel !== "novos")?.tipoId;
    const ins = db.prepare("INSERT INTO rota_campanhas (tipo_id, fila_json, vale_desde, criada_em, usuario_id, pessoa_id, modo) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const limpar = db.prepare(
      `DELETE FROM rota_campanhas WHERE vale_desde >= ? AND pessoa_id IS ? AND NOT EXISTS (SELECT 1 FROM rotas r WHERE r.campanha_id = rota_campanhas.id)`);
    const novas = [];
    for (const p of pessoas) {
      const atual = rota.campanhaVigente(vale, p.id);
      if (atual?.modo === "plano") continue;
      limpar.run(vale, p.id);
      ins.run(primeiro, JSON.stringify(ids), vale, agora, usuarioId, p.id, "plano");
      novas.push(p.nome);
    }
    const doPlano = new Set(pessoas.map((p) => p.id));
    const encerradas = [];
    for (const r of db.prepare("SELECT DISTINCT c.pessoa_id id, p.nome FROM rota_campanhas c JOIN pessoas p ON p.id = c.pessoa_id WHERE c.pessoa_id IS NOT NULL").all()) {
      if (doPlano.has(r.id)) continue;
      const atual = rota.campanhaVigente(vale, r.id);
      if (!atual?.tipoId) continue;
      limpar.run(vale, r.id);
      ins.run(null, "[]", vale, agora, usuarioId, r.id, "prioridade");
      encerradas.push(r.nome);
    }
    if (rota.campanhaVigente(vale)?.tipoId) { limpar.run(vale, null); ins.run(null, "[]", vale, agora, usuarioId, null, "ciclica"); encerradas.push("campanha geral"); }
    gravarConfig("fim_ano_publicado_em", agora);
    return { vale, descartadas, novas, encerradas };
  })();
  console.log(`fim de ano: plano PUBLICADO — vale a partir de ${resultado.vale}; campanhas do plano: ${resultado.novas.join(", ") || "(já existiam)"}; ` +
    `encerradas: ${resultado.encerradas.join(", ") || "nenhuma"}; ${resultado.descartadas} rota(s) futura(s) sem baixa descartada(s)`);
  const geracao = rota.garantirRotas();
  return { ...resultado, publicadoEm: publicadoEm(), geracao };
}

// Dias do período que a geração cobre de uma vez (rota.garantirRotas): com o
// plano publicado, os dias úteis de hoje até 15/12 (decisão do usuário,
// 2026-11-10 — todas as rotas visíveis já, não dia a dia). Sem publicar: nenhum.
function datasDoPeriodo() {
  if (!publicadoEm()) return [];
  const hoje = hojeBrasilia();
  return hoje > FIM ? [] : diasUteis(hoje > INICIO ? hoje : INICIO, FIM);
}

// REFAZER os dias futuros que ninguém começou: descarta as rotas do plano de
// `desde` (> hoje) até 15/12 SEM NENHUMA baixa — rota com qualquer baixa fica
// como está — e gera de novo, em ordem, pelo plano atual. Os bloqueios veem o
// que ficou (dias trabalhados e rotas mantidas). Sem `desde` = amanhã.
function refazerFuturas(desde, usuarioId) {
  if (!publicadoEm()) throw erro("Publique o plano antes.");
  const hoje = hojeBrasilia();
  desde = desde || somarDias(hoje, 1);
  if (!RE_DATA.test(String(desde))) throw erro("Data inválida — use AAAA-MM-DD.");
  if (desde <= hoje) throw erro("Só dá para refazer de amanhã em diante: a rota de hoje já pode ter sido começada.");
  const ids = vendedores().map((p) => p.id);
  const marc = ids.map(() => "?").join(",") || "NULL";
  const mantidas = db.prepare(
    `SELECT p.nome, r.data FROM rotas r JOIN pessoas p ON p.id = r.pessoa_id WHERE r.data BETWEEN ? AND ? AND r.pessoa_id IN (${marc})
       AND EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = r.id AND i.baixa_metodo IS NOT NULL) ORDER BY r.data`).all(desde, FIM, ...ids);
  const descartadas = db.prepare(
    `DELETE FROM rotas WHERE data BETWEEN ? AND ? AND pessoa_id IN (${marc})
       AND NOT EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = rotas.id AND i.baixa_metodo IS NOT NULL)`).run(desde, FIM, ...ids).changes;
  console.log(`fim de ano: ${descartadas} rota(s) de ${desde} a ${FIM} sem baixa descartada(s) para refazer` +
    (mantidas.length ? `; mantidas (já com baixa): ${mantidas.map((m) => `${m.nome} ${m.data}`).join(", ")}` : ""));
  const geracao = rotaJs().garantirRotas();
  return { desde, descartadas, mantidas, geracao: geracao.map((g) => ({ data: g.data, geradas: g.geradas, itens: g.itens, curtas: g.curtas })) };
}

// O dia do vendedor para a geração (rota.js): null = sem plano publicado/sem
// célula. fila = [curso do dia, os outros cursos abertos (complemento)].
function planoDoDia(pessoaId, data) {
  if (!publicadoEm()) return null;
  const l = db.prepare("SELECT tipo_id tipoId FROM fim_ano_plano WHERE pessoa_id = ? AND data = ?").get(pessoaId, data);
  if (!l) return null;
  const lista = cursos();
  // por último, Turmas 2027 (todas as abas): completa os dias em que os cursos
  // abertos ficam sem estoque — ex. 09–11/12 (decisão do usuário, 2026-11-10)
  const t2027 = lista.find((c) => c.papel === "2027" && c.ativo)?.tipoId;
  const fila = [l.tipoId, ...abertos(data, lista).map((c) => c.tipoId).filter((id) => id !== l.tipoId)];
  if (t2027 && !fila.includes(t2027)) fila.push(t2027);
  return { tipoId: l.tipoId, fila, curso: lista.find((c) => c.tipoId === l.tipoId) || null };
}

// Tela /fim-de-ano. Admin: tudo (rascunho inclusive). Vendedor: só a própria
// linha e só depois de publicado.
function planoCompleto(admin, pessoaId = null) {
  const lista = cursos();
  const publicado = publicadoEm();
  let pessoas = vendedores();
  if (!admin) pessoas = pessoas.filter((p) => p.id === pessoaId);
  const datas = diasUteis();
  const linhas = admin || publicado ? linhasDoPlano(admin ? null : pessoaId) : [];
  const celulas = {};
  for (const l of linhas) celulas[`${l.pessoaId}|${l.data}`] = { tipoId: l.tipoId, manual: !!l.manual };
  const rotas = {};
  for (const r of db.prepare(
    `SELECT r.pessoa_id p, r.data, COUNT(i.id) itens, SUM(i.extra = 0) base, SUM(i.extra = 0 AND i.baixa_metodo IS NOT NULL) feitas,
       SUM(i.extra = 0 AND i.atendida = 1) atendidas, SUM(i.extra = 1) extra, SUM(i.extra = 1 AND i.baixa_metodo IS NOT NULL) extraFeitas,
       SUM(i.extra = 2) novos, SUM(i.extra = 2 AND i.baixa_metodo IS NOT NULL) novosFeitos
     FROM rotas r LEFT JOIN rota_itens i ON i.rota_id = r.id WHERE r.data BETWEEN ? AND ? GROUP BY r.id`).all(INICIO, FIM)) {
    if (admin || r.p === pessoaId) rotas[`${r.p}|${r.data}`] = { base: r.base || 0, feitas: r.feitas || 0, atendidas: r.atendidas || 0,
      extra: r.extra || 0, extraFeitas: r.extraFeitas || 0, novos: r.novos || 0, novosFeitos: r.novosFeitos || 0 };
  }
  const faixas = faixasVigentes(INICIO).filter((f) => admin || f.pessoaId === pessoaId);
  const mun = municipiosPorPessoa(INICIO);
  const orgaos = {};
  for (const r of db.prepare(
    `SELECT pessoa_id p, COUNT(*) n, SUM(telefone_valido = 1) tel, SUM(confirmar_antes) conf FROM contatos_ativo WHERE origem = 'orgaos_novos' GROUP BY pessoa_id`).all()) {
    if (admin || r.p === pessoaId) orgaos[r.p] = { orgaos: r.n, comTelefone: r.tel || 0, confirmar: r.conf || 0 };
  }
  return {
    inicio: INICIO, fim: FIM, hoje: hojeBrasilia(), publicadoEm: publicado, admin,
    cota: COTA, novosPorDia: NOVOS_POR_DIA, extra: rotaJs().EXTRA_POR_DIA,
    datas, cursos: lista.map((c) => ({ ...c, abertoEm: datas.filter((d) => c.de <= d && d <= c.ate) })),
    vendedores: pessoas.map((p) => ({ id: p.id, nome: p.nome, ramal: p.ramal, municipios: mun.get(p.id)?.size || 0, orgaos: orgaos[p.id] || null })),
    faixas, celulas, rotas,
    estoque: admin ? Object.fromEntries(estoques(pessoas, lista)) : null,
    problemasFaixas: admin ? cacheFaixas.problemas : [],
  };
}

// ---------- contador dos R$ 500 mil ----------

// COTA INDIVIDUAL (migração 38, decisão do usuário 2026-11-10): R$ 100 mil na
// supermeta e R$ 80 mil na base por vendedor do plano (meta vigente hoje,
// própria ou padrão — editável em /metas), sobre as matrículas DELE de nov/dez
// (mesma fonte e filtro do contador geral, por matriculas.pessoa_id = wallet).
// Quem vendeu e não está no plano (Renato) aparece em `fora`: conta para o
// coletivo, sem cota. Visibilidade própria (fim_ano_cotas): admin vê sempre
// (prévia), vendedor vê só a DELE, a TV vê todas.
function cotas({ hoje, restantes, de, ate, pessoaId = null, todos = true }) {
  const metaDe = (pid, ind) => db.prepare(
    `SELECT valor FROM metas WHERE indicador = ? AND (pessoa_id = ? OR pessoa_id IS NULL) AND vigente_desde <= ? AND (vigente_ate IS NULL OR vigente_ate >= ?)
     ORDER BY pessoa_id IS NULL, vigente_desde DESC LIMIT 1`).get(ind, pid, hoje, hoje)?.valor ?? null;
  const vendido = new Map(db.prepare(
    `SELECT m.pessoa_id p, COALESCE(SUM(m.valor_centavos), 0) v, COUNT(*) n FROM matriculas m JOIN pessoas x ON x.id = m.pessoa_id
     WHERE x.tipo = 'consultor' AND m.criada_em BETWEEN ? AND ? AND (m.status IS NULL OR m.status != 'canceled') GROUP BY m.pessoa_id`
  ).all(`${de}T00:00:00`, `${ate}T23:59:59`).map((r) => [r.p, r]));
  const doPlano = vendedores();
  const parte = (meta, v) => (meta == null ? null : { metaCentavos: meta, faltaCentavos: Math.max(0, meta - v),
    porDiaCentavos: restantes ? Math.ceil(Math.max(0, meta - v) / restantes) : null, pct: meta ? Math.round((v / meta) * 1000) / 10 : null });
  const lista = doPlano.filter((p) => todos || p.id === pessoaId).map((p) => {
    const v = vendido.get(p.id)?.v || 0;
    return { pessoaId: p.id, nome: p.nome, vendidoCentavos: v, matriculas: vendido.get(p.id)?.n || 0,
      supermeta: parte(metaDe(p.id, "cota_fim_ano_super"), v), base: parte(metaDe(p.id, "cota_fim_ano_base"), v) };
  });
  const ids = new Set(doPlano.map((p) => p.id));
  const fora = todos ? db.prepare(`SELECT id, nome FROM pessoas WHERE tipo = 'consultor'`).all()
    .filter((p) => !ids.has(p.id) && vendido.get(p.id)?.v).map((p) => ({ nome: p.nome, vendidoCentavos: vendido.get(p.id).v })) : [];
  return { lista, fora };
}

function contador({ admin = false, pessoaId = null, tv = false } = {}) {
  const ativo = config("fim_ano_contador") === "1";
  const cotasAtivas = config("fim_ano_cotas") === "1";
  if (!ativo && !admin) return { ativo: false };
  const [de, ate] = PERIODO_VENDAS;
  const r = db.prepare(
    `SELECT COALESCE(SUM(m.valor_centavos), 0) v, COUNT(*) n FROM matriculas m JOIN pessoas p ON p.id = m.pessoa_id
     WHERE p.tipo = 'consultor' AND m.criada_em BETWEEN ? AND ? AND (m.status IS NULL OR m.status != 'canceled')`
  ).get(`${de}T00:00:00`, `${ate}T23:59:59`);
  const hoje = hojeBrasilia();
  const restantes = diasUteis(hoje > INICIO ? hoje : INICIO, FIM).length;
  const falta = (meta) => Math.max(0, meta - r.v);
  const sync = db.prepare("SELECT MAX(concluido_em) u FROM importacoes WHERE tipo = 'mysql' AND status = 'concluida'").get()?.u || null;
  return {
    ativo, vendidoCentavos: r.v, matriculas: r.n,
    supermeta: { metaCentavos: SUPERMETA, faltaCentavos: falta(SUPERMETA), porDiaCentavos: restantes ? Math.ceil(falta(SUPERMETA) / restantes) : null },
    base: { metaCentavos: META_BASE, faltaCentavos: falta(META_BASE), porDiaCentavos: restantes ? Math.ceil(falta(META_BASE) / restantes) : null },
    diasUteisRestantes: restantes, ate: FIM, periodo: { de, ate }, sincronizadoEm: sync,
    // cotas: admin sempre (prévia enquanto desligadas); TV todas; vendedor só a dele
    cotasAtivas,
    cotas: admin || (cotasAtivas && (tv || pessoaId))
      ? cotas({ hoje, restantes, de, ate, pessoaId, todos: admin || tv }) : null,
  };
}
function ligarCotas(ativo) {
  gravarConfig("fim_ano_cotas", ativo ? "1" : "0");
  console.log(`fim de ano: cotas individuais ${ativo ? "LIGADAS" : "desligadas"}`);
  return contador({ admin: true });
}
function ligarContador(ativo) {
  gravarConfig("fim_ano_contador", ativo ? "1" : "0");
  console.log(`fim de ano: contador dos R$ 500 mil ${ativo ? "LIGADO" : "desligado"}`);
  return contador({ admin: true });
}

module.exports = {
  INICIO, FIM, NOVOS_POR_DIA, diasUteis, faixasVigentes, municipiosDaFaixa, vendedores, cursos, cursoDoTipo, tipoNovos, abertos,
  ofertaOrgao, gerarRascunho, ajustarCelula, publicar, datasDoPeriodo, refazerFuturas, planoDoDia, planoCompleto, publicadoEm, contador, ligarContador, ligarCotas, normNome,
};
