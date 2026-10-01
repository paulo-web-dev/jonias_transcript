"use strict";

// ROTA — lista diária de ligações por consultor (migração 28; decisões do
// usuário em 2026-09-30). Zero IA: seleção determinística + SQL.
//
// - CAMPANHA POR SETOR: o admin escolhe o tipo de rota (conjunto de abas da
//   prospecção) e todas as rotas geradas a partir de `vale_desde` são daquele
//   setor. Nunca mistura setores; estoque acabou = rota curta, visível no
//   painel (sinal de que a campanha acabou para aquele consultor).
// - Mesma base da aba Trabalho: a rota guarda só contato_id (+ o telefone no
//   momento da geração, para a baixa pelo CDR) — editar na Rota é editar o
//   contato.
// - Entra: contato das regionais da carteira do consultor (regional
//   principal do município), sem consultor ou do próprio consultor, telefone
//   válido, não inexistente, não oculto. UM item por telefone.
// - BLOQUEIO (opção B do usuário, 2026-09-30): por TELEFONE dentro da mesma
//   campanha (mesmo tipo), por CONTATO entre campanhas — 30 dias com baixa,
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

function campanhaVigente(data) {
  const c = db.prepare(
    `SELECT c.id, c.tipo_id tipoId, c.vale_desde valeDesde, c.criada_em criadaEm, t.nome
     FROM rota_campanhas c LEFT JOIN rota_tipos t ON t.id = c.tipo_id
     WHERE c.vale_desde <= ? ORDER BY c.vale_desde DESC, c.id DESC LIMIT 1`
  ).get(data);
  return c || null;
}

// Troca o setor da campanha. Passa a valer na próxima data útil que ainda não
// tem rota (rota gerada não muda). Com refazerFuturas, o admin descarta antes
// as rotas de datas FUTURAS que ninguém começou (nenhuma baixa) — a de amanhã,
// gerada às 17h, volta a ser gerada já com o setor novo.
function trocarCampanha({ tipoId, refazerFuturas = false }, usuarioId) {
  const tipo = tipoId === null || tipoId === undefined || tipoId === "" ? null : lerTipo(tipoId);
  if (tipoId && !tipo) throw erro("Tipo de rota não encontrado.", 404);
  if (tipo && !tipo.ativo) throw erro("Esse tipo de rota está inativo.");
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
    const id = db.prepare("INSERT INTO rota_campanhas (tipo_id, vale_desde, criada_em, usuario_id) VALUES (?, ?, ?, ?)")
      .run(tipo ? tipo.id : null, valeDesde, new Date().toISOString(), usuarioId).lastInsertRowid;
    return { id, valeDesde, descartadas };
  })();
  console.log(`rota: campanha ${tipo ? `"${tipo.nome}"` : "encerrada"} a partir de ${resultado.valeDesde}` +
    (resultado.descartadas ? ` — ${resultado.descartadas} rota(s) futura(s) descartada(s)` : ""));
  const geracao = garantirRotas();
  return { ...resultado, tipo, geracao };
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

// Bloqueios para uma rota do tipo `tipoId` na data D (decisão do usuário,
// 2026-09-30, opção B): POR TELEFONE só dentro da mesma campanha (mesmo tipo
// de rota); entre campanhas diferentes, POR CONTATO. ~84% dos telefones de
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
    `SELECT i.telefone, i.contato_id, i.baixa_metodo, r.tipo_id FROM rota_itens i JOIN rotas r ON r.id = i.rota_id
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

// Gera as rotas que faltam na data (consultor com carteira e sem rota no dia).
// Tudo numa transação: dois consultores da mesma regional nunca recebem o
// mesmo telefone, e uma rota já gerada nunca é tocada.
function gerarRotas(data, { usuarioId = null } = {}) {
  if (!RE_DATA.test(String(data || ""))) throw erro("Data inválida — use AAAA-MM-DD.");
  const campanha = campanhaVigente(data);
  if (!campanha || !campanha.tipoId) return { data, geradas: 0, itens: 0, motivo: "sem campanha vigente" };
  const tipo = lerTipo(campanha.tipoId);
  return db.transaction(() => {
    const comRota = new Set(db.prepare("SELECT pessoa_id FROM rotas WHERE data = ?").all(data).map((r) => r.pessoa_id));
    const consultores = consultoresComCarteira().filter((p) => !comRota.has(p.id));
    if (!consultores.length) return { data, geradas: 0, itens: 0, motivo: "nenhuma rota faltando" };
    const bloqueados = bloqueiosPara(data, tipo.id);
    const candidatos = carregarCandidatos(tipo.setores);
    const viz = vizinhos();
    const tomados = new Set();

    const estados = consultores.map((p) => {
      const elegiveis = elegiveisDe(p, candidatos, bloqueados);
      const pool = new Map();
      for (const c of elegiveis) (pool.get(c.codigo) ?? pool.set(c.codigo, []).get(c.codigo)).push(c);
      for (const lista of pool.values()) lista.sort(ordemNoMunicipio);
      return { pessoa: p, pool, elegiveis: elegiveis.length, itens: [], visitados: new Set(), ultimo: null, restante: tipo.cota, fim: false };
    });
    // rodízio: cada um escolhe um município por vez; a ordem gira a cada dia
    const giro = Math.round(new Date(`${data}T12:00:00Z`).getTime() / 864e5) % estados.length;
    const ordem = [...estados.slice(giro), ...estados.slice(0, giro)];

    const livres = (s, m) => s.pool.get(m).filter((c) => !tomados.has(c.chave));
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
          s.itens.push(c);
          s.restante--;
        }
        andou = true;
      }
    }

    const agora = new Date().toISOString();
    const insRota = db.prepare(
      `INSERT INTO rotas (pessoa_id, data, campanha_id, tipo_id, setores_json, cota, elegiveis, gerada_em, gerada_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insItem = db.prepare(
      "INSERT INTO rota_itens (rota_id, contato_id, posicao, telefone, setor, codigo_ibge) VALUES (?, ?, ?, ?, ?, ?)"
    );
    let itens = 0;
    const curtas = [];
    for (const s of estados) {
      const rotaId = insRota.run(s.pessoa.id, data, campanha.id, tipo.id, JSON.stringify(tipo.setores), tipo.cota, s.elegiveis, agora, usuarioId).lastInsertRowid;
      s.itens.forEach((c, i) => insItem.run(rotaId, c.id, i + 1, c.telefone, c.setor, c.codigo));
      itens += s.itens.length;
      if (s.itens.length < tipo.cota) curtas.push(`${s.pessoa.nome} ${s.itens.length}/${tipo.cota}`);
    }
    return { data, campanha: tipo.nome, geradas: estados.length, itens, curtas };
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
    COALESCE(NULLIF(u.nome, ''), u.login) baixaPor
  FROM rota_itens i LEFT JOIN ligacoes l ON l.id = i.ligacao_id LEFT JOIN usuarios u ON u.id = i.baixa_usuario_id`;
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

function estoque(data, tipo) {
  const consultores = consultoresComCarteira();
  const bloqueados = bloqueiosPara(data, tipo.id);
  const candidatos = carregarCandidatos(tipo.setores);
  const porPessoa = consultores.map((p) => ({ pessoa: p, elegiveis: elegiveisDe(p, candidatos, bloqueados) }));
  return { consultores, bloqueados, candidatos, porPessoa };
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
    `SELECT c.id, c.vale_desde valeDesde, c.criada_em criadaEm, t.nome, COALESCE(NULLIF(u.nome, ''), u.login) usuario,
       (SELECT COUNT(*) FROM rotas r WHERE r.campanha_id = c.id) rotas
     FROM rota_campanhas c LEFT JOIN rota_tipos t ON t.id = c.tipo_id LEFT JOIN usuarios u ON u.id = c.usuario_id
     ORDER BY c.vale_desde DESC, c.id DESC LIMIT 12`
  ).all();

  // rotas do dia escolhido
  const rotasDia = db.prepare(
    `SELECT r.id, r.pessoa_id pessoaId, p.nome, r.cota, r.elegiveis, t.nome tipo FROM rotas r
     JOIN pessoas p ON p.id = r.pessoa_id JOIN rota_tipos t ON t.id = r.tipo_id WHERE r.data = ? ORDER BY p.nome`
  ).all(data).map((r) => {
    const itens = db.prepare(`${SQL_ITEM} WHERE i.rota_id = ?`).all(r.id);
    return { ...r, progresso: progressoDe(itens, r.cota) };
  });

  // estoque para a próxima geração, pelo setor que vai valer nela
  const tipoProx = campanhaProxima?.tipoId ? lerTipo(campanhaProxima.tipoId) : null;
  let estoqueInfo = null;
  if (tipoProx) {
    const e = estoque(proxima, tipoProx);
    const carteiras = db.prepare(
      `SELECT c.regional_id regional, c.pessoa_id pessoa, c.papel, p.nome FROM carteiras c JOIN pessoas p ON p.id = c.pessoa_id
       WHERE p.tipo = 'consultor' AND p.ativo = 1`).all();
    const regionais = new Map();
    for (const r of db.prepare("SELECT id, uf, sigla, nome FROM regionais").all()) regionais.set(r.id, { ...r, titular: null, apoios: [], telefones: new Set(), universo: new Set() });
    for (const c of carteiras) {
      const r = regionais.get(c.regional);
      if (c.papel === "titular") r.titular = c.nome; else r.apoios.push(c.nome);
    }
    for (const x of e.porPessoa) for (const c of x.elegiveis) regionais.get(c.regional)?.telefones.add(c.chave);
    const comCarteira = new Set(carteiras.map((c) => c.regional));
    const donos = new Map();
    for (const c of carteiras) (donos.get(c.regional) ?? donos.set(c.regional, new Set()).get(c.regional)).add(c.pessoa);
    let orfaos = 0;
    for (const c of e.candidatos) {
      if (!comCarteira.has(c.regional)) continue;
      regionais.get(c.regional).universo.add(c.chave);
      if (c.pessoaId !== null && !donos.get(c.regional).has(c.pessoaId)) orfaos++;
    }
    const total = new Set(e.porPessoa.flatMap((x) => x.elegiveis.map((c) => c.chave)));
    estoqueInfo = {
      data: proxima, tipo: tipoProx.nome, cota: tipoProx.cota,
      telefones: total.size,
      diasEquipe: e.consultores.length ? total.size / (tipoProx.cota * e.consultores.length) : 0,
      porConsultor: e.porPessoa.map((x) => ({ pessoaId: x.pessoa.id, nome: x.pessoa.nome, telefones: x.elegiveis.length, dias: x.elegiveis.length / tipoProx.cota }))
        .sort((a, b) => a.telefones - b.telefones),
      porRegional: [...regionais.values()].filter((r) => comCarteira.has(r.id)).map((r) => {
        const vinculados = (r.titular ? 1 : 0) + r.apoios.length;
        return { id: r.id, uf: r.uf, sigla: r.sigla, titular: r.titular, apoios: r.apoios, universo: r.universo.size, telefones: r.telefones.size,
          dias: vinculados ? r.telefones.size / (tipoProx.cota * vinculados) : 0 };
      }).sort((a, b) => a.uf.localeCompare(b.uf) || a.dias - b.dias),
      semCarteira: db.prepare(
        `SELECT nome FROM pessoas p WHERE tipo = 'consultor' AND ativo = 1 AND NOT EXISTS (SELECT 1 FROM carteiras c WHERE c.pessoa_id = p.id) ORDER BY nome`).all().map((p) => p.nome),
      orfaos,
      bloqueados: { telefones: e.bloqueados.telefones.size, contatos: e.bloqueados.contatos.size },
    };
  }

  // acumulado da campanha do dia escolhido (todas as rotas dela)
  let acumulado = null;
  if (campanhaDia?.tipoId) {
    const tipo = lerTipo(campanhaDia.tipoId);
    const ids = db.prepare("SELECT id FROM rota_campanhas WHERE tipo_id = ? AND vale_desde <= ? AND id IN (SELECT campanha_id FROM rotas)").all(tipo.id, data).map((c) => c.id);
    // a campanha "corrente" é a sequência de trocas para o mesmo tipo desde a última troca para outro
    const inicio = db.prepare(
      `SELECT MIN(vale_desde) d FROM rota_campanhas WHERE tipo_id = ? AND vale_desde <= ?
         AND vale_desde > COALESCE((SELECT MAX(vale_desde) FROM rota_campanhas WHERE (tipo_id IS NULL OR tipo_id <> ?) AND vale_desde <= ?), '0000')`
    ).get(tipo.id, data, tipo.id, data).d;
    const itens = db.prepare(
      `SELECT i.telefone, i.baixa_metodo, i.atendida, r.pessoa_id, r.data FROM rota_itens i JOIN rotas r ON r.id = i.rota_id
       WHERE r.tipo_id = ? AND r.data >= ? AND r.data <= ?`).all(tipo.id, inicio, data);
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
    acumulado = {
      tipo: tipo.nome, desde: inicio, dias: new Set(itens.map((i) => i.data)).size, campanhas: ids.length,
      universo: universo.size, emRota: emRota.size, tocados: tocados.size, atendidos: atendidos.size,
      semBaixa: emRota.size - tocados.size, nuncaEmRota: [...universo].filter((k) => !emRota.has(k)).length,
    };
  }

  // sobreposição de telefones da campanha vigente hoje com os outros setores
  const tipoHoje = campanhaHoje?.tipoId ? lerTipo(campanhaHoje.tipoId) : null;
  const sobre = tipoHoje ? sobreposicao(tipoHoje) : null;

  return {
    hoje, hora, data, proximaGeracao: proxima, horaGeracao: HORA_GERACAO, sobreposicao: sobre,
    bloqueio: { dias: BLOQUEIO_DIAS, semLigacaoDias: BLOQUEIO_SEM_LIGACAO_DIAS },
    campanha: { hoje: campanhaHoje, dia: campanhaDia, proxima: campanhaProxima, historico },
    rotasDia, estoque: estoqueInfo, acumulado, tipos: listarTipos(),
  };
}

module.exports = {
  agoraBrasilia, proximoDiaUtil, proximaDataSemRota, chaveTelefone,
  listarTipos, lerTipo, setoresDisponiveis, gravarTipo,
  campanhaVigente, trocarCampanha,
  bloqueiosPara, sobreposicao, gerarRotas, garantirRotas,
  baixarPeloCdr, baixarPorRegistro, desfazerBaixa, itemDaTela,
  rotaDoDia, painel,
  BLOQUEIO_DIAS, BLOQUEIO_SEM_LIGACAO_DIAS, HORA_GERACAO,
};
