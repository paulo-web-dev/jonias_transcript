"use strict";

// /prospeccao — aba ROTA (rota.js no servidor, migração 28). A lista do dia
// usa a MESMA tabela da aba Trabalho (js/prospeccao.js, "modo rota"): edição,
// status, marcação, registro de contato e gaveta funcionam igual, sobre a
// mesma base. Aqui ficam só o que é da rota: cabeçalho com progresso, coluna
// de baixa e, para o admin, o painel da campanha (setor vigente, estoque,
// progresso do dia e acumulado, FILA de setores, tipos de rota).

const rotaUi = { admin: false, data: "", pessoa: "", dados: null, painel: null, tipos: null, setores: null, editandoTipo: null, confirmarTroca: false,
  fila: null, filaAlterada: false };

const diaSemana = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" }).replace(".", "");
const rotuloDia = (iso, hoje) => {
  if (!iso) return "";
  const base = `${diaSemana(iso)} ${dataBr(iso)}`;
  return iso === hoje ? `hoje · ${base}` : iso > hoje ? `${base} (próxima)` : base;
};
const umaCasa = (n) => (Math.round(n * 10) / 10).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const horaDe = (iso) => (iso ? String(iso).slice(11, 16) : "");

// ---------- ganchos usados por js/prospeccao.js ----------

function colunasDaRota(base) {
  const i = base.findIndex((c) => c.campo === "municipioNome");
  return [...base.slice(0, i + 1), { campo: "rotaBaixa", render: renderBaixa },
    { campo: "rotaTipo", render: (o) => (o.rotaTipo ? `<span class="rota-tipo-chip" title="setor da fila de onde veio esta linha">${escapeHtml(o.rotaTipo)}</span>` : "") },
    ...base.slice(i + 1)];
}

// Coluna "Baixa" no cabeçalho e no colgroup (entra depois do município, fora das fixas)
function ajustarCabecalhoRota(ativo) {
  const tr = document.querySelector("#trab-tabela thead tr");
  const cg = document.querySelector("#trab-tabela colgroup");
  document.querySelectorAll("#trab-tabela .so-rota").forEach((e) => e.remove());
  if (!ativo) return;
  const th = document.createElement("th");
  th.className = "so-rota";
  th.dataset.ordem = "rotaBaixaOrdem";
  th.title = "baixa: ligação do PABX (CDR) ou registro manual";
  th.textContent = "Baixa";
  tr.children[2].after(th);
  const thTipo = document.createElement("th");
  thTipo.className = "so-rota";
  thTipo.dataset.ordem = "rotaTipo";
  thTipo.title = "setor da fila de onde veio a linha (a rota completa a cota com o próximo setor da fila)";
  thTipo.textContent = "Setor da fila";
  th.after(thTipo);
  const col = document.createElement("col");
  col.className = "c-baixa so-rota";
  cg.children[2].after(col);
  const colTipo = document.createElement("col");
  colTipo.className = "c-rota-tipo so-rota";
  col.after(colTipo);
}

function serializarRota() {
  const q = new URLSearchParams();
  if (rotaUi.data) q.set("data", rotaUi.data);
  if (rotaUi.admin && rotaUi.pessoa) q.set("pessoa", rotaUi.pessoa);
  return q.toString();
}
function lerHashRota(q) {
  rotaUi.data = /^\d{4}-\d{2}-\d{2}$/.test(q.get("data") || "") ? q.get("data") : "";
  rotaUi.pessoa = q.get("pessoa") || "";
}

// Registro de contato a partir da rota: a data padrão é o dia da rota quando ela é
// de um dia passado (é a data do registro que dá a baixa naquela rota)
function dataRegistroRota() {
  const d = rotaUi.dados?.rota?.data;
  const hoje = rotaUi.dados?.hoje || hojeIso();
  return d && d < hoje ? d : hoje;
}

function renderBaixa(o) {
  const it = o.rotaItem;
  if (!it) return "";
  if (it.baixaMetodo === "cdr") {
    const conversa = it.atendida && it.conversaSeg ? ` · ${Math.max(1, Math.round(it.conversaSeg / 60))} min` : "";
    const falha = !it.atendida && it.eventoFalha ? ` (${it.eventoFalha.toLowerCase()})` : "";
    return `<span class="rota-baixa ${it.atendida ? "rota-ok" : "rota-nao"}" title="ligação do PABX às ${horaDe(it.ligacaoEm)}${falha}">📟 ${horaDe(it.ligacaoEm)} ${it.atendida ? "atendida" : "não atend."}${conversa}</span>`;
  }
  if (it.baixaMetodo === "manual") {
    const pabx = it.ligacaoEm ? ` · 📟 ${it.atendida ? "atendida" : "não atend."}` : "";
    return `<span class="rota-baixa rota-ok" title="registro manual${it.baixaPor ? ` por ${escapeHtml(it.baixaPor)}` : ""} em ${escapeHtml(dataHoraBr(it.baixaEm))}">✍ manual${pabx}</span>` +
      `<button type="button" class="trab-btn rota-desfazer" data-acao="desfazer-baixa" title="desfazer a baixa manual (o registro no histórico fica)">↺</button>`;
  }
  const futura = rotaUi.dados?.rota && rotaUi.dados.rota.data > rotaUi.dados.hoje;
  return futura
    ? `<span class="texto-suave">—</span>`
    : `<button type="button" class="btn-mini rota-btn-baixa" data-acao="registrar" title="registrar contato = baixa manual (tecla R)">dar baixa</button>`;
}

function atualizarProgressoRota() {
  const r = rotaUi.dados?.rota;
  const numeros = document.getElementById("rota-numeros");
  const feitas = document.getElementById("rota-barra-feitas"), atendidas = document.getElementById("rota-barra-atendidas");
  if (!r) { numeros.textContent = ""; feitas.style.width = "0"; atendidas.style.width = "0"; return; }
  const p = progressoLocal(r);
  const base = Math.max(p.cota, p.itens) || 1;
  feitas.style.width = `${(p.feitas / base) * 100}%`;
  atendidas.style.width = `${(p.atendidas / base) * 100}%`;
  numeros.innerHTML = `<strong>${inteiro(p.feitas)}</strong> de ${inteiro(p.itens)} feitas` +
    (p.itens < p.cota ? ` <span class="pct-meio">(rota curta: ${inteiro(p.itens)} de ${inteiro(p.cota)})</span>` : "") +
    ` · <span class="rota-ok">${inteiro(p.atendidas)} atendidas</span> · ${inteiro(p.pelaCdr)} pelo PABX · ${inteiro(p.manuais)} manuais · ${inteiro(p.pendentes)} pendentes`;
}

// O progresso sai dos itens em memória (a baixa manual atualiza na hora)
function progressoLocal(r) {
  const itens = r.itens;
  const feitas = itens.filter((i) => i.baixaMetodo).length;
  return { cota: r.cota, itens: itens.length, feitas, atendidas: itens.filter((i) => i.atendida === 1).length,
    manuais: itens.filter((i) => i.baixaMetodo === "manual").length, pelaCdr: itens.filter((i) => i.baixaMetodo === "cdr").length, pendentes: itens.length - feitas };
}

// ---------- carga da rota ----------

function abrirAbaRota() {
  if (!iniciado) return;
  carregarRota().catch((e) => avisar("⚠ " + e.message, true));
  if (rotaUi.admin) carregarPainelRota().catch((e) => avisar("⚠ Painel da rota: " + e.message, true));
}

async function carregarRota({ manter = false } = {}) {
  const q = new URLSearchParams();
  if (rotaUi.data) q.set("data", rotaUi.data);
  if (rotaUi.admin && rotaUi.pessoa) q.set("pessoa", rotaUi.pessoa);
  const d = await chamarApi(`/api/rota?${q}`);
  rotaUi.dados = d;
  rotaUi.data = d.data;
  if (d.rota) rotaUi.pessoa = String(d.rota.pessoaId);
  renderizarCabecalhoRota(d);
  if (trab.modo !== "rota") return;
  const topo = el.trabScroll.scrollTop, selecionado = trab.selecionado;
  if (!d.rota || !d.contatos) {
    Object.assign(trab, { dados: null, linhas: [], filtradas: [], porId: new Map(), selecionado: null });
    el.trabCorpoTabela.innerHTML = `<tr class="trab-espaco"><td colspan="${COLS.length}" class="texto-suave trab-vazio">${escapeHtml(motivoSemRota(d))}</td></tr>`;
    atualizarProgressoRota();
    gravarHash();
    return;
  }
  const c = d.contatos;
  c.regionaisPorId = new Map(c.regionais.map((r) => [r.id, r]));
  c.consultoresPorId = new Map(c.consultores.map((x) => [x.id, x.nome]));
  c.statusPorHex = new Map(c.status.map((s) => [s.hex, s]));
  trab.dados = c;
  absorverMarcacoes(c);
  const itemPorContato = new Map(d.rota.itens.map((i) => [i.contatoId, i]));
  trab.linhas = c.linhas.map(montarLinha);
  let anterior;
  for (const o of trab.linhas) {
    const it = itemPorContato.get(o.id);
    const grupo = `${it.tipoId}|${o.codigo_ibge}`; // faixa entre municípios e na troca de setor da fila
    Object.assign(o, { rotaItem: it, rotaPosicao: it.posicao, rotaTipo: it.tipoNome || "", rotaBaixaOrdem: it.baixaMetodo ? (it.atendida ? 2 : 1) : 0, rotaGrupoInicio: grupo !== anterior });
    anterior = grupo;
  }
  trab.porId = new Map(trab.linhas.map((o) => [o.id, o]));
  const fora = d.rota.itens.length - trab.linhas.length;
  const aviso = document.getElementById("rota-aviso");
  aviso.classList.toggle("oculto", !fora);
  if (fora) aviso.textContent = `${fora} contato(s) desta rota não estão mais na sua carteira atual e não aparecem na lista.`;
  aplicarFiltros();
  if (manter) {
    el.trabScroll.scrollTop = topo;
    if (selecionado && trab.porId.has(selecionado)) trab.selecionado = selecionado;
    renderizarJanela(true);
  }
}
const recarregarRota = () => carregarRota({ manter: true });

function motivoSemRota(d) {
  if (rotaUi.admin && !d.pessoas?.length) {
    if (!d.campanha?.tipoId) return "Nenhuma campanha vigente nesta data — escolha o setor no painel acima.";
    return d.data > d.hoje ? `As rotas de ${dataBr(d.data)} são geradas às 17h do dia útil anterior.` : "Nenhuma rota gerada nesta data (nenhum consultor com carteira?).";
  }
  if (!d.campanha?.tipoId) return "Não há campanha de rota vigente nesta data.";
  if (d.data > d.hoje) return `A rota de ${dataBr(d.data)} fica pronta às 17h do dia útil anterior.`;
  return "Você não tem rota nesta data — sem carteira atribuída ou sem rota gerada. Fale com o administrador.";
}

function renderizarCabecalhoRota(d) {
  const r = d.rota;
  document.getElementById("rota-titulo").textContent = r ? `Rota de ${r.nome}` : "Rota do dia";
  document.getElementById("rota-subtitulo").textContent = r
    ? `${rotuloDia(r.data, d.hoje)} · ${r.tipos?.length ? `setores: ${r.tipos.join(" → ")}` : `campanha ${r.tipo}`} · gerada ${dataHoraBr(r.geradaEm)}`
    : d.campanha?.tipoId ? `${rotuloDia(d.data, d.hoje)} · campanha ${d.campanha.nome}` : rotuloDia(d.data, d.hoje);
  // dias: hoje, próxima geração e as datas que já têm rota
  const datas = [...new Set([d.hoje, d.proximaGeracao, d.data, ...(d.datas || [])])].sort().reverse();
  document.getElementById("rota-data").innerHTML = datas.map((x) => `<option value="${x}" ${x === d.data ? "selected" : ""}>${escapeHtml(rotuloDia(x, d.hoje))}</option>`).join("");
  const sel = document.getElementById("rota-pessoa");
  sel.classList.toggle("oculto", !rotaUi.admin);
  if (rotaUi.admin) {
    sel.innerHTML = (d.pessoas || []).map((p) => `<option value="${p.id}" ${String(p.id) === rotaUi.pessoa ? "selected" : ""}>${escapeHtml(p.nome)}</option>`).join("") ||
      `<option value="">nenhuma rota nesta data</option>`;
  }
  const curta = r && r.itens.length < r.cota;
  const aviso = document.getElementById("rota-aviso");
  if (curta) {
    aviso.classList.remove("oculto");
    const fila = d.campanha?.nome || r.tipo;
    aviso.textContent = r.itens.length
      ? `Rota curta: ${r.itens.length} de ${r.cota}. O estoque da fila inteira (${fila}) ${rotaUi.admin ? `da carteira de ${r.nome}` : "da sua carteira"} acabou — a campanha terminou ${rotaUi.admin ? "para ele(a)" : "para você"}.`
      : `Rota vazia: não há mais contatos disponíveis em nenhum setor da fila (${fila}) ${rotaUi.admin ? `na carteira de ${r.nome}` : "na sua carteira"} (bloqueios de 7 e 30 dias).`;
  } else {
    aviso.classList.add("oculto");
  }
  atualizarProgressoRota();
}

async function desfazerBaixaRota(contatoId) {
  const o = trab.porId.get(contatoId);
  if (!o?.rotaItem) return;
  try {
    const item = await chamarApi(`/api/rota/itens/${o.rotaItem.id}/baixa`, { method: "DELETE" });
    Object.assign(o.rotaItem, item);
    o.rotaBaixaOrdem = item.baixaMetodo ? 1 : 0;
    rerenderLinha(contatoId);
    atualizarProgressoRota();
    avisar("Baixa manual desfeita — o registro no histórico do contato continua.");
    if (rotaUi.admin) carregarPainelRota().catch(() => {});
  } catch (e) {
    avisar("⚠ " + e.message, true);
  }
}

document.getElementById("rota-data").addEventListener("change", (ev) => {
  rotaUi.data = ev.target.value;
  if (rotaUi.admin) rotaUi.pessoa = "";
  carregarRota().catch((e) => avisar("⚠ " + e.message, true));
  if (rotaUi.admin) carregarPainelRota().catch((e) => avisar("⚠ " + e.message, true));
});
document.getElementById("rota-pessoa").addEventListener("change", (ev) => {
  rotaUi.pessoa = ev.target.value;
  carregarRota().catch((e) => avisar("⚠ " + e.message, true));
});
document.getElementById("rota-recarregar").addEventListener("click", () => {
  recarregarRota().then(() => avisar("Rota atualizada.")).catch((e) => avisar("⚠ " + e.message, true));
  if (rotaUi.admin) carregarPainelRota().catch(() => {});
});

// ======================================================================
// Painel da campanha (admin)
// ======================================================================

async function carregarPainelRota() {
  const p = await chamarApi(`/api/rota/painel?data=${rotaUi.data || ""}`);
  rotaUi.painel = p;
  document.getElementById("rota-painel").classList.remove("oculto");
  renderizarPainelRota(p);
  if (!rotaUi.tipos) await carregarTiposRota();
}

function renderizarPainelRota(p) {
  const c = p.campanha;
  const nomeCamp = (x) => (x?.tipoId ? `<strong>${escapeHtml(x.nome)}</strong>` : `<span class="pct-meio">sem campanha</span>`);
  document.getElementById("rota-campanha-texto").innerHTML = c.hoje?.tipoId
    ? `Em campanha: ${nomeCamp(c.hoje)} <span class="texto-suave">desde ${dataBr(c.hoje.valeDesde)}</span>`
    : `Nenhuma campanha vigente hoje.`;
  const proxima = c.proxima;
  document.getElementById("rota-campanha-agenda").innerHTML =
    `Próxima geração: <strong>${escapeHtml(rotuloDia(p.proximaGeracao, p.hoje))}</strong>, às ${p.horaGeracao}h do dia útil anterior — fila ${nomeCamp(proxima)}` +
    ` · bloqueio: ${p.bloqueio.dias} dias (ligado/baixa) e ${p.bloqueio.semLigacaoDias} dias (entrou na rota e não foi ligado) — por telefone dentro do mesmo setor, por contato entre setores`;
  if (!rotaUi.filaAlterada) rotaUi.fila = (proxima?.fila || []).map((t) => t.id);
  renderizarFila();
  rotaUi.confirmarTroca = false;
  document.getElementById("rota-trocar").textContent = rotaUi.filaAlterada ? "Salvar fila *" : "Salvar fila";

  // cartões
  const card = (rotulo, valor, extra = "", classe = "") => `<div class="metrica-card ${classe}"><span class="metrica-rotulo">${rotulo}</span><span class="metrica-valor">${valor}</span><span class="metrica-extra">${extra}</span></div>`;
  const e = p.estoque;
  const cards = [];
  if (e) {
    cards.push(card(`Estoque da fila para ${dataBr(e.data)}`, `${inteiro(e.telefones)} <small>telefones</small>`,
      `~${umaCasa(e.diasEquipe)} dia(s) para a equipe (${e.porConsultor.length} consultor(es)) · ` +
      e.fila.map((f) => `${escapeHtml(f.nome)} ${inteiro(f.telefones)} (~${umaCasa(f.diasEquipe)} d)`).join(" → ") +
      ` · em bloqueio em ${escapeHtml(e.bloqueados.tipo)}: ${inteiro(e.bloqueados.telefones)} número(s) e ${inteiro(e.bloqueados.contatos)} contato(s)`,
      e.diasEquipe < 1 ? "rota-card-alerta" : ""));
  } else {
    cards.push(card("Estoque", "—", "sem campanha para a próxima geração"));
  }
  for (const a of p.acumulados || []) {
    cards.push(card(`${escapeHtml(a.tipo)} — acumulado`, `${inteiro(a.tocados)} <small>de ${inteiro(a.universo)}</small>`,
      `telefones tocados (${pctDe(a.tocados, a.universo)}) desde ${dataBr(a.desde)} · ${inteiro(a.dias)} dia(s) de rota · ${inteiro(a.atendidos)} atendidos · ${inteiro(a.semBaixa)} entraram e não foram ligados · ${inteiro(a.nuncaEmRota)} ainda não entraram em rota`));
  }
  const totDia = p.rotasDia.reduce((s, r) => ({ itens: s.itens + r.progresso.itens, feitas: s.feitas + r.progresso.feitas, atendidas: s.atendidas + r.progresso.atendidas, cota: s.cota + r.cota }), { itens: 0, feitas: 0, atendidas: 0, cota: 0 });
  cards.push(card(`Dia ${dataBr(p.data)}`, `${inteiro(totDia.feitas)} <small>de ${inteiro(totDia.itens)}</small>`,
    `feitas (${pctDe(totDia.feitas, totDia.itens)}) · ${inteiro(totDia.atendidas)} atendidas · ${p.rotasDia.length} rota(s)${totDia.itens < totDia.cota ? ` · ${inteiro(totDia.cota - totDia.itens)} abaixo da cota` : ""}`));
  const sb = p.sobreposicao;
  if (sb) {
    cards.push(card(`Telefone compartilhado — ${escapeHtml(sb.tipo)}`, `${inteiro(sb.compartilham)} <small>de ${inteiro(sb.contatos)}</small>`,
      `contatos da campanha (${pctDe(sb.compartilham, sb.contatos)}) com o mesmo telefone de outro setor · ${inteiro(sb.telefonesCompartilhados)} de ${inteiro(sb.telefones)} números` +
      (sb.porSetor.length ? `<br><span title="${escapeHtml(sb.porSetor.map((x) => `${x.setor}: ${x.contatos}`).join(" · "))}">mais sobrepostos: ${sb.porSetor.slice(0, 4).map((x) => `${escapeHtml(x.setor)} ${inteiro(x.contatos)}`).join(" · ")}</span>` : "")));
  }
  if (e && (e.orfaos || e.semCarteira.length)) {
    cards.push(card("⚠ Fora de todas as rotas", `${inteiro(e.orfaos)} <small>contatos</small>`,
      `${e.orfaos ? "aptos, mas atribuídos a um consultor que não está vinculado à regional do município (só o dono recebe). " : ""}` +
      `${e.semCarteira.length ? `Sem carteira (não recebem rota): ${e.semCarteira.map(escapeHtml).join(", ")}.` : ""}`, "rota-card-alerta"));
  }
  document.getElementById("rota-cards").innerHTML = cards.join("");

  // rotas do dia × estoque
  document.getElementById("rota-painel-data").textContent = rotuloDia(p.data, p.hoje);
  const estoquePor = new Map((e?.porConsultor || []).map((x) => [x.pessoaId, x]));
  const classeDias = (d) => (d < 1 ? "pct-baixo" : d < 3 ? "pct-meio" : "");
  // setor atual (próxima geração), dias no setor e na fila inteira
  const colunasEstoque = (est) => !est ? `<td class="texto-suave">—</td><td>—</td><td>—</td>`
    : `<td style="text-align:left" title="${escapeHtml(est.porTipo.map((t) => `${t.nome}: ${t.telefones} telefone(s), ${umaCasa(t.dias)} dia(s)`).join(" · "))}">` +
      (est.setorAtual ? `${escapeHtml(est.setorAtual)} <small class="texto-suave">(${est.posicaoAtual}º de ${est.porTipo.length})</small>` : `<span class="pct-baixo">fila acabou</span>`) + `</td>
      <td class="${classeDias(est.diasAtual)}">${est.setorAtual ? `${umaCasa(est.diasAtual)} <small class="texto-suave">(${inteiro(est.telefonesAtual)})</small>` : "0"}</td>
      <td class="${classeDias(est.dias)}">${umaCasa(est.dias)} <small class="texto-suave">(${inteiro(est.telefones)})</small></td>`;
  const linhas = p.rotasDia.map((r) => {
    const g = r.progresso, est = estoquePor.get(r.pessoaId);
    const curta = g.itens < r.cota;
    const tipos = r.tipos.length > 1 ? `<span class="rota-tipos-mini">${r.tipos.map((t) => `${escapeHtml(t.nome)} ${inteiro(t.itens)}`).join(" + ")}</span>`
      : r.tipos.length ? `<span class="rota-tipos-mini">${escapeHtml(r.tipos[0].nome)}</span>` : "";
    return `<tr data-pessoa="${r.pessoaId}" title="abrir a rota de ${escapeHtml(r.nome)}" class="${String(r.pessoaId) === rotaUi.pessoa ? "rota-linha-atual" : ""}">
      <td style="text-align:left">${escapeHtml(r.nome)}${tipos}</td>
      <td>${curta ? `<span class="pct-meio" title="rota curta: a fila inteira acabou (${inteiro(r.elegiveis)} elegíveis na geração)">${inteiro(g.itens)}/${inteiro(r.cota)}</span>` : `${inteiro(g.itens)}/${inteiro(r.cota)}`}</td>
      <td>${inteiro(g.feitas)}</td><td>${pctDe(g.feitas, g.itens)}</td><td>${inteiro(g.atendidas)}</td><td>${inteiro(g.manuais)}</td><td>${inteiro(g.pendentes)}</td>
      <td style="text-align:left"><div class="rota-barra rota-barra-mini"><i class="rota-barra-feitas" style="width:${g.itens ? (g.feitas / Math.max(g.itens, r.cota)) * 100 : 0}%"></i><i class="rota-barra-atendidas" style="width:${g.itens ? (g.atendidas / Math.max(g.itens, r.cota)) * 100 : 0}%"></i></div></td>
      ${colunasEstoque(est)}</tr>`;
  });
  // consultores com estoque e sem rota no dia (ex.: carteira nova, ou dia sem geração)
  for (const x of e?.porConsultor || []) {
    if (p.rotasDia.some((r) => r.pessoaId === x.pessoaId)) continue;
    linhas.push(`<tr class="sem-clique"><td style="text-align:left">${escapeHtml(x.nome)}</td><td colspan="7" class="texto-suave">sem rota em ${dataBr(p.data)}</td>
      ${colunasEstoque(x)}</tr>`);
  }
  document.querySelector("#tabela-rotas-dia tbody").innerHTML = linhas.join("") ||
    `<tr class="sem-clique"><td colspan="11" class="texto-suave">Nenhuma rota nesta data e nenhum consultor com carteira.</td></tr>`;

  // estoque por regional (soma dos setores da fila)
  document.getElementById("rota-estoque-legenda").textContent = e ? `— fila ${e.tipo}, para ${dataBr(e.data)}` : "";
  document.querySelector("#tabela-rota-regionais tbody").innerHTML = (e?.porRegional || []).map((r) => `<tr class="sem-clique">
      <td>${escapeHtml(r.uf)}</td><td class="celula-nome">${escapeHtml(r.sigla)}</td>
      <td style="text-align:left">${r.titular ? escapeHtml(r.titular) : '<span class="texto-suave">—</span>'}</td><td style="text-align:left" class="texto-suave">${r.apoios.map(escapeHtml).join(", ") || "—"}</td>
      <td>${inteiro(r.universo)}</td><td title="${escapeHtml(r.porTipo.map((t) => `${t.nome}: ${t.telefones}`).join(" · "))}">${inteiro(r.telefones)}</td><td class="${r.dias < 1 ? "pct-baixo" : r.dias < 3 ? "pct-meio" : ""}">${umaCasa(r.dias)}</td></tr>`).join("") ||
    `<tr class="sem-clique"><td colspan="7" class="texto-suave">${e ? "Nenhuma regional com carteira." : "Sem campanha para a próxima geração."}</td></tr>`;

  document.getElementById("rota-historico").innerHTML = c.historico.map((h) =>
    `<li><span>${escapeHtml(dataBr(h.valeDesde))} — ${h.nome ? `<strong>${escapeHtml(h.nome)}</strong>` : "campanha encerrada"}</span>
     <span class="texto-suave">${inteiro(h.rotas)} rota(s) · por ${escapeHtml(h.usuario || "—")} em ${escapeHtml(dataHoraBr(h.criadaEm))}</span></li>`).join("") ||
    `<li class="texto-suave">Nenhuma campanha ainda.</li>`;
  renderizarTiposRota();
}

document.querySelector("#tabela-rotas-dia tbody").addEventListener("click", (ev) => {
  const tr = ev.target.closest("tr[data-pessoa]");
  if (!tr) return;
  rotaUi.pessoa = tr.dataset.pessoa;
  for (const x of document.querySelectorAll("#tabela-rotas-dia tr")) x.classList.toggle("rota-linha-atual", x === tr);
  carregarRota().then(() => document.querySelector(".rota-topo").scrollIntoView({ behavior: "smooth", block: "start" })).catch((e) => avisar("⚠ " + e.message, true));
});

// ---------- fila de setores (vale na próxima geração) ----------

function renderizarFila() {
  const tipos = rotaUi.painel?.tipos || [];
  const porId = new Map(tipos.map((t) => [t.id, t]));
  const fila = rotaUi.fila || [];
  document.getElementById("rota-fila").innerHTML = fila.map((id, i) => {
    const t = porId.get(id);
    return `<li><div><span><strong>${escapeHtml(t?.nome || `tipo ${id}`)}</strong> <small>${t ? `${t.setores.length} aba(s), ${t.cota}/dia${t.ativo ? "" : " · INATIVO (pulado)"}` : ""}</small></span>
      <button type="button" class="trab-btn" data-fila="subir" data-i="${i}" title="subir" ${i ? "" : "disabled"}>↑</button>
      <button type="button" class="trab-btn" data-fila="descer" data-i="${i}" title="descer" ${i < fila.length - 1 ? "" : "disabled"}>↓</button>
      <button type="button" class="trab-btn" data-fila="tirar" data-i="${i}" title="tirar da fila">✕</button></div></li>`;
  }).join("") || `<li class="rota-fila-vazia">fila vazia = campanha encerrada (sem rota)</li>`;
  const fora = tipos.filter((t) => t.ativo && !fila.includes(t.id));
  const sel = document.getElementById("rota-fila-tipo");
  sel.innerHTML = fora.map((t) => `<option value="${t.id}">${escapeHtml(t.nome)} — ${t.setores.length} aba(s), ${t.cota}/dia</option>`).join("") ||
    `<option value="">todos os tipos ativos já estão na fila</option>`;
  sel.disabled = document.getElementById("rota-fila-adicionar").disabled = !fora.length;
}

function mudarFila(nova) {
  rotaUi.fila = nova;
  rotaUi.filaAlterada = true;
  rotaUi.confirmarTroca = false;
  document.getElementById("rota-trocar").textContent = "Salvar fila *";
  renderizarFila();
}

document.getElementById("rota-fila").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-fila]");
  if (!b) return;
  const i = Number(b.dataset.i);
  const f = [...rotaUi.fila];
  if (b.dataset.fila === "subir" && i > 0) [f[i - 1], f[i]] = [f[i], f[i - 1]];
  else if (b.dataset.fila === "descer" && i < f.length - 1) [f[i + 1], f[i]] = [f[i], f[i + 1]];
  else if (b.dataset.fila === "tirar") f.splice(i, 1);
  mudarFila(f);
});
document.getElementById("rota-fila-adicionar").addEventListener("click", () => {
  const id = Number(document.getElementById("rota-fila-tipo").value);
  if (id) mudarFila([...(rotaUi.fila || []), id]);
});

// Salvar a fila: dois cliques (o primeiro mostra o que vai acontecer)
document.getElementById("rota-trocar").addEventListener("click", async () => {
  const refazer = document.getElementById("rota-refazer").checked;
  const btn = document.getElementById("rota-trocar");
  const porId = new Map((rotaUi.painel?.tipos || []).map((t) => [t.id, t.nome]));
  const nome = rotaUi.fila.length ? rotaUi.fila.map((id) => porId.get(id)).join(" → ") : "encerrar a campanha";
  if (!rotaUi.confirmarTroca) {
    rotaUi.confirmarTroca = true;
    btn.textContent = `Confirmar: ${nome}${refazer ? " (refazendo rotas futuras não começadas)" : ""}`;
    setTimeout(() => { if (rotaUi.confirmarTroca) { rotaUi.confirmarTroca = false; btn.textContent = rotaUi.filaAlterada ? "Salvar fila *" : "Salvar fila"; } }, 8000);
    return;
  }
  rotaUi.confirmarTroca = false;
  try {
    const r = await postJson("/api/rota/campanha", { fila: rotaUi.fila, refazerFuturas: refazer });
    document.getElementById("rota-refazer").checked = false;
    rotaUi.filaAlterada = false;
    const geradas = (r.geracao || []).reduce((s, g) => s + g.geradas, 0);
    avisar(`${r.tipo ? `Fila ${r.nome}` : "Campanha encerrada"} a partir de ${dataBr(r.valeDesde)}` +
      `${r.descartadas ? ` — ${r.descartadas} rota(s) futura(s) refeita(s)` : ""}${geradas ? ` — ${geradas} rota(s) gerada(s) agora` : ""}.`);
    await carregarPainelRota();
    await carregarRota();
  } catch (e) {
    avisar("⚠ " + e.message, true);
    btn.textContent = "Salvar fila *";
  }
});

document.getElementById("rota-gerar").addEventListener("click", async () => {
  try {
    const r = await postJson("/api/rota/gerar", {});
    const n = r.geradas.reduce((s, g) => s + g.geradas, 0);
    avisar(n ? `${n} rota(s) gerada(s): ${r.geradas.map((g) => `${dataBr(g.data)} (${g.itens} itens)`).join(", ")}.` : "Nenhuma rota faltando.");
    await carregarPainelRota();
    await carregarRota();
  } catch (e) {
    avisar("⚠ " + e.message, true);
  }
});

// ---------- tipos de rota (setores das campanhas) ----------

async function carregarTiposRota() {
  const r = await chamarApi("/api/rota/tipos");
  rotaUi.tipos = r.tipos;
  rotaUi.setores = r.setores;
  renderizarTiposRota();
  if (!rotaUi.editandoTipo) limparFormTipo();
}

function renderizarTiposRota() {
  const tipos = rotaUi.painel?.tipos || rotaUi.tipos || [];
  const naFila = new Set((rotaUi.painel?.campanha?.hoje?.fila || []).map((t) => t.id));
  document.querySelector("#tabela-rota-tipos tbody").innerHTML = tipos.map((t) => `<tr class="sem-clique">
      <td style="text-align:left"><strong>${escapeHtml(t.nome)}</strong>${naFila.has(t.id) ? ' <span class="chip">na fila</span>' : ""}</td>
      <td>${inteiro(t.cota)}</td>
      <td style="text-align:left" class="texto-suave">${t.setores.map((s) => `${escapeHtml(s.uf)} ${escapeHtml(s.setor)}`).join(" · ")}</td>
      <td>${t.ativo ? "sim" : '<span class="texto-suave">não</span>'}</td>
      <td><button type="button" class="btn-mini" data-editar-tipo="${t.id}">editar</button></td></tr>`).join("") ||
    `<tr class="sem-clique"><td colspan="5" class="texto-suave">Nenhum tipo de rota.</td></tr>`;
}

function limparFormTipo() {
  rotaUi.editandoTipo = null;
  document.getElementById("rota-tipo-form-titulo").textContent = "Novo tipo de rota";
  document.getElementById("rt-nome").value = "";
  document.getElementById("rt-cota").value = 45;
  document.getElementById("rt-ativo").checked = true;
  document.getElementById("rt-erro").classList.add("oculto");
  renderizarSetoresForm(new Set());
}

function renderizarSetoresForm(marcados) {
  const busca = normalizar(document.getElementById("rt-busca").value.trim());
  const grupos = new Map();
  for (const s of rotaUi.setores || []) (grupos.get(s.uf) ?? grupos.set(s.uf, []).get(s.uf)).push(s);
  document.getElementById("rt-setores").innerHTML = [...grupos].map(([uf, lista]) => `<fieldset class="rota-setores-uf"><legend>${escapeHtml(uf)}</legend>${lista.map((s) => {
    const k = `${s.uf}|${s.setor}`;
    const visivel = !busca || normalizar(s.setor).includes(busca) || marcados.has(k);
    return `<label class="rota-setor${visivel ? "" : " oculto"}"><input type="checkbox" value="${escapeHtml(k)}" ${marcados.has(k) ? "checked" : ""} />
      <span>${escapeHtml(s.setor)}</span> <small class="texto-suave" title="aptas (telefone válido, não oculta, não inexistente) de ${inteiro(s.linhas)} linhas">${inteiro(s.aptas)}</small></label>`;
  }).join("")}</fieldset>`).join("");
  resumoFormTipo();
}

function setoresMarcados() {
  return new Set([...document.querySelectorAll("#rt-setores input:checked")].map((i) => i.value));
}
function resumoFormTipo() {
  const m = setoresMarcados();
  const aptas = (rotaUi.setores || []).filter((s) => m.has(`${s.uf}|${s.setor}`)).reduce((t, s) => t + s.aptas, 0);
  document.getElementById("rt-resumo").textContent = `${m.size} aba(s) marcada(s) · ${inteiro(aptas)} linhas aptas (antes de tirar telefones repetidos e bloqueios)`;
}

document.getElementById("tabela-rota-tipos").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-editar-tipo]");
  if (!b) return;
  const t = (rotaUi.painel?.tipos || rotaUi.tipos || []).find((x) => x.id === Number(b.dataset.editarTipo));
  if (!t) return;
  rotaUi.editandoTipo = t.id;
  document.getElementById("rota-tipo-form-titulo").textContent = `Editar "${t.nome}"`;
  document.getElementById("rt-nome").value = t.nome;
  document.getElementById("rt-cota").value = t.cota;
  document.getElementById("rt-ativo").checked = t.ativo;
  document.getElementById("rt-busca").value = "";
  document.getElementById("rt-erro").classList.add("oculto");
  renderizarSetoresForm(new Set(t.setores.map((s) => `${s.uf}|${s.setor}`)));
  document.getElementById("rota-tipo-form").scrollIntoView({ behavior: "smooth", block: "nearest" });
});
document.getElementById("rt-busca").addEventListener("input", () => renderizarSetoresForm(setoresMarcados()));
document.getElementById("rt-setores").addEventListener("change", resumoFormTipo);
document.getElementById("rt-cancelar").addEventListener("click", limparFormTipo);
document.getElementById("rt-salvar").addEventListener("click", async () => {
  const setores = [...setoresMarcados()].map((k) => { const i = k.indexOf("|"); return { uf: k.slice(0, i), setor: k.slice(i + 1) }; });
  const corpo = { nome: document.getElementById("rt-nome").value, cota: Number(document.getElementById("rt-cota").value), ativo: document.getElementById("rt-ativo").checked, setores };
  const erroEl = document.getElementById("rt-erro");
  try {
    const t = rotaUi.editandoTipo
      ? await postJson(`/api/rota/tipos/${rotaUi.editandoTipo}`, corpo, "PUT")
      : await postJson("/api/rota/tipos", corpo);
    avisar(`Tipo "${t.nome}" salvo (${t.setores.length} aba(s), ${t.cota}/dia).`);
    rotaUi.editandoTipo = null;
    await carregarTiposRota();
    await carregarPainelRota();
  } catch (e) {
    erroEl.textContent = e.message;
    erroEl.classList.remove("oculto");
  }
});
