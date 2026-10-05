"use strict";

// ROTA — lista diária de ligações por consultor (migração 28; decisões do
// usuário em 2026-09-30). Zero IA: seleção determinística + SQL.
//
// - CAMPANHA = FILA ORDENADA de tipos de rota (decisão do usuário,
//   2026-10-05, migração 31; antes era um setor só): ex. Licitação →
//   Tesouraria → Pregoeiro. Cada consultor começa no primeiro tipo da fila em
//   que ainda tem estoque e, se ele não enche a cota, COMPLETA no mesmo dia
//   com o próximo da fila; cada item guarda o tipo de onde veio. Cada um anda
//   sozinho: todo dia vale de novo o primeiro tipo com estoque (quando o
//   bloqueio de um tipo anterior vence, ele volta para ele). Rota curta só
//   quando a fila inteira acabou para ele. Cota = a do tipo em que a rota
//   começa.
// - Mesma base da aba Trabalho: a rota guarda só contato_id (+ o telefone no
//   momento da geração, para a baixa pelo CDR) — editar na Rota é editar o
//   contato.
// - Entra: contato das regionais da carteira do consultor (regional
//   principal do município), sem consultor ou do próprio consultor, telefone
//   válido, não inexistente, não oculto. UM item por telefone NO DIA, mesmo
//   entre tipos diferentes da fila (a baixa pelo CDR é pelo número: uma
//   ligação não diria qual dos dois itens foi feito).
// - BLOQUEIO (opção B do usuário, 2026-09-30): por TELEFONE dentro da mesma
//   tipo de rota, por CONTATO entre tipos diferentes — 30 dias com baixa,
//   7 dias para item que entrou na rota e não foi ligado; fora da rota, por
//   contato (registro manual ou ligação atribuível a ele). Ver bloqueiosPara.
// - Ordem: municípios inteiros, andando pelos vizinhos (dados/vizinhos_PR_SC
//   .json) para o consultor ligar para cidades próximas em sequência; dentro
//   do município, PM → CM → Autarquia, depois a ordem dos setores do tipo.
// - Gerada às 17h (Brasília) para o próximo dia útil; a de hoje, se faltar,
//   no primeiro tique. Uma vez gerada, NÃO muda.
// - Baixa: pelo CDR (ligação DAQUELE consultor para o número, no dia da rota;
//   atendida ou não) ou manual (registrar contato no dia). Só leitura sobre o
//   contato: a baixa pelo CDR não mexe em último contato nem no histórico.

const fs = require("fs");
const path = require("path");
const db = require("./db.js");
const { normalizarNumero, variantes } = require("./cruzamento.js");

const BLOQUEIO_DIAS = 30;
const BLOQUEIO_SEM_LIGACAO_DIAS = 7;
const HORA_GERACAO = 17;
const FUSO = "America/Sao_Paulo";
const ORDEM_ORGAO = { PM: 0, CM: 1, Autarquia: 2 };

// ---------- datas (sempre no horário de Brasília: o container roda em UTC) ----------

const formatoBrasilia = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});
function agoraBrasilia(d = new Date()) {
  const p = Object.fromEntries(formatoBrasilia.formatToParts(d).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: Number(p.hour) };
}
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
function somarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const diaUtil = (iso) => { const w = new Date(`${iso}T12:00:00Z`).getUTCDay(); return w >= 1 && w <= 5; };
function proximoDiaUtil(iso) {
  let d = somarDias(iso, 1);
  while (!diaUtil(d)) d = somarDias(d, 1);
  return d;
}
const temRotas = (data) => !!db.prepare("SELECT 1 FROM rotas WHERE data = ? LIMIT 1").get(data);
// Primeira data útil ≥ hoje que ainda não tem rota: é onde uma troca de campanha passa a valer
function proximaDataSemRota(hoje = agoraBrasilia().data) {
  let d = diaUtil(hoje) ? hoje : proximoDiaUtil(hoje);
  while (temRotas(d)) d = proximoDiaUtil(d);
  return d;
}

function erro(msg, status = 400) {
  return Object.assign(new Error(msg), { status });
}

// ---------- telefone ----------

// Chave única do número: a variante mais longa (celular com o nono dígito),
// para "44 9 9721-1407" e "44 9721-1407" serem o mesmo telefone
function chaveTelefone(t) {
  const n = normalizarNumero(t);
  if (n.length < 10) return null;
  return variantes(n).sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

// ---------- vizinhança ----------

let vizinhosCache = null;
function vizinhos() {
  if (vizinhosCache) return vizinhosCache;
  vizinhosCache = new Map();
  const arq = path.join(__dirname, "dados", "vizinhos_PR_SC.json");
  if (fs.existsSync(arq)) {
    for (const [c, lista] of Object.entries(JSON.parse(fs.readFileSync(arq, "utf8")))) vizinhosCache.set(Number(c), lista.map(Number));
  }
  return vizinhosCache;
}

// ---------- tipos de rota (setores da campanha) ----------

function tipoDe(r) {
  return r && { id: r.id, nome: r.nome, setores: JSON.parse(r.setores_json), cota: r.cota, ativo: !!r.ativo, criadoEm: r.criado_em, atualizadoEm: r.atualizado_em };
}
const lerTipo = (id) => tipoDe(db.prepare("SELECT * FROM rota_tipos WHERE id = ?").get(Number(id)));
const listarTipos = () => db.prepare("SELECT * FROM rota_tipos ORDER BY ativo DESC, nome").all().map(tipoDe);

// Setores que existem na base (para montar um tipo): por UF + aba, com quantas linhas estão aptas
function setoresDisponiveis() {
  return db.prepare(
    `SELECT uf, setor, COUNT(*) linhas,
       SUM(telefone_valido = 1 AND telefone IS NOT NULL AND COALESCE(contato_inexistente, 0) = 0 AND COALESCE(linha_oculta, 0) = 0) aptas
     FROM contatos_ativo GROUP BY uf, setor ORDER BY uf, setor`
  ).all();
}

function gravarTipo(dados, usuarioId) {
  const nome = String(dados.nome || "").trim().slice(0, 80);
  if (!nome) throw erro("Dê um nome ao tipo de rota.");
  const cota = Number(dados.cota ?? 45);
  if (!Number.isInteger(cota) || cota < 1 || cota > 500) throw erro("Cota inválida — de 1 a 500 por dia.");
  if (!Array.isArray(dados.setores) || !dados.setores.length) throw erro("Escolha ao menos um setor.");
  const existentes = new Set(setoresDisponiveis().map((s) => `${s.uf}|${s.setor}`));
  const setores = [];
  const vistos = new Set();
  for (const s of dados.setores) {
    const uf = String(s?.uf || "").toUpperCase(), setor = String(s?.setor ?? "");
    const k = `${uf}|${setor}`;
    if (!existentes.has(k)) throw erro(`Setor inexistente na base: ${uf} "${setor}".`);
    if (!vistos.has(k)) { vistos.add(k); setores.push({ uf, setor }); }
  }
  const ativo = dados.ativo === undefined ? 1 : dados.ativo ? 1 : 0;
  const agora = new Date().toISOString();
  const outro = db.prepare("SELECT id FROM rota_tipos WHERE nome = ? AND id <> ?").get(nome, Number(dados.id) || 0);
  if (outro) throw erro("Já existe um tipo com esse nome.");
  if (dados.id) {
    const atual = lerTipo(dados.id);
    if (!atual) throw erro("Tipo de rota não encontrado.", 404);
    db.prepare("UPDATE rota_tipos SET nome = ?, setores_json = ?, cota = ?, ativo = ?, atualizado_em = ?, usuario_id = ? WHERE id = ?")
      .run(nome, JSON.stringify(setores), cota, ativo, agora, usuarioId, atual.id);
    return lerTipo(atual.id);
  }
  const id = db.prepare("INSERT INTO rota_tipos (nome, setores_json, cota, ativo, criado_em, usuario_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(nome, JSON.stringify(setores), cota, ativo, agora, usuarioId).lastInsertRowid;
  return lerTipo(id);
}

// ---------- campanhas ----------

// Fila da campanha: ids dos tipos na ordem (fila_json; campanha anterior à
// migração 31 tem o tipo único). `nome` = "Licitação → Tesouraria"; `tipoId` =
// primeiro da fila (NULL = campanha encerrada).
function comFila(c) {
  if (!c) return null;
  const ids = c.fila_json ? JSON.parse(c.fila_json) : c.tipoId ? [c.tipoId] : [];
  delete c.fila_json;
  const nomes = new Map(db.prepare("SELECT id, nome FROM rota_tipos").all().map((t) => [t.id, t.nome]));
  c.fila = ids.map((id) => ({ id, nome: nomes.get(id) ?? `tipo ${id}` }));
  c.nome = c.fila.length ? c.fila.map((t) => t.nome).join(" → ") : null;
  return c;
}
function campanhaVigente(data) {
  return comFila(db.prepare(
    `SELECT c.id, c.tipo_id tipoId, c.fila_json, c.vale_desde valeDesde, c.criada_em criadaEm
     FROM rota_campanhas c WHERE c.vale_desde <= ? ORDER BY c.vale_desde DESC, c.id DESC LIMIT 1`
  ).get(data));
}

// Troca a FILA da campanha (lista ordenada de tipos; vazia = encerrar). Passa
// a valer na próxima data útil que ainda não tem rota (rota gerada não muda).
// Com refazerFuturas, o admin descarta antes as rotas de datas FUTURAS que
// ninguém começou (nenhuma baixa) — a de amanhã, gerada às 17h, volta a ser
// gerada já com a fila nova. `tipoId` sozinho (cliente antigo) = fila de um.
function trocarCampanha({ fila, tipoId, refazerFuturas = false }, usuarioId) {
  if (fila === undefined) fila = tipoId === null || tipoId === undefined || tipoId === "" ? [] : [tipoId];
  if (!Array.isArray(fila)) throw erro("Fila inválida.");
  if (fila.length > 20) throw erro("Fila longa demais — no máximo 20 tipos.");
  const tipos = [];
  for (const id of fila) {
    const t = lerTipo(id);
    if (!t) throw erro(`Tipo de rota ${id} não encontrado.`, 404);
    if (!t.ativo) throw erro(`O tipo "${t.nome}" está inativo.`);
    if (tipos.some((x) => x.id === t.id)) throw erro(`O tipo "${t.nome}" aparece duas vezes na fila.`);
    tipos.push(t);
  }
  const tipo = tipos[0] || null;
  const { data: hoje } = agoraBrasilia();
  const resultado = db.transaction(() => {
    let descartadas = 0;
    if (refazerFuturas) {
      descartadas = db.prepare(
        `DELETE FROM rotas WHERE data > ? AND NOT EXISTS (SELECT 1 FROM rota_itens i WHERE i.rota_id = rotas.id AND i.baixa_metodo IS NOT NULL)`
      ).run(hoje).changes;
    }
    const valeDesde = proximaDataSemRota(hoje);
    // agendamentos anteriores que ainda não geraram rota são substituídos por este
    db.prepare(
      `DELETE FROM rota_campanhas WHERE vale_desde >= ? AND NOT EXISTS (SELECT 1 FROM rotas r WHERE r.campanha_id = rota_campanhas.id)`
    ).run(valeDesde);
    const id = db.prepare("INSERT INTO rota_campanhas (tipo_id, fila_json, vale_desde, criada_em, usuario_id) VALUES (?, ?, ?, ?, ?)")
      .run(tipo ? tipo.id : null, JSON.stringify(tipos.map((t) => t.id)), valeDesde, new Date().toISOString(), usuarioId).lastInsertRowid;
    return { id, valeDesde, descartadas };
  })();
  const nome = tipos.map((t) => t.nome).join(" → ");
  console.log(`rota: campanha ${tipo ? `"${nome}"` : "encerrada"} a partir de ${resultado.valeDesde}` +
    (resultado.descartadas ? ` — ${resultado.descartadas} rota(s) futura(s) descartada(s)` : ""));
  const geracao = garantirRotas();
  return { ...resultado, tipo, fila: tipos, nome, geracao };
}

// ---------- elegibilidade ----------

function consultoresComCarteira() {
  const linhas = db.prepare(
    `SELECT p.id, p.nome, c.regional_id regional, c.papel FROM pessoas p JOIN carteiras c ON c.pessoa_id = p.id
     WHERE p.tipo = 'consultor' AND p.ativo = 1 ORDER BY p.id`
  ).all();
  const porId = new Map();
  for (const l of linhas) {
    const p = porId.get(l.id) ?? porId.set(l.id, { id: l.id, nome: l.nome, regionais: new Set() }).get(l.id);
    p.regionais.add(l.regional);
  }
  return [...porId.values()];
}

// Bloqueios para o tipo `tipoId` na data D (decisão do usuário, 2026-09-30,
// opção B): POR TELEFONE só dentro do mesmo tipo de rota (o do ITEM — numa
// fila, a rota mistura tipos); entre tipos diferentes, POR CONTATO. ~84% dos telefones de
// qualquer setor são o número geral da prefeitura: bloquear o número entre
// campanhas esvaziaria toda campanha depois da primeira — ligar de novo para a
// prefeitura pedindo outro setor é a conversa normal.
// - item de rota: 30 dias com baixa (CDR ou manual), 7 dias sem baixa;
// - fora da rota, sempre por contato (30 dias): registro manual (histórico ou
//   último contato) e ligação do CDR atribuível ao contato (número que só ele
//   tem — ligacoes.contato_id do cruzamento). Ligação para número
//   compartilhado não diz de qual setor era e não bloqueia ninguém.
// Devolve { telefones: variante → motivo, contatos: id → motivo }.
function bloqueiosPara(data, tipoId) {
  const d30 = somarDias(data, -BLOQUEIO_DIAS);
  const d7 = somarDias(data, -BLOQUEIO_SEM_LIGACAO_DIAS);
  const telefones = new Map();
  const contatos = new Map();
  const bloquearTelefone = (t, motivo) => {
    const n = normalizarNumero(t);
    if (n.length < 10) return;
    for (const v of variantes(n)) if (!telefones.has(v)) telefones.set(v, motivo);
  };
  const bloquearContato = (id, motivo) => { if (id && !contatos.has(id)) contatos.set(id, motivo); };
  // rota: 7 dias para qualquer item (inclui hoje e datas já geradas à frente), 30 com baixa
  for (const r of db.prepare(
    `SELECT i.telefone, i.contato_id, i.baixa_metodo, COALESCE(i.tipo_id, r.tipo_id) tipo_id FROM rota_itens i JOIN rotas r ON r.id = i.rota_id
     WHERE r.data >= ? AND (i.baixa_metodo IS NOT NULL OR r.data >= ?)`).all(d30, d7)) {
    const motivo = r.baixa_metodo ? "rota_baixa" : "rota_7d";
    if (r.tipo_id === tipoId) bloquearTelefone(r.telefone, motivo);
    else bloquearContato(r.contato_id, motivo);
  }
  // CDR atribuível a um contato: saída (atendida ou não) ou entrada atendida
  for (const r of db.prepare(
    `SELECT DISTINCT contato_id FROM ligacoes WHERE data_hora >= ? AND contato_id IS NOT NULL AND (sentido = 'S' OR atendida = 1)`).all(`${d30}T00:00:00`)) {
    bloquearContato(r.contato_id, "cdr");
  }
  // registro manual: último contato preenchido ou histórico de contato nos últimos 30 dias
  for (const r of db.prepare(
    `SELECT id FROM contatos_ativo WHERE data_ultimo_contato >= ? AND data_ultimo_contato <= ?`).all(d30, data)) {
    bloquearContato(r.id, "registro");
  }
  for (const r of db.prepare(
    `SELECT DISTINCT contato_id FROM contatos_ativo_historico WHERE tipo = 'contato' AND registrado_em >= ?`).all(d30)) {
    bloquearContato(r.contato_id, "registro");
  }
  return { telefones, contatos };
}
const bloqueado = (b, c) => b.contatos.has(c.id) || variantes(normalizarNumero(c.telefone)).some((v) => b.telefones.has(v));

// Contatos aptos dos setores do tipo, com a regional principal do município
function carregarCandidatos(setores) {
  if (!setores.length) return [];
  const valores = setores.map(() => "(?, ?)").join(", ");
  return db.prepare(
    `SELECT a.id, a.telefone, a.pessoa_id pessoaId, a.uf, a.setor, a.orgao, a.codigo_ibge codigo, a.data_ultimo_contato ultimo,
            a.responsavel, m.regional_principal_id regional
     FROM contatos_ativo a JOIN municipios m ON m.codigo_ibge = a.codigo_ibge
     WHERE (a.uf, a.setor) IN (VALUES ${valores})
       AND a.telefone_valido = 1 AND a.telefone IS NOT NULL
       AND COALESCE(a.contato_inexistente, 0) = 0 AND COALESCE(a.linha_oculta, 0) = 0`
  ).all(...setores.flatMap((s) => [s.uf, s.setor]))
    .map((c) => ({ ...c, chave: chaveTelefone(c.telefone), ordemSetor: setores.findIndex((s) => s.uf === c.uf && s.setor === c.setor) }))
    .filter((c) => c.chave);
}

// Elegíveis de um consultor: um contato por telefone (o do próprio consultor,
// depois a ordem dos setores, depois o que tem responsável, depois o id)
function elegiveisDe(pessoa, candidatos, bloqueados) {
  const porChave = new Map();
  for (const c of candidatos) {
    if (!pessoa.regionais.has(c.regional)) continue;
    if (c.pessoaId !== null && c.pessoaId !== pessoa.id) continue;
    if (bloqueado(bloqueados, c)) continue;
    const atual = porChave.get(c.chave);
    if (!atual || preferir(c, atual, pessoa.id) < 0) porChave.set(c.chave, c);
  }
  return [...porChave.values()];
}
const preferir = (a, b, pessoaId) =>
  (b.pessoaId === pessoaId) - (a.pessoaId === pessoaId) || a.ordemSetor - b.ordemSetor || !!b.responsavel - !!a.responsavel || a.id - b.id;

const ordemNoMunicipio = (a, b) =>
  (ORDEM_ORGAO[a.orgao] ?? 3) - (ORDEM_ORGAO[b.orgao] ?? 3) || a.ordemSetor - b.ordemSetor ||
  (a.ultimo ? 1 : 0) - (b.ultimo ? 1 : 0) || String(a.ultimo || "").localeCompare(String(b.ultimo || "")) || a.id - b.id;

// ---------- geração ----------

// Tipos ativos da fila de uma campanha, cada um com bloqueios e candidatos
// (tipo inativado depois de entrar na fila é pulado, com aviso no log)
function fasesDaFila(campanha, data) {
  const fases = [];
  for (const { id } of campanha.fila) {
    const tipo = lerTipo(id);
    if (!tipo || !tipo.ativo) { console.warn(`rota: tipo ${tipo ? `"${tipo.nome}"` : id} da fila está inativo/inexistente — pulado`); continue; }
    fases.push({ tipo, bloqueados: bloqueiosPara(data, tipo.id), candidatos: carregarCandidatos(tipo.setores) });
  }
  return fases;
}

// Estoque de um consultor em cada tipo da fila (elegíveis, um por telefone)
const elegiveisNaFila = (pessoa, fases) => fases.map((f) => elegiveisDe(pessoa, f.candidatos, f.bloqueados));

// Gera as rotas que faltam na data (consultor com carteira e sem rota no dia).
// Tudo numa transação: dois consultores da mesma regional nunca recebem o
// mesmo telefone, e uma rota já gerada nunca é tocada.
// FILA (migração 31): uma fase por tipo, na ordem. Na fase k entram os
// consultores que ainda não encheram a cota — quem tem estoque no 1º tipo
// começa nele; quem esgotou já começa no 2º; quem enche só parte da cota no
// 1º completa com o 2º no mesmo dia. Um telefone por dia em todas as rotas.
function gerarRotas(data, { usuarioId = null } = {}) {
  if (!RE_DATA.test(String(data || ""))) throw erro("Data inválida — use AAAA-MM-DD.");
  const campanha = campanhaVigente(data);
  if (!campanha || !campanha.tipoId) return { data, geradas: 0, itens: 0, motivo: "sem campanha vigente" };
  return db.transaction(() => {
    const comRota = new Set(db.prepare("SELECT pessoa_id FROM rotas WHERE data = ?").all(data).map((r) => r.pessoa_id));
    const consultores = consultoresComCarteira().filter((p) => !comRota.has(p.id));
    if (!consultores.length) return { data, geradas: 0, itens: 0, motivo: "nenhuma rota faltando" };
    const fases = fasesDaFila(campanha, data);
    if (!fases.length) return { data, geradas: 0, itens: 0, motivo: "nenhum tipo ativo na fila" };
    const viz = vizinhos();
    const tomados = new Set();          // telefones (chave) já em alguma rota do dia
    const contatosTomados = new Set();  // tipos com abas em comum não repetem o contato

    const estados = consultores.map((p) => {
      const porFase = elegiveisNaFila(p, fases).map((elegiveis) => {
        const pool = new Map();
        for (const c of elegiveis) (pool.get(c.codigo) ?? pool.set(c.codigo, []).get(c.codigo)).push(c);
        for (const lista of pool.values()) lista.sort(ordemNoMunicipio);
        return { pool, n: elegiveis.length };
      });
      const inicio = Math.max(0, porFase.findIndex((f) => f.n > 0));
      const tipoRota = fases[inicio].tipo;
      return { pessoa: p, porFase, tipoRota, elegiveis: porFase.reduce((t, f) => t + f.n, 0), itens: [], ultimo: null, restante: tipoRota.cota };
    });
    // rodízio: cada um escolhe um município por vez; a ordem gira a cada dia
    const giro = Math.round(new Date(`${data}T12:00:00Z`).getTime() / 864e5) % estados.length;
    const ordem = [...estados.slice(giro), ...estados.slice(0, giro)];

    const livres = (s, m) => s.pool.get(m).filter((c) => !tomados.has(c.chave) && !contatosTomados.has(c.id));
    const pontuar = (s, m) => {
      const l = livres(s, m);
      return [l.filter((c) => !c.ultimo).length, l.length];
    };
    function proximoMunicipio(s) {
      const disponiveis = [...s.pool.keys()].filter((m) => !s.visitados.has(m) && livres(s, m).length);
      if (!disponiveis.length) return null;
      let cands = s.ultimo !== null ? disponiveis.filter((m) => (viz.get(s.ultimo) || []).includes(m)) : [];
      if (!cands.length && s.visitados.size) {
        const fronteira = new Set([...s.visitados].flatMap((v) => viz.get(v) || []));
        cands = disponiveis.filter((m) => fronteira.has(m));
      }
      if (!cands.length) cands = disponiveis;
      return cands
        .map((m) => [m, pontuar(s, m)])
        .sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1] || a[0] - b[0])[0][0];
    }
    fases.forEach((fase, k) => {
      // o último município da fase anterior continua valendo: o tipo seguinte
      // começa perto de onde o consultor parou
      for (const s of estados) Object.assign(s, { pool: s.porFase[k].pool, visitados: new Set(), fim: false });
      let andou = true;
      while (andou) {
        andou = false;
        for (const s of ordem) {
          if (s.fim || s.restante <= 0) continue;
          const m = proximoMunicipio(s);
          if (m === null) { s.fim = true; continue; }
          s.visitados.add(m);
          s.ultimo = m;
          for (const c of livres(s, m)) {
            if (s.restante <= 0) break;
            tomados.add(c.chave);
            contatosTomados.add(c.id);
            s.itens.push({ ...c, tipoId: fase.tipo.id });
            s.restante--;
          }
          andou = true;
        }
      }
    });

    const agora = new Date().toISOString();
    const insRota = db.prepare(
      `INSERT INTO rotas (pessoa_id, data, campanha_id, tipo_id, setores_json, cota, elegiveis, gerada_em, gerada_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insItem = db.prepare(
      "INSERT INTO rota_itens (rota_id, contato_id, posicao, telefone, setor, codigo_ibge, tipo_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    // setores_json = a fila NA geração (cada setor com o tipo de onde vem)
    const setoresFila = JSON.stringify(fases.flatMap((f) => f.tipo.setores.map((x) => ({ ...x, tipoId: f.tipo.id, tipo: f.tipo.nome }))));
    let itens = 0;
    const curtas = [];
    for (const s of estados) {
      const rotaId = insRota.run(s.pessoa.id, data, campanha.id, s.tipoRota.id, setoresFila, s.tipoRota.cota, s.elegiveis, agora, usuarioId).lastInsertRowid;
      s.itens.forEach((c, i) => insItem.run(rotaId, c.id, i + 1, c.telefone, c.setor, c.codigo, c.tipoId));
      itens += s.itens.length;
      if (s.itens.length < s.tipoRota.cota) curtas.push(`${s.pessoa.nome} ${s.itens.length}/${s.tipoRota.cota}`);
    }
    return { data, campanha: campanha.nome, geradas: estados.length, itens, curtas };
  })();
}

// Tique (a cada 5 min e no boot): hoje, se for dia útil e faltar rota; a do
// próximo dia útil a partir das 17h
function garantirRotas() {
  const { data: hoje, hora } = agoraBrasilia();
  const feitas = [];
  const datas = [];
  if (diaUtil(hoje)) datas.push(hoje);
  if (hora >= HORA_GERACAO) datas.push(proximoDiaUtil(hoje));
  for (const d of datas) {
    try {
      const r = gerarRotas(d);
      if (r.geradas) {
        console.log(`rota: ${r.geradas} rota(s) de ${r.campanha} geradas para ${d} — ${r.itens} item(ns)` +
          (r.curtas.length ? `; curtas: ${r.curtas.join(", ")}` : ""));
        feitas.push(r);
      }
    } catch (err) {
      console.error(`✖  rota: falha ao gerar ${d}:`, err.message || err);
    }
  }
  return feitas;
}

// ---------- baixa ----------

// Pelo CDR: ligação de SAÍDA do dono da rota para o número do item, no dia da
// rota. Várias ligações: vale a atendida, senão a última. Reprocessável (CDR
// reimportado refaz as baixas 'cdr'); baixa manual só ganha a evidência.
function baixarPeloCdr() {
  const t0 = Date.now();
  const itens = db.prepare(
    `SELECT i.id, i.telefone, i.baixa_metodo metodo, i.ligacao_id ligacao, r.pessoa_id pessoa, r.data
     FROM rota_itens i JOIN rotas r ON r.id = i.rota_id
     WHERE i.baixa_metodo IS NULL OR i.baixa_metodo = 'cdr' OR (i.baixa_metodo = 'manual' AND i.ligacao_id IS NULL)`
  ).all();
  if (!itens.length) return { itens: 0, baixadas: 0, ms: Date.now() - t0 };
  const datas = itens.map((i) => i.data).sort();
  const indice = new Map();
  for (const l of db.prepare(
    `SELECT id, pessoa_id, data_hora, numero_b, atendida FROM ligacoes
     WHERE sentido = 'S' AND pessoa_id IS NOT NULL AND data_hora BETWEEN ? AND ?`).all(`${datas[0]}T00:00:00`, `${datas[datas.length - 1]}T23:59:59`)) {
    const n = normalizarNumero(l.numero_b);
    if (n.length < 10) continue;
    const k = `${l.pessoa_id}|${l.data_hora.slice(0, 10)}|${n}`;
    (indice.get(k) ?? indice.set(k, []).get(k)).push(l);
  }
  const marcarCdr = db.prepare("UPDATE rota_itens SET baixa_em = ?, baixa_metodo = 'cdr', ligacao_id = ?, atendida = ?, baixa_usuario_id = NULL WHERE id = ?");
  const limpar = db.prepare("UPDATE rota_itens SET baixa_em = NULL, baixa_metodo = NULL, ligacao_id = NULL, atendida = NULL WHERE id = ?");
  const evidencia = db.prepare("UPDATE rota_itens SET ligacao_id = ?, atendida = ? WHERE id = ?");
  let baixadas = 0;
  db.transaction(() => {
    for (const i of itens) {
      const ligs = variantes(normalizarNumero(i.telefone)).flatMap((v) => indice.get(`${i.pessoa}|${i.data}|${v}`) || []);
      const l = ligs.sort((a, b) => b.atendida - a.atendida || b.data_hora.localeCompare(a.data_hora))[0];
      if (i.metodo === "manual") { if (l) evidencia.run(l.id, l.atendida, i.id); continue; }
      if (l) {
        if (i.ligacao !== l.id) { marcarCdr.run(l.data_hora, l.id, l.atendida, i.id); baixadas++; }
      } else if (i.metodo === "cdr") {
        limpar.run(i.id);
      }
    }
  })();
  return { itens: itens.length, baixadas, ms: Date.now() - t0 };
}

// Manual: registrar contato (qualquer canal) num contato que está numa rota
// do dia do registro dá baixa no item
function baixarPorRegistro(contatoId, dia, usuarioId) {
  return db.prepare(
    `UPDATE rota_itens SET baixa_em = ?, baixa_metodo = 'manual', baixa_usuario_id = ?
     WHERE contato_id = ? AND baixa_metodo IS NULL AND rota_id IN (SELECT id FROM rotas WHERE data = ?)`
  ).run(new Date().toISOString(), usuarioId, Number(contatoId), dia).changes;
}

// Desfazer baixa MANUAL (engano). O registro no histórico do contato continua.
function desfazerBaixa(itemId, escopo) {
  const item = itemVisivel(itemId, escopo);
  if (item.baixa_metodo !== "manual") throw erro("Só a baixa manual pode ser desfeita — a do CDR vem da ligação.");
  db.prepare("UPDATE rota_itens SET baixa_em = NULL, baixa_metodo = NULL, baixa_usuario_id = NULL, ligacao_id = NULL, atendida = NULL WHERE id = ?").run(item.id);
  baixarPeloCdr();
  return itemDaTela(item.id);
}

function itemVisivel(itemId, escopo) {
  const item = db.prepare("SELECT i.*, r.pessoa_id FROM rota_itens i JOIN rotas r ON r.id = i.rota_id WHERE i.id = ?").get(Number(itemId));
  if (!item || (escopo && item.pessoa_id !== escopo.pessoaId)) throw erro("Item de rota não encontrado.", 404);
  return item;
}

// ---------- telas ----------

const SQL_ITEM = `SELECT i.id, i.contato_id contatoId, i.posicao, i.setor, i.baixa_em baixaEm, i.baixa_metodo baixaMetodo,
    i.atendida, l.data_hora ligacaoEm, l.tempo_conversa_seg conversaSeg, l.evento_falha eventoFalha,
    COALESCE(NULLIF(u.nome, ''), u.login) baixaPor, i.tipo_id tipoId, t.nome tipoNome
  FROM rota_itens i LEFT JOIN ligacoes l ON l.id = i.ligacao_id LEFT JOIN usuarios u ON u.id = i.baixa_usuario_id
    LEFT JOIN rota_tipos t ON t.id = i.tipo_id`;
const itemDaTela = (id) => db.prepare(`${SQL_ITEM} WHERE i.id = ?`).get(Number(id));

function progressoDe(itens, cota) {
  const feitas = itens.filter((i) => i.baixaMetodo).length;
  return {
    cota, itens: itens.length, feitas,
    atendidas: itens.filter((i) => i.atendida === 1).length,
    manuais: itens.filter((i) => i.baixaMetodo === "manual").length,
    pelaCdr: itens.filter((i) => i.baixaMetodo === "cdr").length,
    pendentes: itens.length - feitas,
  };
}

// Rota de um consultor num dia, com as linhas no formato da aba Trabalho.
// Vendedor: só a própria (outra pessoa = 404). Admin sem pessoa: a primeira
// rota do dia.
function rotaDoDia({ data, pessoaId }, usuario, escopo) {
  const { data: hoje } = agoraBrasilia();
  data = data || hoje;
  if (!RE_DATA.test(data)) throw erro("Data inválida — use AAAA-MM-DD.");
  garantirRotas();
  const pessoas = db.prepare(
    `SELECT r.pessoa_id id, p.nome FROM rotas r JOIN pessoas p ON p.id = r.pessoa_id WHERE r.data = ? ORDER BY p.nome`
  ).all(data);
  if (escopo) {
    if (pessoaId && Number(pessoaId) !== escopo.pessoaId) throw erro("Rota não encontrada.", 404);
    pessoaId = escopo.pessoaId;
  } else if (!pessoaId) {
    pessoaId = pessoas[0]?.id ?? null;
  }
  const datas = db.prepare(
    `SELECT DISTINCT data FROM rotas WHERE (? IS NULL OR pessoa_id = ?) ORDER BY data DESC LIMIT 30`
  ).all(escopo ? escopo.pessoaId : null, escopo ? escopo.pessoaId : null).map((r) => r.data);
  const base = {
    data, hoje, proximaGeracao: proximoDiaUtil(hoje), datas,
    pessoas: escopo ? null : pessoas,
    campanha: campanhaVigente(data),
  };
  const rota = pessoaId
    ? db.prepare(
        `SELECT r.id, r.pessoa_id pessoaId, p.nome, r.data, r.cota, r.elegiveis, r.gerada_em geradaEm, t.nome tipo, r.setores_json
         FROM rotas r JOIN pessoas p ON p.id = r.pessoa_id JOIN rota_tipos t ON t.id = r.tipo_id
         WHERE r.pessoa_id = ? AND r.data = ?`).get(Number(pessoaId), data)
    : null;
  if (!rota) return { ...base, rota: null, contatos: null };
  const itens = db.prepare(`${SQL_ITEM} WHERE i.rota_id = ? ORDER BY i.posicao`).all(rota.id);
  const contatos = require("./prospeccao.js").payloadContatos(itens.map((i) => i.contatoId), usuario, escopo);
  rota.setores = JSON.parse(rota.setores_json);
  delete rota.setores_json;
  // tipos da fila que entraram nesta rota, na ordem dos itens
  rota.tipos = [...new Map(itens.filter((i) => i.tipoId).map((i) => [i.tipoId, i.tipoNome])).values()];
  return { ...base, rota: { ...rota, itens, progresso: progressoDe(itens, rota.cota) }, contatos };
}

// Sobreposição: quantos contatos da campanha (regionais com carteira) têm o
// telefone igual ao de algum contato de OUTRO setor — o tamanho do "número
// geral da prefeitura", para o admin escolher a próxima campanha sabendo.
function sobreposicao(tipo) {
  const comCarteira = new Set(db.prepare("SELECT regional_id r FROM carteiras").all().map((c) => c.r));
  const daCampanha = carregarCandidatos(tipo.setores).filter((c) => comCarteira.has(c.regional));
  const doTipo = new Set(tipo.setores.map((s) => `${s.uf}|${s.setor}`));
  const outros = new Map(); // variante → Set("UF setor")
  for (const r of db.prepare("SELECT uf, setor, telefone FROM contatos_ativo WHERE telefone IS NOT NULL").all()) {
    if (doTipo.has(`${r.uf}|${r.setor}`)) continue;
    const n = normalizarNumero(r.telefone);
    if (n.length < 10) continue;
    for (const v of variantes(n)) (outros.get(v) ?? outros.set(v, new Set()).get(v)).add(`${r.uf} ${r.setor}`);
  }
  const porSetor = new Map();
  const telefones = new Set(), telefonesCompartilhados = new Set();
  let compartilham = 0;
  for (const c of daCampanha) {
    telefones.add(c.chave);
    const setores = new Set(variantes(normalizarNumero(c.telefone)).flatMap((v) => [...(outros.get(v) || [])]));
    if (!setores.size) continue;
    compartilham++;
    telefonesCompartilhados.add(c.chave);
    for (const s of setores) porSetor.set(s, (porSetor.get(s) || 0) + 1);
  }
  return {
    tipo: tipo.nome, contatos: daCampanha.length, compartilham,
    telefones: telefones.size, telefonesCompartilhados: telefonesCompartilhados.size,
    porSetor: [...porSetor].map(([setor, contatos]) => ({ setor, contatos })).sort((a, b) => b.contatos - a.contatos).slice(0, 12),
  };
}

// ---------- painel do admin ----------

// TV: progresso da rota de HOJE (Brasília) por consultor. Mesmo corte das
// outras telas (consultor ativo com entra_tv = 1). Percentual = feitas ÷ itens
// da rota (decisão do usuário, 2026-10-01): rota curta — estoque acabou — fecha
// 100% com os itens que recebeu, e a TV mostra o selo com a cota. Sem campanha
// vigente hoje ou sem rota com itens, `ativa = false` e a tela sai da rotação.
function progressoTv() {
  const { data } = agoraBrasilia();
  const campanha = campanhaVigente(data);
  const porPessoa = db.prepare(
    `SELECT r.id, p.nome, r.cota, t.nome tipo FROM rotas r JOIN pessoas p ON p.id = r.pessoa_id JOIN rota_tipos t ON t.id = r.tipo_id
     WHERE r.data = ? AND p.tipo = 'consultor' AND p.ativo = 1 AND p.entra_tv = 1 ORDER BY p.nome`
  ).all(data).map((r) => {
    const pr = progressoDe(db.prepare(`${SQL_ITEM} WHERE i.rota_id = ?`).all(r.id), r.cota);
    return {
      nome: r.nome, tipo: r.tipo, cota: pr.cota, itens: pr.itens, feitas: pr.feitas, atendidas: pr.atendidas,
      pct: pr.itens ? Math.floor((pr.feitas / pr.itens) * 100) : null, curta: pr.itens < pr.cota,
    };
  });
  const ativa = !!campanha?.tipoId && porPessoa.some((p) => p.itens > 0);
  return { data, campanha: campanha?.tipoId ? campanha.nome : null, ativa, porPessoa };
}

// Rotas da SEMANA por consultor (telas STATUS, SEMANA e RANKING da TV):
// um registro por rota com itens e feitas. Feita = baixa pelo CDR ou manual.
// Semana corrente de Brasília, de segunda até hoje.
function rotasDaSemanaTv() {
  const { data: ate } = agoraBrasilia();
  const semanaDe = somarDias(ate, -((new Date(`${ate}T12:00:00Z`).getUTCDay() + 6) % 7));
  return db.prepare(
    `SELECT p.nome, r.data, r.cota, COUNT(i.id) itens, COALESCE(SUM(i.baixa_metodo IS NOT NULL), 0) feitas,
            COALESCE(SUM(i.atendida = 1), 0) atendidas
     FROM rotas r JOIN pessoas p ON p.id = r.pessoa_id LEFT JOIN rota_itens i ON i.rota_id = r.id
     WHERE r.data BETWEEN ? AND ? AND p.tipo = 'consultor' AND p.ativo = 1 AND p.entra_tv = 1
     GROUP BY r.id ORDER BY r.data`
  ).all(semanaDe, ate);
}

// Estoque da FILA para a data da próxima geração: por consultor, o setor em
// que ele está (primeiro tipo da fila com estoque), dias no setor atual e na
// fila inteira (Σ telefones do tipo ÷ cota do tipo); por regional, o total da
// fila. Telefone que aparece em dois tipos conta nos dois: entre tipos o
// bloqueio é por contato, então são duas ligações (opção B).
function estoqueDaFila(data, campanha) {
  const fases = fasesDaFila(campanha, data);
  if (!fases.length) return null;
  const consultores = consultoresComCarteira();
  const porPessoa = consultores.map((p) => ({ pessoa: p, porFase: elegiveisNaFila(p, fases) }));
  const carteiras = db.prepare(
    `SELECT c.regional_id regional, c.pessoa_id pessoa, c.papel, p.nome FROM carteiras c JOIN pessoas p ON p.id = c.pessoa_id
     WHERE p.tipo = 'consultor' AND p.ativo = 1`).all();
  const regionais = new Map();
  for (const r of db.prepare("SELECT id, uf, sigla, nome FROM regionais").all()) {
    regionais.set(r.id, { ...r, titular: null, apoios: [], telefones: fases.map(() => new Set()), universo: fases.map(() => new Set()) });
  }
  for (const c of carteiras) {
    const r = regionais.get(c.regional);
    if (c.papel === "titular") r.titular = c.nome; else r.apoios.push(c.nome);
  }
  const comCarteira = new Set(carteiras.map((c) => c.regional));
  const donos = new Map();
  for (const c of carteiras) (donos.get(c.regional) ?? donos.set(c.regional, new Set()).get(c.regional)).add(c.pessoa);
  const orfaos = new Set();
  fases.forEach((f, k) => {
    for (const x of porPessoa) for (const c of x.porFase[k]) regionais.get(c.regional)?.telefones[k].add(c.chave);
    for (const c of f.candidatos) {
      if (!comCarteira.has(c.regional)) continue;
      regionais.get(c.regional).universo[k].add(c.chave);
      if (c.pessoaId !== null && !donos.get(c.regional).has(c.pessoaId)) orfaos.add(c.id);
    }
  });
  const totaisFase = fases.map((f, k) => new Set(porPessoa.flatMap((x) => x.porFase[k].map((c) => c.chave))).size);
  const n = consultores.length;
  return {
    data, tipo: campanha.nome, cota: fases[0].tipo.cota,
    fila: fases.map((f, k) => ({ id: f.tipo.id, nome: f.tipo.nome, cota: f.tipo.cota, telefones: totaisFase[k],
      diasEquipe: n ? totaisFase[k] / (f.tipo.cota * n) : 0 })),
    telefones: totaisFase.reduce((a, b) => a + b, 0),
    diasEquipe: n ? fases.reduce((t, f, k) => t + totaisFase[k] / (f.tipo.cota * n), 0) : 0,
    porConsultor: porPessoa.map((x) => {
      const porTipo = fases.map((f, k) => ({ nome: f.tipo.nome, telefones: x.porFase[k].length, dias: x.porFase[k].length / f.tipo.cota }));
      const atual = porTipo.findIndex((t) => t.telefones > 0);
      return {
        pessoaId: x.pessoa.id, nome: x.pessoa.nome, porTipo,
        setorAtual: atual >= 0 ? porTipo[atual].nome : null,
        posicaoAtual: atual >= 0 ? atual + 1 : null,
        telefonesAtual: atual >= 0 ? porTipo[atual].telefones : 0,
        diasAtual: atual >= 0 ? porTipo[atual].dias : 0,
        telefones: porTipo.reduce((t, p) => t + p.telefones, 0),
        dias: porTipo.reduce((t, p) => t + p.dias, 0),
      };
    }).sort((a, b) => a.dias - b.dias),
    porRegional: [...regionais.values()].filter((r) => comCarteira.has(r.id)).map((r) => {
      const vinculados = (r.titular ? 1 : 0) + r.apoios.length;
      const tel = r.telefones.map((t) => t.size);
      return { id: r.id, uf: r.uf, sigla: r.sigla, titular: r.titular, apoios: r.apoios,
        universo: r.universo.reduce((t, u) => t + u.size, 0), telefones: tel.reduce((a, b) => a + b, 0),
        porTipo: fases.map((f, k) => ({ nome: f.tipo.nome, telefones: tel[k] })),
        dias: vinculados ? fases.reduce((t, f, k) => t + tel[k] / (f.tipo.cota * vinculados), 0) : 0 };
    }).sort((a, b) => a.uf.localeCompare(b.uf) || a.dias - b.dias),
    semCarteira: db.prepare(
      `SELECT nome FROM pessoas p WHERE tipo = 'consultor' AND ativo = 1 AND entra_painel = 1 AND NOT EXISTS (SELECT 1 FROM carteiras c WHERE c.pessoa_id = p.id) ORDER BY nome`).all().map((p) => p.nome),
    orfaos: orfaos.size,
    bloqueados: { tipo: fases[0].tipo.nome, telefones: fases[0].bloqueados.telefones.size, contatos: fases[0].bloqueados.contatos.size },
  };
}

// Acumulado de um tipo até a data: desde o início da sequência mais recente de
// campanhas cuja fila contém o tipo (trocar a ordem da fila não zera; tirar o
// tipo da fila e pôr de novo começa outro acumulado)
function acumuladoDoTipo(tipo, data) {
  const campanhas = db.prepare(
    "SELECT tipo_id tipoId, fila_json, vale_desde valeDesde FROM rota_campanhas WHERE vale_desde <= ? ORDER BY vale_desde DESC, id DESC"
  ).all(data).map(comFila);
  let inicio = null;
  for (const c of campanhas) {
    if (!c.fila.some((t) => t.id === tipo.id)) break;
    inicio = c.valeDesde;
  }
  if (!inicio) return null;
  const itens = db.prepare(
    `SELECT i.telefone, i.baixa_metodo, i.atendida, r.data FROM rota_itens i JOIN rotas r ON r.id = i.rota_id
     WHERE i.tipo_id = ? AND r.data >= ? AND r.data <= ?`).all(tipo.id, inicio, data);
  const universo = new Set();
  const carteiras = new Set(db.prepare("SELECT regional_id r FROM carteiras").all().map((c) => c.r));
  for (const c of carregarCandidatos(tipo.setores)) if (carteiras.has(c.regional)) universo.add(c.chave);
  const tocados = new Set(), emRota = new Set(), atendidos = new Set();
  for (const i of itens) {
    const k = chaveTelefone(i.telefone);
    emRota.add(k);
    if (i.baixa_metodo) tocados.add(k);
    if (i.atendida === 1) atendidos.add(k);
  }
  return {
    tipo: tipo.nome, desde: inicio, dias: new Set(itens.map((i) => i.data)).size,
    universo: universo.size, emRota: emRota.size, tocados: tocados.size, atendidos: atendidos.size,
    semBaixa: emRota.size - tocados.size, nuncaEmRota: [...universo].filter((k) => !emRota.has(k)).length,
  };
}

function painel(dataArg) {
  const { data: hoje, hora } = agoraBrasilia();
  const data = dataArg && RE_DATA.test(dataArg) ? dataArg : hoje;
  garantirRotas();
  const proxima = proximaDataSemRota(hoje);
  const campanhaDia = campanhaVigente(data);
  const campanhaProxima = campanhaVigente(proxima);
  const campanhaHoje = campanhaVigente(hoje);
  const historico = db.prepare(
    `SELECT c.id, c.tipo_id tipoId, c.fila_json, c.vale_desde valeDesde, c.criada_em criadaEm, COALESCE(NULLIF(u.nome, ''), u.login) usuario,
       (SELECT COUNT(*) FROM rotas r WHERE r.campanha_id = c.id) rotas
     FROM rota_campanhas c LEFT JOIN usuarios u ON u.id = c.usuario_id
     ORDER BY c.vale_desde DESC, c.id DESC LIMIT 12`
  ).all().map(comFila);

  // rotas do dia escolhido, com os tipos da fila que entraram em cada uma
  const rotasDia = db.prepare(
    `SELECT r.id, r.pessoa_id pessoaId, p.nome, r.cota, r.elegiveis, t.nome tipo FROM rotas r
     JOIN pessoas p ON p.id = r.pessoa_id JOIN rota_tipos t ON t.id = r.tipo_id WHERE r.data = ? ORDER BY p.nome`
  ).all(data).map((r) => {
    const itens = db.prepare(`${SQL_ITEM} WHERE i.rota_id = ? ORDER BY i.posicao`).all(r.id);
    const tipos = new Map();
    for (const i of itens) if (i.tipoId) tipos.set(i.tipoNome, (tipos.get(i.tipoNome) || 0) + 1);
    return { ...r, tipos: [...tipos].map(([nome, n]) => ({ nome, itens: n })), progresso: progressoDe(itens, r.cota) };
  });

  // estoque para a próxima geração, pela fila que vai valer nela
  const estoqueInfo = campanhaProxima?.tipoId ? estoqueDaFila(proxima, campanhaProxima) : null;

  // acumulado de cada tipo da fila do dia escolhido
  const acumulados = (campanhaDia?.fila || []).map((t) => lerTipo(t.id)).filter(Boolean)
    .map((t) => acumuladoDoTipo(t, data)).filter(Boolean);

  // sobreposição de telefones do 1º tipo da fila vigente hoje com os outros setores
  const tipoHoje = campanhaHoje?.tipoId ? lerTipo(campanhaHoje.tipoId) : null;
  const sobre = tipoHoje ? sobreposicao(tipoHoje) : null;

  return {
    hoje, hora, data, proximaGeracao: proxima, horaGeracao: HORA_GERACAO, sobreposicao: sobre,
    bloqueio: { dias: BLOQUEIO_DIAS, semLigacaoDias: BLOQUEIO_SEM_LIGACAO_DIAS },
    campanha: { hoje: campanhaHoje, dia: campanhaDia, proxima: campanhaProxima, historico },
    rotasDia, estoque: estoqueInfo, acumulados, tipos: listarTipos(),
  };
}

module.exports = {
  agoraBrasilia, proximoDiaUtil, proximaDataSemRota, chaveTelefone,
  listarTipos, lerTipo, setoresDisponiveis, gravarTipo,
  campanhaVigente, trocarCampanha,
  bloqueiosPara, sobreposicao, gerarRotas, garantirRotas,
  baixarPeloCdr, baixarPorRegistro, desfazerBaixa, itemDaTela, progressoTv, rotasDaSemanaTv,
  rotaDoDia, painel,
  BLOQUEIO_DIAS, BLOQUEIO_SEM_LIGACAO_DIAS, HORA_GERACAO,
};
