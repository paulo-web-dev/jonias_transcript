"use strict";

// PATRIMÔNIO — Fase 1 (migrações 43–44, 2026-11-18; decisões do usuário).
// A Emanuelle (financeiro) controla os bens da Unyflex: 218 itens renumerados
// de 0001 a 0218 (pelo caminho de colagem), entregues e devolvidos com termo
// assinado no celular dela. Itens pessoais dos funcionários ficam FORA.
//
// - patrimonio_itens guarda o estado ATUAL; patrimonio_movimentos o histórico,
//   imutável (gatilhos no banco). TODA mudança de pessoa, local ou status
//   grava um movimento — nesta camada, sempre na mesma transação.
// - Responsável = pessoa ATIVA do tipo consultor ou administrativo (canal
//   nunca). Responsável só muda por TERMO assinado (entrega, devolução,
//   transferência), nunca pela edição da tabela.
// - Termo: entrega | devolução, número sequencial por ano (0001/2026);
//   transferência = devolução assinada por quem entrega + entrega assinada por
//   quem recebe (duas assinaturas). Um item nunca está em dois termos abertos
//   (índice único parcial). Só o admin cancela, com motivo: os itens voltam ao
//   estado anterior com um movimento "ajuste".
// - Importação da planilha (carga inicial): chave = CÓDIGO NOVO; STATUS =
//   CONSUMO é ignorado (Fase 2); responsável/sala que não casam viram ressalva
//   (nunca cria pessoa nem local); sem termo, movimento "ajuste" "carga
//   inicial". Reimportar atualiza o descritivo sempre e pessoa/local/status só
//   em item que nunca foi trabalhado no sistema. Coluna com "senha" no nome é
//   descartada (nunca vai ao banco, nem em extras).
// - CPF não é guardado: a via impressa sai com a linha em branco.

const crypto = require("crypto");
const zlib = require("zlib");
const JSZip = require("jszip");
const db = require("./db.js");

const STATUS = ["em_uso", "em_estoque", "em_reparo", "baixado"];
const ESTADOS = ["bom", "regular", "ruim"];
const ROTULO_STATUS = { em_uso: "em uso", em_estoque: "em estoque", em_reparo: "em reparo", baixado: "baixado" };
const ASSINATURA_MAX_BYTES = 400 * 1024;

function erro(msg, status = 400) {
  return Object.assign(new Error(msg), { status });
}

const fmtLocal = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
// Data/hora operacional em horário de Brasília, sem Z (padrão da central de dados)
const agora = () => fmtLocal.format(new Date()).replace(" ", "T");

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").trim();
const limpo = (v) => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

// ---------- referências ----------

function responsaveis() {
  return db.prepare(
    `SELECT id, nome, tipo FROM pessoas WHERE ativo = 1 AND tipo IN ('consultor', 'administrativo') ORDER BY nome`
  ).all();
}
function pessoaResponsavel(id) {
  const p = db.prepare(
    "SELECT id, nome, tipo FROM pessoas WHERE id = ? AND ativo = 1 AND tipo IN ('consultor', 'administrativo')"
  ).get(Number(id));
  if (!p) throw erro("Responsável precisa ser uma pessoa ativa cadastrada no jonIAs (consultor ou administrativo).");
  return p;
}
function listarLocais() {
  return db.prepare(
    `SELECT l.id, l.andar, l.nome, l.ordem, l.ativo,
            (SELECT COUNT(*) FROM patrimonio_itens i WHERE i.local_id = l.id AND i.status <> 'baixado') itens
     FROM locais l ORDER BY l.andar, l.ordem, l.nome`
  ).all();
}
function localValido(id, { exigirAtivo = true } = {}) {
  const l = db.prepare("SELECT * FROM locais WHERE id = ?").get(Number(id));
  if (!l || (exigirAtivo && !l.ativo)) throw erro("Local inexistente ou inativo.");
  return l;
}
function criarLocal({ andar, nome }) {
  const a = Number(andar);
  const n = limpo(nome);
  if (!Number.isInteger(a) || a < 0 || a > 50) throw erro("Andar inválido.");
  if (!n) throw erro("Informe o nome da sala.");
  if (db.prepare("SELECT 1 FROM locais WHERE andar = ? AND lower(nome) = lower(?)").get(a, n)) throw erro("Esse local já existe nesse andar.");
  const ordem = (db.prepare("SELECT MAX(ordem) m FROM locais").get().m || 0) + 1;
  const info = db.prepare("INSERT INTO locais (andar, nome, ordem) VALUES (?, ?, ?)").run(a, n, ordem);
  return db.prepare("SELECT * FROM locais WHERE id = ?").get(info.lastInsertRowid);
}
function editarLocal(id, { nome, ativo }) {
  const l = localValido(id, { exigirAtivo: false });
  const novoNome = nome === undefined ? l.nome : limpo(nome);
  if (!novoNome) throw erro("Informe o nome da sala.");
  if (db.prepare("SELECT 1 FROM locais WHERE andar = ? AND lower(nome) = lower(?) AND id <> ?").get(l.andar, novoNome, l.id)) {
    throw erro("Já existe um local com esse nome nesse andar.");
  }
  const novoAtivo = ativo === undefined ? l.ativo : (ativo ? 1 : 0);
  if (!novoAtivo && db.prepare("SELECT COUNT(*) n FROM patrimonio_itens WHERE local_id = ? AND status <> 'baixado'").get(l.id).n) {
    throw erro("O local ainda tem itens: mova-os antes de desativar.");
  }
  db.prepare("UPDATE locais SET nome = ?, ativo = ? WHERE id = ?").run(novoNome, novoAtivo, l.id);
  return db.prepare("SELECT * FROM locais WHERE id = ?").get(l.id);
}

// ---------- itens ----------

const SQL_ITEM = `
  SELECT i.*, l.andar, l.nome local_nome, p.nome pessoa_nome,
         t.id termo_id, t.ano termo_ano, t.seq termo_seq, t.data_hora termo_data
  FROM patrimonio_itens i
  LEFT JOIN locais l ON l.id = i.local_id
  LEFT JOIN pessoas p ON p.id = i.pessoa_id
  LEFT JOIN patrimonio_termo_itens ti ON ti.item_id = i.id AND ti.aberto = 1
  LEFT JOIN patrimonio_termos t ON t.id = ti.termo_id`;

const numeroTermo = (ano, seq) => `${String(seq).padStart(4, "0")}/${ano}`;

function formatarItem(r) {
  return {
    id: r.id, codigo: r.codigo, nome: r.nome, marcaModelo: r.marca_modelo, numeroSerie: r.numero_serie,
    categoria: r.categoria, conservacao: r.estado_conservacao, status: r.status, localId: r.local_id,
    local: r.local_id ? `${r.andar}º · ${r.local_nome}` : null, andar: r.andar ?? null,
    pessoaId: r.pessoa_id, pessoa: r.pessoa_nome ?? null, conjunto: r.conjunto, valorCentavos: r.valor_centavos,
    dataAquisicao: r.data_aquisicao, notaFiscal: r.nota_fiscal, observacao: r.observacao,
    codigoAntigo: r.codigo_antigo, origem: r.origem, baixadoEm: r.baixado_em, motivoBaixa: r.motivo_baixa,
    termo: r.termo_id ? { id: r.termo_id, numero: numeroTermo(r.termo_ano, r.termo_seq), data: r.termo_data } : null,
    // alertas: responsável sem termo assinado (carga inicial) é o roteiro de coleta
    semTermo: Boolean(r.pessoa_id && !r.termo_id),
  };
}

function listarItens() {
  return db.prepare(`${SQL_ITEM} ORDER BY i.codigo`).all().map(formatarItem);
}
function buscarItem(id) {
  const r = db.prepare(`${SQL_ITEM} WHERE i.id = ?`).get(Number(id));
  if (!r) throw erro("Item não encontrado.", 404);
  return r;
}

const insMov = () => db.prepare(
  `INSERT INTO patrimonio_movimentos (item_id, tipo, pessoa_de, pessoa_para, local_de, local_para, status_de, status_para,
     termo_id, importacao_id, usuario_id, data_hora, observacao)
   VALUES (@item, @tipo, @pessoaDe, @pessoaPara, @localDe, @localPara, @statusDe, @statusPara, @termo, @importacao, @usuario, @quando, @obs)`
);

// Campos que a tabela edita direto (descritivo). Pessoa e status NÃO: pessoa só
// por termo; status pelo menu (reparo, baixa) — cada um com o seu movimento.
const CAMPOS_TEXTO = {
  nome: "nome", marcaModelo: "marca_modelo", numeroSerie: "numero_serie", categoria: "categoria",
  conjunto: "conjunto", notaFiscal: "nota_fiscal", observacao: "observacao", dataAquisicao: "data_aquisicao",
};

function atualizarItem(id, corpo, usuario) {
  const atual = buscarItem(id);
  const sets = {};
  for (const [k, col] of Object.entries(CAMPOS_TEXTO)) {
    if (!(k in corpo)) continue;
    let v = limpo(corpo[k]);
    if (k === "nome" && !v) throw erro("O item precisa de um nome.");
    if (k === "dataAquisicao" && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw erro("Data de aquisição: AAAA-MM-DD.");
    if (k === "observacao" && v && /senha/i.test(v)) throw erro("Senha não se guarda no patrimônio. Tire a senha da observação.");
    sets[col] = v;
  }
  if ("conservacao" in corpo) {
    const v = limpo(corpo.conservacao);
    if (v && !ESTADOS.includes(v)) throw erro("Conservação: bom, regular ou ruim.");
    sets.estado_conservacao = v;
  }
  if ("valorCentavos" in corpo) {
    const v = corpo.valorCentavos === null || corpo.valorCentavos === "" ? null : Number(corpo.valorCentavos);
    if (v !== null && (!Number.isInteger(v) || v < 0)) throw erro("Valor inválido.");
    sets.valor_centavos = v;
  }
  if ("pessoaId" in corpo) throw erro("O responsável só muda por termo assinado (Entregar / Devolver).");
  if ("status" in corpo) throw erro("Status muda pelo menu do item (reparo, baixa) ou por termo.");
  let novoLocal;
  if ("localId" in corpo) {
    novoLocal = corpo.localId === null || corpo.localId === "" ? null : localValido(corpo.localId).id;
  }
  const quando = agora();
  db.transaction(() => {
    const cols = Object.keys(sets);
    if (cols.length) {
      db.prepare(`UPDATE patrimonio_itens SET ${cols.map((c) => `${c} = @${c}`).join(", ")}, atualizado_em = @quando WHERE id = @id`)
        .run({ ...sets, quando, id: atual.id });
    }
    if (novoLocal !== undefined && novoLocal !== atual.local_id) {
      db.prepare("UPDATE patrimonio_itens SET local_id = ?, atualizado_em = ? WHERE id = ?").run(novoLocal, quando, atual.id);
      insMov().run({
        item: atual.id, tipo: "ajuste", pessoaDe: atual.pessoa_id, pessoaPara: atual.pessoa_id, localDe: atual.local_id,
        localPara: novoLocal, statusDe: atual.status, statusPara: atual.status, termo: null, importacao: null,
        usuario: usuario.id, quando, obs: limpo(corpo.motivo) || "local ajustado na tabela",
      });
    }
  })();
  return formatarItem(buscarItem(atual.id));
}

// Menu do item: reparo (saída/retorno), baixa e desfazer baixa (só admin)
function mudarStatus(id, { acao, motivo }, usuario) {
  const atual = buscarItem(id);
  const quando = agora();
  let tipo, para, extra = {};
  const m = limpo(motivo);
  if (acao === "reparo_saida") {
    if (atual.status === "em_reparo") throw erro("O item já está em reparo.");
    if (atual.status === "baixado") throw erro("Item baixado não vai para reparo.");
    tipo = "reparo_saida"; para = "em_reparo";
  } else if (acao === "reparo_retorno") {
    if (atual.status !== "em_reparo") throw erro("O item não está em reparo.");
    tipo = "reparo_retorno"; para = atual.pessoa_id ? "em_uso" : "em_estoque";
  } else if (acao === "baixa") {
    if (atual.status === "baixado") throw erro("O item já está baixado.");
    if (!m) throw erro("Informe o motivo da baixa.");
    if (atual.termo_id || atual.pessoa_id) throw erro("O item está com uma pessoa: faça a devolução antes da baixa.", 409);
    tipo = "baixa"; para = "baixado"; extra = { baixado_em: quando, motivo_baixa: m };
  } else if (acao === "desfazer_baixa") {
    if (usuario.papel !== "admin") throw erro("Só o administrador desfaz uma baixa.", 403);
    if (atual.status !== "baixado") throw erro("O item não está baixado.");
    if (!m) throw erro("Informe o motivo para desfazer a baixa.");
    tipo = "ajuste"; para = "em_estoque"; extra = { baixado_em: null, motivo_baixa: null };
  } else {
    throw erro("Ação inválida.");
  }
  db.transaction(() => {
    const cols = { status: para, ...extra };
    db.prepare(`UPDATE patrimonio_itens SET ${Object.keys(cols).map((c) => `${c} = @${c}`).join(", ")}, atualizado_em = @quando WHERE id = @id`)
      .run({ ...cols, quando, id: atual.id });
    insMov().run({
      item: atual.id, tipo, pessoaDe: atual.pessoa_id, pessoaPara: atual.pessoa_id, localDe: atual.local_id,
      localPara: atual.local_id, statusDe: atual.status, statusPara: para, termo: null, importacao: null,
      usuario: usuario.id, quando, obs: acao === "desfazer_baixa" ? `baixa desfeita: ${m}` : m,
    });
  })();
  return formatarItem(buscarItem(atual.id));
}

function historicoDoItem(id) {
  const item = buscarItem(id);
  const movimentos = db.prepare(
    `SELECT m.id, m.tipo, m.data_hora dataHora, m.observacao, m.status_de statusDe, m.status_para statusPara,
            pd.nome pessoaDe, pp.nome pessoaPara,
            CASE WHEN ld.id IS NULL THEN NULL ELSE ld.andar || 'º · ' || ld.nome END localDe,
            CASE WHEN lp.id IS NULL THEN NULL ELSE lp.andar || 'º · ' || lp.nome END localPara,
            m.termo_id termoId, t.ano, t.seq, COALESCE(u.nome, u.login) usuario
     FROM patrimonio_movimentos m
     LEFT JOIN pessoas pd ON pd.id = m.pessoa_de LEFT JOIN pessoas pp ON pp.id = m.pessoa_para
     LEFT JOIN locais ld ON ld.id = m.local_de LEFT JOIN locais lp ON lp.id = m.local_para
     LEFT JOIN patrimonio_termos t ON t.id = m.termo_id LEFT JOIN usuarios u ON u.id = m.usuario_id
     WHERE m.item_id = ? ORDER BY m.id DESC`
  ).all(item.id).map((m) => ({ ...m, termo: m.termoId ? numeroTermo(m.ano, m.seq) : null, ano: undefined, seq: undefined }));
  return { item: formatarItem(item), movimentos };
}

// ---------- assinatura ----------

// PNG em data URL, com pelo menos um pixel desenhado. A conferência do traço é
// feita aqui também (não só no canvas): descomprime o IDAT e procura qualquer
// byte não nulo fora do byte de filtro de cada linha — um canvas transparente
// em branco dá tudo zero.
function validarAssinatura(dataUrl) {
  const s = String(dataUrl || "");
  const m = s.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw erro("Assinatura ausente: a pessoa precisa assinar no quadro.");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > ASSINATURA_MAX_BYTES) throw erro("Assinatura grande demais.");
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw erro("Assinatura inválida (não é PNG).");
  let pos = 8, largura = 0, profundidade = 0, tipoCor = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const tipo = buf.toString("ascii", pos + 4, pos + 8);
    const dados = buf.subarray(pos + 8, pos + 8 + len);
    if (tipo === "IHDR") { largura = dados.readUInt32BE(0); profundidade = dados[8]; tipoCor = dados[9]; }
    if (tipo === "IDAT") idat.push(dados);
    if (tipo === "IEND") break;
    pos += 12 + len;
  }
  if (!largura || !idat.length) throw erro("Assinatura inválida (PNG sem imagem).");
  let bruto;
  try { bruto = zlib.inflateSync(Buffer.concat(idat)); } catch (_) { throw erro("Assinatura inválida (PNG corrompido)."); }
  const canais = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[tipoCor] || 4;
  const linha = 1 + Math.ceil((largura * canais * profundidade) / 8);
  for (let i = 0; i < bruto.length; i++) {
    if (i % linha === 0) continue; // byte do filtro da linha
    if (bruto[i] !== 0) return s;
  }
  throw erro("A assinatura está em branco: a pessoa precisa assinar no quadro.");
}

// ---------- termos ----------

function proximoNumero(ano) {
  return (db.prepare("SELECT MAX(seq) m FROM patrimonio_termos WHERE ano = ?").get(ano).m || 0) + 1;
}
function criarTermo({ tipo, pessoaId, localId, assinatura, assinanteNome, observacao, relacionadoId = null }, usuario, quando) {
  const ano = Number(quando.slice(0, 4));
  const seq = proximoNumero(ano);
  const info = db.prepare(
    `INSERT INTO patrimonio_termos (tipo, ano, seq, pessoa_id, local_id, data_hora, assinatura, assinante_nome, usuario_id, observacao, relacionado_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(tipo, ano, seq, pessoaId, localId, quando, assinatura, assinanteNome, usuario.id, observacao, relacionadoId);
  return { id: Number(info.lastInsertRowid), numero: numeroTermo(ano, seq) };
}

function idsDeItens(itemIds) {
  const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(Number))];
  if (!ids.length || ids.some((x) => !Number.isInteger(x) || x <= 0)) throw erro("Selecione pelo menos um item.");
  if (ids.length > 300) throw erro("Itens demais num termo só.");
  return ids;
}

// Conservação AVALIADA NO ATO, obrigatória para cada item, na entrega e na
// devolução (decisão do usuário, 18/11/2026: na devolução nunca é herdada da
// entrega — é o que mostra se o item voltou pior do que saiu). {itemId: estado}
function conservacoesDoAto(valor, ids, codigoDe) {
  const mapa = valor && typeof valor === "object" ? valor : {};
  const faltam = ids.filter((id) => !ESTADOS.includes(mapa[id] ?? mapa[String(id)]));
  if (faltam.length) throw erro(`Informe a conservação de cada item, avaliada agora (bom, regular ou ruim): ${faltam.map(codigoDe).join(", ")}.`);
  return Object.fromEntries(ids.map((id) => [id, mapa[id] ?? mapa[String(id)]]));
}

// Entrega: vários itens, uma pessoa, um local, uma assinatura → 1 termo e 1
// movimento por item. Item com termo aberto (com qualquer pessoa) é recusado:
// para passar de uma pessoa a outra, é transferência (Devolver → transferir).
// Item que veio da carga com responsável e sem termo pode ser entregue —
// inclusive à mesma pessoa (regularização: pessoa_de = pessoa_para).
function entregar(corpo, usuario) {
  const ids = idsDeItens(corpo.itemIds);
  const pessoa = pessoaResponsavel(corpo.pessoaId);
  const local = localValido(corpo.localId);
  const assinatura = validarAssinatura(corpo.assinatura);
  const assinante = limpo(corpo.assinanteNome) || pessoa.nome;
  const quando = agora();
  return db.transaction(() => {
    const itens = ids.map((id) => buscarItem(id));
    for (const it of itens) {
      if (it.termo_id) throw erro(`O item ${it.codigo} já está no termo ${numeroTermo(it.termo_ano, it.termo_seq)}, em aberto: devolva ou transfira antes.`, 409);
      if (it.status === "baixado") throw erro(`O item ${it.codigo} está baixado.`, 409);
      if (it.status === "em_reparo") throw erro(`O item ${it.codigo} está em reparo.`, 409);
      if (it.pessoa_id && it.pessoa_id !== pessoa.id) {
        throw erro(`O item ${it.codigo} consta com ${it.pessoa_nome} (sem termo). Para passar a outra pessoa, use Devolver → transferir.`, 409);
      }
    }
    const termo = criarTermo({ tipo: "entrega", pessoaId: pessoa.id, localId: local.id, assinatura, assinanteNome: assinante, observacao: limpo(corpo.observacao) }, usuario, quando);
    // conservação gravada como está no ato da assinatura (migração 45)
    const cons = conservacoesDoAto(corpo.conservacoes, ids, (id) => itens.find((i) => i.id === id).codigo);
    const insItem = db.prepare("INSERT INTO patrimonio_termo_itens (termo_id, item_id, aberto, conservacao) VALUES (?, ?, 1, ?)");
    const upd = db.prepare("UPDATE patrimonio_itens SET pessoa_id = ?, local_id = ?, status = 'em_uso', estado_conservacao = ?, atualizado_em = ? WHERE id = ?");
    const mov = insMov();
    for (const it of itens) {
      insItem.run(termo.id, it.id, cons[it.id]);
      mov.run({
        item: it.id, tipo: "entrega", pessoaDe: it.pessoa_id, pessoaPara: pessoa.id, localDe: it.local_id, localPara: local.id,
        statusDe: it.status, statusPara: "em_uso", termo: termo.id, importacao: null, usuario: usuario.id, quando,
        obs: it.pessoa_id === pessoa.id ? "regularização: item já constava com a pessoa, sem termo" : null,
      });
      upd.run(pessoa.id, local.id, cons[it.id], quando, it.id);
    }
    return { termo, itens: ids.length };
  })();
}

// Devolução: itens de UMA pessoa (quem assina). Sem transferência: voltam a
// em_estoque, sem pessoa, no local de destino (padrão: Estoque, 7º). Com
// `transferir` {pessoaId, localId, assinatura, assinanteNome}: a pessoa nova
// assina um termo de entrega e cada item ganha um movimento "transferencia".
function devolver(corpo, usuario) {
  const ids = idsDeItens(corpo.itemIds);
  const assinatura = validarAssinatura(corpo.assinatura);
  const quando = agora();
  const tr = corpo.transferir || null;
  let destinoLocal;
  if (tr) {
    destinoLocal = localValido(tr.localId);
  } else if (corpo.localId) {
    destinoLocal = localValido(corpo.localId);
  } else {
    destinoLocal = db.prepare("SELECT * FROM locais WHERE andar = 7 AND nome = 'Estoque' AND ativo = 1").get();
    if (!destinoLocal) throw erro("Escolha o local para onde os itens voltam.");
  }
  const novo = tr ? pessoaResponsavel(tr.pessoaId) : null;
  const assinaturaNovo = tr ? validarAssinatura(tr.assinatura) : null;
  return db.transaction(() => {
    const itens = ids.map((id) => buscarItem(id));
    const donos = new Set(itens.map((i) => i.pessoa_id));
    if (donos.has(null)) throw erro(`O item ${itens.find((i) => !i.pessoa_id).codigo} não está com ninguém.`, 409);
    if (donos.size > 1) throw erro("Uma devolução é de uma pessoa só: os itens selecionados estão com pessoas diferentes.", 409);
    const deId = itens[0].pessoa_id;
    const dePessoa = db.prepare("SELECT id, nome FROM pessoas WHERE id = ?").get(deId);
    if (novo && novo.id === deId) throw erro("A transferência precisa ir para outra pessoa.");
    const assinante = limpo(corpo.assinanteNome) || dePessoa.nome;
    const dev = criarTermo({ tipo: "devolucao", pessoaId: deId, localId: destinoLocal.id, assinatura, assinanteNome: assinante, observacao: limpo(corpo.observacao) }, usuario, quando);
    let ent = null;
    if (novo) {
      ent = criarTermo({ tipo: "entrega", pessoaId: novo.id, localId: destinoLocal.id, assinatura: assinaturaNovo,
        assinanteNome: limpo(tr.assinanteNome) || novo.nome, observacao: `transferência de ${dePessoa.nome} (termo de devolução ${dev.numero})`,
        relacionadoId: dev.id }, usuario, quando);
    }
    const fechar = db.prepare("UPDATE patrimonio_termo_itens SET aberto = 0, fechado_por_termo = ?, fechado_em = ? WHERE item_id = ? AND aberto = 1");
    const cons = conservacoesDoAto(corpo.conservacoes, ids, (id) => itens.find((i) => i.id === id).codigo);
    const insItem = db.prepare("INSERT INTO patrimonio_termo_itens (termo_id, item_id, aberto, conservacao) VALUES (?, ?, ?, ?)");
    const upd = db.prepare("UPDATE patrimonio_itens SET pessoa_id = ?, local_id = ?, status = ?, estado_conservacao = ?, atualizado_em = ? WHERE id = ?");
    const mov = insMov();
    for (const it of itens) {
      fechar.run(dev.id, quando, it.id);
      insItem.run(dev.id, it.id, 0, cons[it.id]);
      if (ent) {
        insItem.run(ent.id, it.id, 1, cons[it.id]); // quem recebe recebe no estado avaliado agora
        mov.run({
          item: it.id, tipo: "transferencia", pessoaDe: deId, pessoaPara: novo.id, localDe: it.local_id, localPara: destinoLocal.id,
          statusDe: it.status, statusPara: "em_uso", termo: ent.id, importacao: null, usuario: usuario.id, quando,
          obs: `devolução no termo ${dev.numero}, entrega no termo ${ent.numero}`,
        });
        upd.run(novo.id, destinoLocal.id, "em_uso", cons[it.id], quando, it.id);
      } else {
        mov.run({
          item: it.id, tipo: "devolucao", pessoaDe: deId, pessoaPara: null, localDe: it.local_id, localPara: destinoLocal.id,
          statusDe: it.status, statusPara: "em_estoque", termo: dev.id, importacao: null, usuario: usuario.id, quando, obs: null,
        });
        upd.run(null, destinoLocal.id, "em_estoque", cons[it.id], quando, it.id);
      }
    }
    return { devolucao: dev, entrega: ent, itens: ids.length };
  })();
}

// Cancelamento (só admin, com motivo). Termo de transferência (par devolução
// + entrega) é cancelado inteiro. Os itens voltam ao estado anterior, lido
// do próprio movimento do termo (pessoa_de/local_de/status_de), com um
// movimento "ajuste"; a entrega fechada pela devolução é reaberta.
function cancelarTermo(id, motivo, usuario) {
  if (usuario.papel !== "admin") throw erro("Só o administrador cancela um termo.", 403);
  const m = limpo(motivo);
  if (!m) throw erro("Informe o motivo do cancelamento.");
  const t = db.prepare("SELECT * FROM patrimonio_termos WHERE id = ?").get(Number(id));
  if (!t) throw erro("Termo não encontrado.", 404);
  if (t.cancelado_em) throw erro("Esse termo já foi cancelado.", 409);
  const par = t.relacionado_id
    ? db.prepare("SELECT * FROM patrimonio_termos WHERE id = ?").get(t.relacionado_id)
    : db.prepare("SELECT * FROM patrimonio_termos WHERE relacionado_id = ?").get(t.id);
  const entrega = t.tipo === "entrega" ? t : par?.tipo === "entrega" ? par : null;
  const devolucao = t.tipo === "devolucao" ? t : par?.tipo === "devolucao" ? par : null;
  const quando = agora();
  return db.transaction(() => {
    const itensDe = (termoId) => db.prepare("SELECT * FROM patrimonio_termo_itens WHERE termo_id = ?").all(termoId);
    const movDo = (termoId, itemId) => db.prepare("SELECT * FROM patrimonio_movimentos WHERE termo_id = ? AND item_id = ? ORDER BY id DESC LIMIT 1").get(termoId, itemId);
    const mov = insMov();
    const upd = db.prepare("UPDATE patrimonio_itens SET pessoa_id = ?, local_id = ?, status = ?, atualizado_em = ? WHERE id = ?");
    const fechar = db.prepare("UPDATE patrimonio_termo_itens SET aberto = 0, fechado_em = ? WHERE termo_id = ? AND item_id = ?");
    const reabrir = db.prepare("UPDATE patrimonio_termo_itens SET aberto = 1, fechado_por_termo = NULL, fechado_em = NULL WHERE fechado_por_termo = ? AND item_id = ?");
    const numeros = [entrega, devolucao].filter(Boolean).map((x) => numeroTermo(x.ano, x.seq)).join(" + ");
    // o movimento que define o estado anterior: a transferência (termo de entrega) ou a devolução/entrega simples
    const base = entrega && devolucao ? entrega : t;
    const linhas = itensDe(base.id);
    let n = 0;
    for (const li of linhas) {
      const it = buscarItem(li.item_id);
      if (base.tipo === "entrega" && !li.aberto) {
        throw erro(`O item ${it.codigo} já saiu deste termo (devolvido ou transferido depois): cancele o termo mais recente primeiro.`, 409);
      }
      const mv = movDo(base.id, li.item_id) || (devolucao ? movDo(devolucao.id, li.item_id) : null);
      if (!mv) throw erro(`Movimento do item ${it.codigo} não encontrado.`, 500);
      if (it.pessoa_id !== mv.pessoa_para || it.local_id !== mv.local_para || it.status !== mv.status_para) {
        throw erro(`O item ${it.codigo} mudou depois deste termo: cancele os movimentos mais recentes primeiro.`, 409);
      }
      if (base.tipo === "entrega") fechar.run(quando, base.id, li.item_id);
      if (devolucao) reabrir.run(devolucao.id, li.item_id);
      upd.run(mv.pessoa_de, mv.local_de, mv.status_de, quando, li.item_id);
      mov.run({
        item: li.item_id, tipo: "ajuste", pessoaDe: mv.pessoa_para, pessoaPara: mv.pessoa_de, localDe: mv.local_para, localPara: mv.local_de,
        statusDe: mv.status_para, statusPara: mv.status_de, termo: base.id, importacao: null, usuario: usuario.id, quando,
        obs: `cancelamento do termo ${numeros}: ${m}`,
      });
      n++;
    }
    const cancelar = db.prepare("UPDATE patrimonio_termos SET cancelado_em = ?, motivo_cancelamento = ?, cancelado_por = ? WHERE id = ?");
    for (const x of [entrega, devolucao].filter(Boolean)) cancelar.run(quando, m, usuario.id, x.id);
    return { cancelados: numeros, itens: n };
  })();
}

function listarTermos() {
  return db.prepare(
    `SELECT t.id, t.tipo, t.ano, t.seq, t.data_hora dataHora, p.nome pessoa, t.pessoa_id pessoaId,
            CASE WHEN l.id IS NULL THEN NULL ELSE l.andar || 'º · ' || l.nome END local,
            t.assinante_nome assinante, COALESCE(u.nome, u.login) coletadoPor, t.cancelado_em canceladoEm,
            t.motivo_cancelamento motivoCancelamento, t.relacionado_id relacionadoId,
            (SELECT COUNT(*) FROM patrimonio_termo_itens ti WHERE ti.termo_id = t.id) itens,
            (SELECT COUNT(*) FROM patrimonio_termo_itens ti WHERE ti.termo_id = t.id AND ti.aberto = 1) abertos,
            length(t.assinatura) bytesAssinatura
     FROM patrimonio_termos t JOIN pessoas p ON p.id = t.pessoa_id
     LEFT JOIN locais l ON l.id = t.local_id LEFT JOIN usuarios u ON u.id = t.usuario_id
     ORDER BY t.ano DESC, t.seq DESC`
  ).all().map((t) => ({ ...t, numero: numeroTermo(t.ano, t.seq) }));
}

// Quem pode ver a via: admin, patrimônio e a própria pessoa do termo
function termoParaVia(id, usuario) {
  const t = db.prepare(
    `SELECT t.*, p.nome pessoa, l.andar, l.nome local_nome, COALESCE(u.nome, u.login) coletado_por, r.ano r_ano, r.seq r_seq, r.tipo r_tipo
     FROM patrimonio_termos t JOIN pessoas p ON p.id = t.pessoa_id
     LEFT JOIN locais l ON l.id = t.local_id LEFT JOIN usuarios u ON u.id = t.usuario_id
     LEFT JOIN patrimonio_termos r ON r.id = COALESCE(t.relacionado_id, (SELECT x.id FROM patrimonio_termos x WHERE x.relacionado_id = t.id))
     WHERE t.id = ?`
  ).get(Number(id));
  const pode = t && (["admin", "patrimonio"].includes(usuario.papel) || (usuario.pessoa_id && usuario.pessoa_id === t.pessoa_id));
  if (!pode) throw erro("Termo não encontrado.", 404); // o mesmo 404 de inexistente
  const itens = db.prepare(
    `SELECT i.codigo, i.nome, i.marca_modelo marcaModelo, i.numero_serie numeroSerie, ti.conservacao,
            CASE WHEN ? = 'devolucao' THEN COALESCE(
              (SELECT e.conservacao FROM patrimonio_termo_itens e WHERE e.fechado_por_termo = ti.termo_id AND e.item_id = ti.item_id),
              (SELECT e.conservacao FROM patrimonio_termo_itens e JOIN patrimonio_termos te ON te.id = e.termo_id
                WHERE e.item_id = ti.item_id AND te.tipo = 'entrega' AND te.id < ti.termo_id AND te.cancelado_em IS NULL
                ORDER BY te.id DESC LIMIT 1)) END saiu
     FROM patrimonio_termo_itens ti JOIN patrimonio_itens i ON i.id = ti.item_id WHERE ti.termo_id = ? ORDER BY i.codigo`
  ).all(t.tipo, t.id);
  return { t, itens };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dataHoraBr = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} às ${s.slice(11, 16)}` : "");

// Na devolução, quando a conservação mudou desde a entrega: "saiu BOM, voltou REGULAR"
const MAIUSC = (v) => esc(String(v || "").toUpperCase());
function celulaConservacao(i) {
  if (!i.conservacao) return "—"; // termos anteriores à conservação obrigatória
  if (i.saiu && i.saiu !== i.conservacao) return `<span class="mudou">saiu ${MAIUSC(i.saiu)}, voltou ${MAIUSC(i.conservacao)}</span>`;
  return MAIUSC(i.conservacao);
}

function htmlVia(id, usuario) {
  const { t, itens } = termoParaVia(id, usuario);
  const numero = numeroTermo(t.ano, t.seq);
  const entrega = t.tipo === "entrega";
  const local = t.local_nome ? `${t.andar}º andar · ${t.local_nome}` : "—";
  // Textos aprovados pelo usuário em 18/11/2026 — não alterar sem nova aprovação.
  // Sem cláusula de ressarcimento, desconto em folha ou multa (decisão do usuário:
  // desconto por dano é regra do contrato de trabalho; o termo prova a guarda).
  const declaracao = entrega
    ? "Declaro que recebi da Unyflex, nesta data, os bens patrimoniais relacionados neste termo, nas condições de conservação indicadas ao lado de cada item, e me comprometo a utilizá-los exclusivamente nas atividades profissionais, zelar por sua guarda e conservação, não repassá-los a terceiros sem registro no controle de patrimônio, comunicar imediatamente qualquer dano, defeito, extravio ou furto, e devolvê-los quando solicitado ou no desligamento."
    : "Declaro que devolvi à Unyflex, nesta data, os bens patrimoniais relacionados neste termo, nas condições de conservação indicadas ao lado de cada item, que deixam de estar sob a minha responsabilidade a partir desta data.";
  const relacionado = t.r_ano ? `<p class="rel">Transferência: ${t.r_tipo === "entrega" ? "entrega" : "devolução"} no termo ${numeroTermo(t.r_ano, t.r_seq)}.</p>` : "";
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Termo ${esc(numero)} — ${entrega ? "entrega" : "devolução"} de patrimônio</title>
<style>
  *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#111;background:#fff;margin:0;padding:24px;font-size:13px;line-height:1.45}
  .folha{max-width:780px;margin:0 auto}
  header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #111;padding-bottom:10px;margin-bottom:16px;gap:12px;flex-wrap:wrap}
  .marca{font-size:24px;font-weight:800;letter-spacing:.5px}.marca small{display:block;font-size:12px;font-weight:400;color:#444}
  .num{text-align:right}.num strong{font-size:18px;display:block}
  h1{font-size:16px;text-transform:uppercase;margin:0 0 10px}
  .campos{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;margin:10px 0 14px}
  .campo span{display:block;font-size:11px;color:#555;text-transform:uppercase}.campo b{font-size:14px}
  .linha{border-bottom:1px solid #111;min-height:20px}
  table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #999;padding:5px 7px;text-align:left;vertical-align:top}
  th{background:#eee;font-size:11px;text-transform:uppercase}td.cod{font-family:monospace;font-size:14px;white-space:nowrap}td.cons{font-weight:700;white-space:nowrap}td.cons .mudou{white-space:normal}
  .assin{margin-top:24px;display:flex;gap:28px;flex-wrap:wrap;align-items:flex-end}
  .assin .bloco{flex:1;min-width:260px}.assin img{max-width:100%;height:110px;object-fit:contain;display:block;border-bottom:1px solid #111}
  .assin p{margin:4px 0 0;font-size:12px}
  .cancelado{border:3px solid #b00;color:#b00;font-weight:800;padding:8px 12px;margin-bottom:14px;text-transform:uppercase}
  .rel{font-size:12px;color:#333}
  footer{margin-top:28px;border-top:1px solid #999;padding-top:6px;font-size:11px;color:#555;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
  .acoes{max-width:780px;margin:0 auto 14px;display:flex;gap:8px}.acoes button{font-size:14px;padding:8px 14px;cursor:pointer}
  @media (max-width:560px){body{padding:12px}.campos{grid-template-columns:1fr}}
  @media print{.acoes{display:none}body{padding:0}@page{size:A4;margin:16mm}}
</style></head><body>
<div class="acoes"><button type="button" onclick="window.print()">🖨 Imprimir / salvar em PDF</button><button type="button" onclick="history.back()">Voltar</button></div>
<div class="folha">
  <header>
    <div class="marca">UNYFLEX<small>Controle de patrimônio</small></div>
    <div class="num">Termo de ${entrega ? "entrega" : "devolução"}<strong>Nº ${esc(numero)}</strong></div>
  </header>
  ${t.cancelado_em ? `<div class="cancelado">Termo cancelado em ${esc(dataHoraBr(t.cancelado_em))} — ${esc(t.motivo_cancelamento)}</div>` : ""}
  <h1>${entrega ? "Termo de responsabilidade e entrega de bens" : "Termo de devolução de bens"}</h1>
  <div class="campos">
    <div class="campo"><span>Nome</span><b>${esc(t.pessoa)}</b></div>
    <div class="campo"><span>CPF</span><div class="linha"></div></div>
    <div class="campo"><span>Local</span><b>${esc(local)}</b></div>
    <div class="campo"><span>Data e hora</span><b>${esc(dataHoraBr(t.data_hora))}</b></div>
  </div>
  <p>${declaracao}</p>
  ${relacionado}
  <table><thead><tr><th>Código</th><th>Item</th><th>Marca / modelo</th><th>Nº de série</th><th>Conservação</th></tr></thead><tbody>
  ${itens.map((i) => `<tr><td class="cod">${esc(i.codigo)}</td><td>${esc(i.nome)}</td><td>${esc(i.marcaModelo || "—")}</td><td>${esc(i.numeroSerie || "—")}</td><td class="cons">${celulaConservacao(i)}</td></tr>`).join("")}
  </tbody></table>
  <p>Total: <b>${itens.length}</b> ${itens.length === 1 ? "item" : "itens"}.${t.observacao ? ` Observação: ${esc(t.observacao)}` : ""}</p>
  <div class="assin">
    <div class="bloco"><img src="${t.assinatura}" alt="assinatura"><p><b>${esc(t.assinante_nome)}</b> — assinatura colhida em ${esc(dataHoraBr(t.data_hora))}</p></div>
    <div class="bloco"><p>Coletado por: <b>${esc(t.coletado_por)}</b></p></div>
  </div>
  <footer><span>Gerado por jonIAs — Assistente de Aulas</span><span>Termo ${esc(numero)}</span></footer>
</div></body></html>`;
}

// ---------- meus itens (corte no servidor: só a pessoa da sessão) ----------

function meusItens(usuario) {
  if (!usuario.pessoa_id) return { pessoa: null, itens: [] };
  const pessoa = db.prepare("SELECT id, nome FROM pessoas WHERE id = ?").get(usuario.pessoa_id);
  const itens = db.prepare(`${SQL_ITEM} WHERE i.pessoa_id = ? AND i.status <> 'baixado' ORDER BY i.codigo`).all(usuario.pessoa_id)
    .map((r) => ({
      codigo: r.codigo, nome: r.nome, marcaModelo: r.marca_modelo, local: r.local_id ? `${r.andar}º · ${r.local_nome}` : null,
      status: ROTULO_STATUS[r.status], entregueEm: r.termo_data || null,
      termo: r.termo_id ? { id: r.termo_id, numero: numeroTermo(r.termo_ano, r.termo_seq) } : null,
    }));
  return { pessoa, itens };
}

// ---------- importação da planilha (carga inicial) ----------

const desescapar = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const textoXml = (xml) => desescapar([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));
const colunaNum = (ref) => [...ref.replace(/\d/g, "")].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

// Leitura direta do XML (mesma técnica do planner: o exceljs falha em planilha
// com comentários de célula). Devolve as linhas de cada aba como arrays de texto.
async function lerAbas(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch (_) { throw erro("Arquivo ilegível — envie a planilha .xlsx do patrimônio.", 422); }
  const ler = async (p) => (zip.file(p) ? zip.file(p).async("string") : null);
  const wb = await ler("xl/workbook.xml");
  const rels = await ler("xl/_rels/workbook.xml.rels");
  if (!wb || !rels) throw erro("Não é um .xlsx válido.", 422);
  const alvos = Object.fromEntries([...rels.matchAll(/<Relationship ([^>]*?)\/?>/g)].map((m) => [(m[1].match(/Id="([^"]*)"/) || [])[1], (m[1].match(/Target="([^"]*)"/) || [])[1]]));
  const abas = [...wb.matchAll(/<sheet ([^>]*?)\/?>/g)].map((m) => ({ nome: desescapar((m[1].match(/name="([^"]*)"/) || [])[1] || ""), rid: (m[1].match(/r:id="([^"]*)"/) || [])[1] }));
  const ss = [...((await ler("xl/sharedStrings.xml")) || "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textoXml(m[1]));
  const saida = [];
  for (const aba of abas) {
    const alvo = alvos[aba.rid] || "";
    const xml = await ler(alvo.startsWith("/") ? alvo.slice(1) : `xl/${alvo.replace(/^\.?\//, "")}`);
    if (!xml) continue;
    const linhas = [];
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const num = Number((r[1].match(/\br="(\d+)"/) || [])[1]) || linhas.length + 1;
      const linha = [];
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = (c[1].match(/\br="([A-Z]+\d+)"/) || [])[1];
        if (!ref) continue;
        const tipo = (c[1].match(/\bt="(\w+)"/) || [])[1];
        const corpo = c[2] || "";
        let v = (corpo.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (tipo === "s") v = ss[Number(v)];
        else if (tipo === "inlineStr") v = textoXml(corpo);
        else if (v != null) v = desescapar(v);
        linha[colunaNum(ref)] = v ?? "";
      }
      linhas.push({ num, valores: Array.from(linha, (x) => (x == null ? "" : String(x).trim())) });
    }
    saida.push({ nome: aba.nome, linhas });
  }
  return saida;
}

const COLUNAS = {
  codigo: ["codigo novo"], nome: ["item"], marcaModelo: ["marca modelo", "marca"], numeroSerie: ["n de serie", "no de serie", "numero de serie", "serie"],
  andar: ["andar"], sala: ["sala"], responsavel: ["responsavel"], status: ["status"], conservacao: ["conservacao", "estado de conservacao"],
  codigoAntigo: ["codigo antigo"], postoAntigo: ["posto na planilha antiga"], origem: ["origem"], observacao: ["observacoes", "observacao"],
};
function mapaDeColunas(cabecalho) {
  const mapa = {};
  const extras = [];
  const descartadas = [];
  cabecalho.forEach((rotulo, i) => {
    const n = norm(rotulo).replace(/\bnº\b/g, "n");
    if (!n) return;
    if (n.includes("senha")) { descartadas.push(rotulo); return; } // nunca vai ao banco
    // o rótulo pode ter uma 2ª linha explicativa: "RESPONSÁVEL\n(atribuir no jonIAs)" → começa com o sinônimo
    const casa = (sin) => n === sin || n.startsWith(sin + " ");
    const campo = Object.entries(COLUNAS).find(([k, sins]) => mapa[k] === undefined && sins.some(casa));
    if (campo) mapa[campo[0]] = i;
    else extras.push({ i, rotulo });
  });
  return { mapa, extras, descartadas };
}

const STATUS_PLANILHA = {
  "em uso": "em_uso", "uso": "em_uso", "em estoque": "em_estoque", "estoque": "em_estoque", "sem uso": "em_estoque",
  "sem uso estoque": "em_estoque", "em reparo": "em_reparo", "reparo": "em_reparo", "manutencao": "em_reparo",
  "em manutencao": "em_reparo", "baixado": "baixado", "baixa": "baixado", "descartado": "baixado",
};

async function importar(buffer, arquivo, usuarioId) {
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const iniciado = new Date().toISOString();
  const repetido = db.prepare("SELECT id, iniciado_em FROM importacoes WHERE tipo = 'patrimonio' AND hash_sha256 = ? AND status = 'concluida' ORDER BY id DESC LIMIT 1").get(hash);
  const abas = await lerAbas(buffer);
  // a aba é a que tem a coluna CÓDIGO NOVO nas 5 primeiras linhas
  let aba = null, cab = null;
  for (const a of abas) {
    const i = a.linhas.slice(0, 5).findIndex((l) => l.valores.some((v) => norm(v) === "codigo novo"));
    if (i >= 0) { aba = a; cab = i; break; }
  }
  if (!aba) throw erro("Não achei a coluna CÓDIGO NOVO nas 5 primeiras linhas de nenhuma aba.", 422);
  const { mapa, extras, descartadas } = mapaDeColunas(aba.linhas[cab].valores);
  const faltando = ["codigo", "nome"].filter((k) => mapa[k] === undefined);
  if (faltando.length) throw erro(`Colunas obrigatórias ausentes: ${faltando.join(", ")}.`, 422);

  const pessoas = new Map();
  for (const p of responsaveis()) pessoas.set(norm(p.nome), p);
  const locais = db.prepare("SELECT * FROM locais WHERE ativo = 1").all();
  const valor = (l, k) => (mapa[k] === undefined ? "" : l.valores[mapa[k]] ?? "");

  const ignoradas = [], ressalvas = [], avisos = [];
  const vistos = new Map();
  const validas = [];
  let lidas = 0;
  for (const l of aba.linhas.slice(cab + 1)) {
    if (!l.valores.some((v) => v !== "")) continue;
    lidas++;
    const codigoBruto = valor(l, "codigo");
    const nome = valor(l, "nome");
    const statusTxt = norm(valor(l, "status"));
    if (statusTxt === "consumo") { ignoradas.push({ linha: l.num, codigo: codigoBruto, item: nome, motivo: "STATUS = CONSUMO (estoque de consumo — Fase 2)" }); continue; }
    // "0001" (texto) ou 1 (número no Excel, às vezes "1.0"): até 4 dígitos, nada além
    const m = codigoBruto.match(/^(\d{1,4})(?:\.0+)?$/);
    if (!m || Number(m[1]) === 0) {
      ignoradas.push({ linha: l.num, codigo: codigoBruto, item: nome, motivo: "CÓDIGO NOVO vazio ou inválido (4 dígitos)" }); continue;
    }
    const codigo = m[1].padStart(4, "0");
    if (!nome) { ignoradas.push({ linha: l.num, codigo, item: "", motivo: "ITEM vazio" }); continue; }
    if (vistos.has(codigo)) { ignoradas.push({ linha: l.num, codigo, item: nome, motivo: `código repetido no arquivo (já na linha ${vistos.get(codigo)})` }); continue; }
    vistos.set(codigo, l.num);

    let status = STATUS_PLANILHA[statusTxt];
    const respTxt = valor(l, "responsavel");
    const pessoa = respTxt ? pessoas.get(norm(respTxt)) || null : null;
    if (respTxt && !pessoa) ressalvas.push({ linha: l.num, codigo, tipo: "responsavel", valor: respTxt, msg: `responsável "${respTxt}" não é pessoa cadastrada (consultor/administrativo) — vínculo não importado` });
    const andarTxt = valor(l, "andar");
    const andar = Number((andarTxt.match(/\d+/) || [])[0]) || null;
    const salaTxt = valor(l, "sala");
    let local = null;
    if (salaTxt) {
      const cands = locais.filter((x) => norm(x.nome) === norm(salaTxt) && (andar === null || x.andar === andar));
      if (cands.length === 1) local = cands[0];
      else ressalvas.push({ linha: l.num, codigo, tipo: "sala", valor: `${andarTxt} ${salaTxt}`.trim(), msg: cands.length ? `sala "${salaTxt}" existe em mais de um andar — informe o andar` : `sala "${salaTxt}"${andar ? ` (${andar}º)` : ""} não está no cadastro de locais — local não importado` });
    }
    if (!status) {
      if (statusTxt) ressalvas.push({ linha: l.num, codigo, tipo: "status", valor: valor(l, "status"), msg: `STATUS "${valor(l, "status")}" desconhecido — ${pessoa ? "em uso (tem responsável)" : "em estoque"}` });
      status = pessoa ? "em_uso" : "em_estoque";
    }
    const consTxt = norm(valor(l, "conservacao"));
    const conservacao = { bom: "bom", boa: "bom", regular: "regular", ruim: "ruim" }[consTxt] || null;
    if (consTxt && !conservacao) ressalvas.push({ linha: l.num, codigo, tipo: "conservacao", valor: valor(l, "conservacao"), msg: `CONSERVAÇÃO "${valor(l, "conservacao")}" fora de bom/regular/ruim — deixada em branco` });
    const ext = {};
    for (const e of extras) if (l.valores[e.i]) ext[e.rotulo] = l.valores[e.i];
    if (valor(l, "postoAntigo")) ext["POSTO NA PLANILHA ANTIGA"] = valor(l, "postoAntigo");
    let obs = limpo(valor(l, "observacao"));
    if (obs && /senha/i.test(obs)) { ressalvas.push({ linha: l.num, codigo, tipo: "senha", msg: "OBSERVAÇÕES menciona senha — observação NÃO importada" }); obs = null; }
    validas.push({
      linha: l.num, codigo, nome, marca_modelo: limpo(valor(l, "marcaModelo")), numero_serie: limpo(valor(l, "numeroSerie")),
      estado_conservacao: conservacao, status, local_id: local?.id ?? null, pessoa_id: pessoa?.id ?? null,
      observacao: obs, codigo_antigo: limpo(valor(l, "codigoAntigo")), origem: limpo(valor(l, "origem")),
      extras_json: Object.keys(ext).length ? JSON.stringify(ext) : null,
    });
  }
  if (descartadas.length) avisos.push(`Coluna(s) descartada(s) por política (senha nunca entra no banco): ${descartadas.join(", ")}`);
  if (repetido) avisos.push(`Este mesmo arquivo já foi importado em ${repetido.iniciado_em} (importação #${repetido.id}).`);

  const quando = agora();
  let novos = 0, atualizados = 0, identicos = 0;
  const mantidos = [];
  const impId = db.transaction(() => {
    const id = Number(db.prepare("INSERT INTO importacoes (tipo, arquivo_nome, hash_sha256, usuario_id, iniciado_em) VALUES ('patrimonio', ?, ?, ?, ?)")
      .run(arquivo, hash, usuarioId, iniciado).lastInsertRowid);
    const buscar = db.prepare("SELECT * FROM patrimonio_itens WHERE codigo = ?");
    const trabalhado = db.prepare("SELECT 1 FROM patrimonio_movimentos WHERE item_id = ? AND importacao_id IS NULL LIMIT 1");
    const temTermo = db.prepare("SELECT 1 FROM patrimonio_termo_itens WHERE item_id = ? LIMIT 1");
    const mov = insMov();
    const DESC = ["nome", "marca_modelo", "numero_serie", "estado_conservacao", "observacao", "codigo_antigo", "origem", "extras_json"];
    const ESTADO = ["pessoa_id", "local_id", "status"];
    for (const v of validas) {
      const atual = buscar.get(v.codigo);
      if (!atual) {
        const info = db.prepare(
          `INSERT INTO patrimonio_itens (codigo, nome, marca_modelo, numero_serie, estado_conservacao, status, local_id, pessoa_id,
             observacao, codigo_antigo, origem, extras_json, importacao_id, criado_em, atualizado_em)
           VALUES (@codigo, @nome, @marca_modelo, @numero_serie, @estado_conservacao, @status, @local_id, @pessoa_id,
             @observacao, @codigo_antigo, @origem, @extras_json, @imp, @quando, @quando)`
        ).run({ ...v, imp: id, quando });
        mov.run({
          item: Number(info.lastInsertRowid), tipo: "ajuste", pessoaDe: null, pessoaPara: v.pessoa_id, localDe: null, localPara: v.local_id,
          statusDe: null, statusPara: v.status, termo: null, importacao: id, usuario: usuarioId, quando, obs: "carga inicial",
        });
        novos++;
        continue;
      }
      const mudDesc = DESC.filter((c) => (atual[c] ?? null) !== (v[c] ?? null));
      const mudEstado = ESTADO.filter((c) => (atual[c] ?? null) !== (v[c] ?? null));
      const podeEstado = !trabalhado.get(atual.id) && !temTermo.get(atual.id);
      const aplicar = [...mudDesc, ...(podeEstado ? mudEstado : [])];
      if (mudEstado.length && !podeEstado) {
        mantidos.push({ linha: v.linha, codigo: v.codigo, campos: mudEstado.map((c) => ({ campo: c, sistema: atual[c], planilha: v[c] })) });
      }
      if (!aplicar.length) { identicos++; continue; }
      db.prepare(`UPDATE patrimonio_itens SET ${aplicar.map((c) => `${c} = @${c}`).join(", ")}, atualizado_em = @quando WHERE id = @id`)
        .run({ ...Object.fromEntries(aplicar.map((c) => [c, v[c]])), quando, id: atual.id });
      if (podeEstado && mudEstado.length) {
        mov.run({
          item: atual.id, tipo: "ajuste", pessoaDe: atual.pessoa_id, pessoaPara: v.pessoa_id, localDe: atual.local_id, localPara: v.local_id,
          statusDe: atual.status, statusPara: v.status, termo: null, importacao: id, usuario: usuarioId, quando,
          obs: `reimportação da planilha (${mudEstado.join(", ")})`,
        });
      }
      atualizados++;
    }
    if (mantidos.length) avisos.push(`${mantidos.length} item(ns) já trabalhado(s) no sistema: responsável/local/status da planilha NÃO aplicados (lista em "mantidos").`);
    const detalhes = {
      aba: aba.nome, linhaCabecalho: aba.linhas[cab].num, colunas: Object.fromEntries(Object.entries(mapa).map(([k, i]) => [k, aba.linhas[cab].valores[i]])),
      colunasExtras: extras.map((e) => e.rotulo), colunasDescartadas: descartadas, ignoradas, ressalvas, mantidos, avisos,
      porMotivo: ignoradas.reduce((a, x) => ((a[x.motivo] = (a[x.motivo] || 0) + 1), a), {}),
    };
    db.prepare(
      `UPDATE importacoes SET linhas_lidas = ?, linhas_validas = ?, linhas_ignoradas = ?, registros_novos = ?, registros_atualizados = ?,
         registros_identicos = ?, detalhes_json = ?, status = 'concluida', concluido_em = ? WHERE id = ?`
    ).run(lidas, validas.length, ignoradas.length, novos, atualizados, identicos, JSON.stringify(detalhes), new Date().toISOString(), id);
    return id;
  })();
  return {
    importacaoId: impId, arquivo, aba: aba.nome, linhasLidas: lidas, importadas: validas.length, ignoradas, ressalvas, mantidos, avisos,
    novos, atualizados, identicos, colunasExtras: extras.map((e) => e.rotulo), colunasDescartadas: descartadas,
  };
}

function ultimasImportacoes() {
  return db.prepare(
    `SELECT i.id, i.arquivo_nome arquivo, i.iniciado_em iniciadoEm, i.linhas_lidas lidas, i.linhas_validas validas, i.linhas_ignoradas ignoradas,
            i.registros_novos novos, i.registros_atualizados atualizados, i.registros_identicos identicos, i.status, i.erro,
            COALESCE(u.nome, u.login) usuario
     FROM importacoes i LEFT JOIN usuarios u ON u.id = i.usuario_id WHERE i.tipo = 'patrimonio' ORDER BY i.id DESC LIMIT 10`
  ).all();
}
function detalheImportacao(id) {
  const r = db.prepare("SELECT * FROM importacoes WHERE id = ? AND tipo = 'patrimonio'").get(Number(id));
  if (!r) throw erro("Importação não encontrada.", 404);
  return { ...r, detalhes: JSON.parse(r.detalhes_json || "{}"), detalhes_json: undefined };
}

// ---------- gerencial e TV (2026-11-18, decisões do usuário) ----------
//
// "Completo" depende do status do item (baixado fica fora da conta):
//   em uso     → responsável + local + conservação + termo de entrega aberto
//   em estoque → local + conservação (estoque não tem responsável nem termo)
//   em reparo  → conservação (o item está fora; o alerta de 15 dias cuida dele)
// Os buracos usam a MESMA regra: sem responsável e sem assinatura = itens em
// uso; sem local = em uso ou em estoque; sem conservação = qualquer não baixado.
// O percentual é arredondado PARA BAIXO: 100% só com todos completos — a TV
// diz "INVENTÁRIO COMPLETO" só com a barra cheia (nunca ao lado de 99,6%).

const hojeLocal = () => agora().slice(0, 10);

function itensBrutos() {
  return db.prepare(`${SQL_ITEM} ORDER BY l.andar, l.ordem, l.nome, i.codigo`).all();
}

function faltasDoItem(r) {
  const f = { pessoa: false, local: false, conservacao: false, termo: false };
  if (r.status === "baixado") return null;
  if (!r.estado_conservacao) f.conservacao = true;
  if ((r.status === "em_uso" || r.status === "em_estoque") && !r.local_id) f.local = true;
  if (r.status === "em_uso") {
    if (!r.pessoa_id) f.pessoa = true;
    if (!r.termo_id) f.termo = true;
  }
  return f;
}

function contarInventario(rows = itensBrutos()) {
  const c = { total: 0, completos: 0, semResponsavel: 0, semLocal: 0, semConservacao: 0, semAssinatura: 0 };
  for (const r of rows) {
    const f = faltasDoItem(r);
    if (!f) continue;
    c.total++;
    if (f.pessoa) c.semResponsavel++;
    if (f.local) c.semLocal++;
    if (f.conservacao) c.semConservacao++;
    if (f.termo) c.semAssinatura++;
    if (!f.pessoa && !f.local && !f.conservacao && !f.termo) c.completos++;
  }
  c.pct = c.total ? Math.floor((c.completos * 100) / c.total) : 0;
  c.completo = c.total > 0 && c.completos === c.total;
  return c;
}

const itemDoRoteiro = (r) => ({
  id: r.id, codigo: r.codigo, nome: r.nome, marcaModelo: r.marca_modelo, numeroSerie: r.numero_serie,
  local: r.local_id ? `${r.andar}º · ${r.local_nome}` : null, conservacao: r.estado_conservacao,
});

// Roteiro de coleta: itens EM USO sem termo assinado.
// - porPessoa: com responsável (veio da carga), agrupado por pessoa, itens na
//   ordem do prédio (andar, sala) — a Emanuelle colhe a assinatura.
// - descobrir: SEM responsável, agrupado por andar e sala ("descobrir quem
//   usa") — no primeiro dia é o único ponto de partida (168 itens).
function roteiroDeColeta(rows = itensBrutos()) {
  const semTermo = rows.filter((r) => r.status === "em_uso" && !r.termo_id);
  const pessoas = new Map();
  for (const r of semTermo.filter((x) => x.pessoa_id)) {
    if (!pessoas.has(r.pessoa_id)) pessoas.set(r.pessoa_id, { pessoaId: r.pessoa_id, pessoa: r.pessoa_nome, itens: [] });
    pessoas.get(r.pessoa_id).itens.push(itemDoRoteiro(r));
  }
  const salas = new Map();
  for (const r of semTermo.filter((x) => !x.pessoa_id)) {
    const chave = r.local_id || 0;
    if (!salas.has(chave)) salas.set(chave, { localId: r.local_id || null, andar: r.andar ?? null, local: r.local_id ? `${r.andar}º · ${r.local_nome}` : null, itens: [] });
    salas.get(chave).itens.push(itemDoRoteiro(r));
  }
  const descobrir = [...salas.values()].sort((a, b) => (a.localId ? 0 : 1) - (b.localId ? 0 : 1)); // sem local por último (rows já vêm na ordem do prédio)
  return {
    total: semTermo.length,
    porPessoa: [...pessoas.values()].sort((a, b) => a.pessoa.localeCompare(b.pessoa, "pt-BR")),
    descobrir,
  };
}

const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function termosDoMes(mes) {
  const m = mes && MES_RE.test(mes) ? mes : hojeLocal().slice(0, 7);
  const r = db.prepare(
    `SELECT
       SUM(tipo = 'entrega') entregas,
       SUM(tipo = 'devolucao') devolucoes,
       SUM(tipo = 'entrega' AND relacionado_id IS NOT NULL) transferencias,
       COUNT(*) emitidos
     FROM patrimonio_termos WHERE substr(data_hora, 1, 7) = ?`
  ).get(m);
  const cancelados = db.prepare("SELECT COUNT(*) n FROM patrimonio_termos WHERE substr(cancelado_em, 1, 7) = ?").get(m).n;
  return {
    mes: m, emitidos: r.emitidos || 0, cancelados,
    // transferência = um par (devolução + entrega); entregas/devoluções "simples" sem o par
    entregas: (r.entregas || 0) - (r.transferencias || 0), devolucoes: (r.devolucoes || 0) - (r.transferencias || 0),
    transferencias: r.transferencias || 0,
  };
}

const REPARO_DIAS = 15;
function emReparoLongo() {
  return db.prepare(
    `SELECT i.id, i.codigo, i.nome, p.nome pessoa, m.data_hora desde, m.observacao motivo,
            CAST(julianday(?) - julianday(substr(m.data_hora, 1, 10)) AS INTEGER) dias
     FROM patrimonio_itens i
     JOIN patrimonio_movimentos m ON m.id = (SELECT MAX(id) FROM patrimonio_movimentos WHERE item_id = i.id AND tipo = 'reparo_saida')
     LEFT JOIN pessoas p ON p.id = i.pessoa_id
     WHERE i.status = 'em_reparo'
     ORDER BY m.data_hora`
  ).all(hojeLocal()).filter((x) => x.dias > REPARO_DIAS);
}

function gerencial({ mes } = {}) {
  const rows = itensBrutos();
  const porStatus = Object.fromEntries(STATUS.map((s) => [s, rows.filter((r) => r.status === s).length]));
  const ativos = rows.filter((r) => r.status !== "baixado");
  const porLocal = listarLocais()
    .filter((l) => l.ativo || l.itens)
    .map((l) => {
      const doLocal = ativos.filter((r) => r.local_id === l.id);
      return { id: l.id, andar: l.andar, nome: l.nome, ativo: l.ativo, itens: doLocal.length,
        emUso: doLocal.filter((r) => r.status === "em_uso").length, emEstoque: doLocal.filter((r) => r.status === "em_estoque").length,
        zerado: Boolean(l.ativo && !doLocal.length) };
    });
  const pessoas = new Map();
  for (const r of ativos.filter((x) => x.pessoa_id)) {
    if (!pessoas.has(r.pessoa_id)) pessoas.set(r.pessoa_id, { pessoaId: r.pessoa_id, pessoa: r.pessoa_nome, itens: 0, emUso: 0, semTermo: 0 });
    const p = pessoas.get(r.pessoa_id);
    p.itens++;
    if (r.status === "em_uso") p.emUso++;
    if (r.status === "em_uso" && !r.termo_id) p.semTermo++;
  }
  return {
    hoje: hojeLocal(),
    porStatus,
    inventario: contarInventario(rows),
    roteiro: roteiroDeColeta(rows),
    porLocal,
    semLocal: ativos.filter((r) => !r.local_id).length,
    porResponsavel: [...pessoas.values()].sort((a, b) => b.itens - a.itens || a.pessoa.localeCompare(b.pessoa, "pt-BR")),
    reparoLongo: emReparoLongo(),
    reparoDias: REPARO_DIAS,
    termosDoMes: termosDoMes(mes),
    tv: tvLigada(),
  };
}

// Roteiro de coleta para imprimir (HTML com @media print, no padrão da via)
function htmlRoteiro() {
  const r = roteiroDeColeta();
  // última coluna: o local (colher a assinatura) ou uma linha em branco para anotar quem usa
  const tabela = (itens, quemUsa) => `<table><thead><tr><th class="ck"></th><th>Código</th><th>Item</th><th>Marca / modelo</th><th>Nº de série</th><th>${quemUsa ? "Quem usa" : "Local"}</th></tr></thead><tbody>${
    itens.map((i) => `<tr><td class="ck">☐</td><td class="cod">${esc(i.codigo)}</td><td>${esc(i.nome)}</td><td>${esc(i.marcaModelo || "—")}</td><td>${esc(i.numeroSerie || "—")}</td>${
      quemUsa ? '<td class="linha"></td>' : `<td>${esc(i.local || "sem local")}</td>`}</tr>`).join("")}</tbody></table>`;
  const blocoPessoas = r.porPessoa.map((p) => `<section><h3>${esc(p.pessoa)} <small>${p.itens.length} item(ns) — colher a assinatura</small></h3>${tabela(p.itens, false)}</section>`).join("")
    || `<p class="vazio">Nenhum item com responsável esperando assinatura.</p>`;
  const blocoDescobrir = r.descobrir.map((s) => `<section><h3>${esc(s.local || "Sem local")} <small>${s.itens.length} item(ns) — quem usa?</small></h3>${tabela(s.itens, true)}</section>`).join("")
    || `<p class="vazio">Nenhum item em uso sem responsável.</p>`;
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roteiro de coleta — patrimônio</title>
<style>
  *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#111;background:#fff;margin:0;padding:24px;font-size:12px;line-height:1.4}
  .folha{max-width:900px;margin:0 auto}
  header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #111;padding-bottom:8px;margin-bottom:14px;gap:12px;flex-wrap:wrap}
  .marca{font-size:22px;font-weight:800}.marca small{display:block;font-size:12px;font-weight:400;color:#444}
  h2{font-size:15px;text-transform:uppercase;margin:18px 0 6px;border-bottom:1px solid #999;padding-bottom:3px}
  h3{font-size:13px;margin:12px 0 4px}h3 small{font-weight:400;color:#555}
  section{break-inside:avoid}
  table{width:100%;border-collapse:collapse;margin:4px 0 8px}th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top}
  th{background:#eee;font-size:10px;text-transform:uppercase}td.cod{font-family:monospace;font-size:13px;white-space:nowrap}
  .ck{width:22px;text-align:center;font-size:14px}td.linha{min-width:160px}
  .resumo{font-size:13px}.vazio{color:#555;font-style:italic}
  footer{margin-top:24px;border-top:1px solid #999;padding-top:6px;font-size:11px;color:#555;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
  .acoes{max-width:900px;margin:0 auto 14px;display:flex;gap:8px}.acoes button{font-size:14px;padding:8px 14px;cursor:pointer}
  @media screen and (max-width:560px){body{padding:10px}th:nth-child(4),td:nth-child(4),th:nth-child(5),td:nth-child(5){display:none}td.linha{min-width:90px}td{word-break:break-word}}
  @media print{.acoes{display:none}body{padding:0}@page{size:A4;margin:12mm}}
</style></head><body>
<div class="acoes"><button type="button" onclick="window.print()">🖨 Imprimir / salvar em PDF</button><button type="button" onclick="history.back()">Voltar</button></div>
<div class="folha">
  <header><div class="marca">UNYFLEX<small>Controle de patrimônio — roteiro de coleta</small></div><div>Gerado em ${esc(dataHoraBr(agora()))}</div></header>
  <p class="resumo"><b>${r.total}</b> item(ns) em uso sem termo assinado: <b>${r.porPessoa.reduce((n, p) => n + p.itens.length, 0)}</b> com responsável (colher a assinatura) e <b>${r.descobrir.reduce((n, s) => n + s.itens.length, 0)}</b> sem responsável (descobrir quem usa).</p>
  <h2>Colher a assinatura — por pessoa</h2>${blocoPessoas}
  <h2>Descobrir quem usa — por andar e sala</h2>${blocoDescobrir}
  <footer><span>Gerado por jonIAs — Assistente de Aulas</span><span>Roteiro de coleta</span></footer>
</div></body></html>`;
}

// Interruptor da tela na TV (admin, na aba Gerencial): nasce DESLIGADO
// (`configuracoes.patrimonio_tv`); desligado, o payload público da TV não leva
// nada do patrimônio. A tela só tem NÚMEROS — nenhum nome, código, sala ou
// descrição vai para a sala (contagem por pessoa fica na aba Gerencial).
const tvLigada = () => db.prepare("SELECT valor FROM configuracoes WHERE chave = 'patrimonio_tv'").get()?.valor === "1";
function definirTv(ativo) {
  db.prepare("INSERT INTO configuracoes (chave, valor) VALUES ('patrimonio_tv', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor").run(ativo ? "1" : "0");
  return { ativo: tvLigada() };
}
function painelTvPatrimonio({ previa = false } = {}) {
  if (!tvLigada() && !previa) return { ativo: false };
  const c = contarInventario();
  return {
    ativo: true, previa: !tvLigada(),
    semResponsavel: c.semResponsavel, semLocal: c.semLocal, semAssinatura: c.semAssinatura,
    completos: c.completos, total: c.total, pct: c.pct, completo: c.completo,
  };
}

// Tudo o que a tela /patrimonio precisa numa chamada
function payload(usuario) {
  return {
    itens: listarItens(), locais: listarLocais(), responsaveis: responsaveis(), termos: listarTermos(),
    importacoes: ultimasImportacoes(), admin: usuario.papel === "admin",
  };
}

module.exports = {
  STATUS, ESTADOS, payload, listarItens, listarLocais, criarLocal, editarLocal, responsaveis,
  atualizarItem, mudarStatus, historicoDoItem, entregar, devolver, cancelarTermo, listarTermos,
  htmlVia, meusItens, importar, ultimasImportacoes, detalheImportacao, validarAssinatura,
  gerencial, htmlRoteiro, contarInventario, tvLigada, definirTv, painelTvPatrimonio,
};
