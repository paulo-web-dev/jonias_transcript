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
  return iso === hoje ? `hoje · ${base}` : iso > hoje ? `${base} (à frente)` : base;
};
const quandoGera = (n) => `às 17h, ${n === 1 ? "no dia útil anterior" : `${n} dias úteis antes`}`;
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
    ` · <span class="rota-ok">${inteiro(p.atendidas)} atendidas</span> · ${inteiro(p.pelaCdr)} pelo PABX · ${inteiro(p.manuais)} manuais · ${inteiro(p.pendentes)} pendentes` +
    (p.extra.itens ? ` · <span class="rota-extra-num" title="Rota Extra: opcional, não conta contra você — a que não for feita entra amanhã entre as primeiras">Extra: <strong>${inteiro(p.extra.feitas)}</strong> de ${inteiro(p.extra.itens)}</span>` : "");
}

// O progresso sai dos itens em memória (a baixa manual atualiza na hora)
// Só os itens da cota contam; a Rota Extra vem à parte (nunca contra)
function progressoLocal(r) {
  const itens = r.itens.filter((i) => !i.extra);
  const extras = r.itens.filter((i) => i.extra);
  const feitas = itens.filter((i) => i.baixaMetodo).length;
  return { cota: r.cota, itens: itens.length, feitas, atendidas: itens.filter((i) => i.atendida === 1).length,
    manuais: itens.filter((i) => i.baixaMetodo === "manual").length, pelaCdr: itens.filter((i) => i.baixaMetodo === "cdr").length, pendentes: itens.length - feitas,
    extra: { itens: extras.length, feitas: extras.filter((i) => i.baixaMetodo).length } };
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
    const grupo = `${it.extra ? 1 : 0}|${it.tipoId}|${o.codigo_ibge}`; // faixa entre municípios, na troca de setor da fila e no início da Extra
    const rotulo = it.extra ? `E${it.posicao - d.rota.cota}` : it.origemItemId ? `${it.posicao}↪` : it.posicao;
    const dica = it.extra ? "Rota Extra — opcional: não conta contra você; se não fizer, entra amanhã entre as primeiras da rota"
      : it.origemItemId ? "veio da Rota Extra do dia anterior — a ligação feita naquele dia também vale" : "";
    Object.assign(o, { rotaItem: it, rotaPosicao: it.posicao, rotaRotulo: rotulo, rotaDica: dica, rotaTipo: it.tipoNome || "",
      rotaBaixaOrdem: it.baixaMetodo ? (it.atendida ? 2 : 1) : 0, rotaGrupoInicio: grupo !== anterior });
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
    return d.data > d.hoje ? `As rotas de ${dataBr(d.data)} são geradas ${quandoGera(d.antecedencia)}.` : "Nenhuma rota gerada nesta data (nenhum consultor com carteira?).";
  }
  if (!d.campanha?.tipoId) return "Não há campanha de rota vigente nesta data.";
  if (d.data > d.hoje) return `A rota de ${dataBr(d.data)} fica pronta ${quandoGera(d.antecedencia)}.`;
  return "Você não tem rota nesta data — sem setores/carteira atribuídos ou sem rota gerada. Fale com o administrador.";
}

function renderizarCabecalhoRota(d) {
  const r = d.rota;
  document.getElementById("rota-titulo").textContent = r ? `Rota de ${r.nome}` : "Rota do dia";
  document.getElementById("rota-subtitulo").textContent = r
    ? `${rotuloDia(r.data, d.hoje)} · ${r.tipos?.length ? `setores: ${r.tipos.join(" → ")}` : `campanha ${r.tipo}`} · gerada ${dataHoraBr(r.geradaEm)}`
    : d.campanha?.tipoId ? `${rotuloDia(d.data, d.hoje)} · campanha ${d.campanha.nome}` : rotuloDia(d.data, d.hoje);
  // dias: hoje, os dias à frente que já devem ter rota (antecedência), a próxima geração e as datas que já têm rota
  const datas = [...new Set([d.hoje, d.proximaGeracao, d.data, ...(d.devidas || []), ...(d.datas || [])])].sort().reverse();
  document.getElementById("rota-data").innerHTML = datas.map((x) => `<option value="${x}" ${x === d.data ? "selected" : ""}>${escapeHtml(rotuloDia(x, d.hoje))}</option>`).join("");
  const sel = document.getElementById("rota-pessoa");
  sel.classList.toggle("oculto", !rotaUi.admin);
  if (rotaUi.admin) {
    sel.innerHTML = (d.pessoas || []).map((p) => `<option value="${p.id}" ${String(p.id) === rotaUi.pessoa ? "selected" : ""}>${escapeHtml(p.nome)}</option>`).join("") ||
      `<option value="">nenhuma rota nesta data</option>`;
  }
  // curso e turmas que o vendedor oferece (tipos da fila da campanha da rota):
  // só as de hoje em diante, a próxima em destaque
  const oferta = document.getElementById("rota-oferta");
  const turmas = (r?.turmas || []).filter((t) => t.data >= r.data);
  oferta.classList.toggle("oculto", !turmas.length);
  oferta.innerHTML = turmas.length
    ? "Oferecendo: " + turmas.map((t, i) => `<span class="${i ? "" : "rota-turma-proxima"}"><strong>${escapeHtml(t.curso)}</strong> — turma ${dataBr(t.data)}${i ? "" : " (próxima)"}</span>`).join(" · ")
    : "";
  const curta = r && r.itens.filter((i) => !i.extra).length < r.cota;
  const aviso = document.getElementById("rota-aviso");
  if (curta) {
    aviso.classList.remove("oculto");
    const fila = r.campanha || d.campanha?.nome || r.tipo;
    aviso.textContent = r.itens.length
      ? `Rota curta: ${r.itens.filter((i) => !i.extra).length} de ${r.cota}. O estoque da fila inteira (${fila}) ${rotaUi.admin ? `de ${r.nome}` : "dos seus setores"} acabou por hoje (bloqueios de 7 e 30 dias) — volta a ter contatos conforme os bloqueios vencem.`
      : `Rota vazia: não há mais contatos disponíveis em nenhum setor da fila (${fila}) ${rotaUi.admin ? `de ${r.nome}` : "dos seus setores"} (bloqueios de 7 e 30 dias).`;
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
  if (!rotaUi.feriadosLidos) { rotaUi.feriadosLidos = true; await carregarFeriados(); }
}

function renderizarPainelRota(p) {
  const c = p.campanha;
  const nomeCamp = (x) => (x?.tipoId ? `<strong>${escapeHtml(x.nome)}</strong>` : `<span class="pct-meio">sem campanha</span>`);
  const proprias = (c.vendedores || []).filter((v) => v.hoje?.tipoId).length;
  const agendadas = (c.vendedores || []).filter((v) => !v.hoje?.tipoId && v.agendada?.tipoId);
  document.getElementById("rota-campanha-texto").innerHTML = [
    c.hoje?.tipoId ? `Geral (carteiras): ${nomeCamp(c.hoje)} <span class="texto-suave">desde ${dataBr(c.hoje.valeDesde)}</span>` : "",
    proprias ? `${proprias} vendedor(es) com campanha própria por setor — tabela abaixo` : "",
    agendadas.length ? `<span class="texto-suave">campanha própria agendada: ${agendadas.map((v) => `${escapeHtml(v.nome)} a partir de ${dataBr(v.agendada.valeDesde)}`).join(", ")}</span>` : "",
  ].filter(Boolean).join("<br>") || `Nenhuma campanha vigente hoje.`;
  const proxima = c.proxima;
  document.getElementById("rota-campanha-agenda").innerHTML =
    `Próxima geração: <strong>${escapeHtml(rotuloDia(p.proximaGeracao, p.hoje))}</strong>, ${quandoGera(p.antecedencia)} — fila ${nomeCamp(proxima)}` +
    ` · bloqueio: ${p.bloqueio.dias} dias (ligado/baixa) e ${p.bloqueio.semLigacaoDias} dias (entrou na rota e não foi ligado) — por telefone dentro do mesmo setor, por contato entre setores`;
  const selAnt = document.getElementById("rota-antecedencia");
  selAnt.innerHTML = Array.from({ length: p.antecedenciaMax }, (_, i) => i + 1)
    .map((n) => `<option value="${n}" ${n === p.antecedencia ? "selected" : ""}>${n}</option>`).join("");
  renderizarDonosFila(p);
  if (!rotaUi.filaAlterada) rotaUi.fila = filaDoDono(p).map((t) => t.id);
  renderizarFila();
  renderizarVendedores(p);
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
    cards.push(card(`${a.dono ? `${escapeHtml(a.dono)} · ` : ""}${escapeHtml(a.tipo)} — acumulado`, `${inteiro(a.tocados)} <small>de ${inteiro(a.universo)}</small>`,
      `telefones tocados (${pctDe(a.tocados, a.universo)}) desde ${dataBr(a.desde)} · ${inteiro(a.dias)} dia(s) de rota · ${inteiro(a.atendidos)} atendidos · ${inteiro(a.semBaixa)} entraram e não foram ligados · ${inteiro(a.nuncaEmRota)} ainda não entraram em rota`));
  }
  const totDia = p.rotasDia.reduce((s, r) => ({ itens: s.itens + r.progresso.itens, feitas: s.feitas + r.progresso.feitas, atendidas: s.atendidas + r.progresso.atendidas, cota: s.cota + r.cota }), { itens: 0, feitas: 0, atendidas: 0, cota: 0 });
  cards.push(card(`Dia ${dataBr(p.data)}`, `${inteiro(totDia.feitas)} <small>de ${inteiro(totDia.itens)}</small>`,
    `feitas (${pctDe(totDia.feitas, totDia.itens)}) · ${inteiro(totDia.atendidas)} atendidas · ${p.rotasDia.length} rota(s)${totDia.itens < totDia.cota ? ` · ${inteiro(totDia.cota - totDia.itens)} abaixo da cota` : ""}`));
  const ex = p.extras;
  if (ex?.porPessoa?.length) {
    const tot = ex.porPessoa.reduce((s, x) => s + x.feitas, 0);
    cards.push(card(`Rota Extra — semana de ${dataBr(ex.semanaDe)}`, `${inteiro(tot)} <small>extras feitas</small>`,
      ex.porPessoa.map((x) => `${escapeHtml(x.nome)} ${inteiro(x.feitas)} de ${inteiro(x.oferecidas)}`).join(" · ") + ` · ${ex.porDia} por dia, opcionais (só a favor)`));
  }
  const sb = p.sobreposicao;
  if (sb) {
    cards.push(card(`Telefone compartilhado — ${escapeHtml(sb.tipo)}`, `${inteiro(sb.compartilham)} <small>de ${inteiro(sb.contatos)}</small>`,
      `contatos da campanha (${pctDe(sb.compartilham, sb.contatos)}) com o mesmo telefone de outro setor · ${inteiro(sb.telefonesCompartilhados)} de ${inteiro(sb.telefones)} números` +
      (sb.porSetor.length ? `<br><span title="${escapeHtml(sb.porSetor.map((x) => `${x.setor}: ${x.contatos}`).join(" · "))}">mais sobrepostos: ${sb.porSetor.slice(0, 4).map((x) => `${escapeHtml(x.setor)} ${inteiro(x.contatos)}`).join(" · ")}</span>` : "")));
  }
  if (e && (e.orfaos || e.semCarteira.length)) {
    cards.push(card("⚠ Fora de todas as rotas", `${inteiro(e.orfaos)} <small>contatos</small>`,
      `${e.orfaos ? "aptos, mas atribuídos a um consultor que não está vinculado à regional do município (só o dono recebe). " : ""}` +
      `${e.semCarteira.length ? `Sem carteira nem campanha própria (não recebem rota): ${e.semCarteira.map(escapeHtml).join(", ")}.` : ""}`, "rota-card-alerta"));
  }
  document.getElementById("rota-cards").innerHTML = cards.join("");

  // rotas do dia × estoque
  document.getElementById("rota-painel-data").textContent = rotuloDia(p.data, p.hoje);
  const estoquePor = new Map((e?.porConsultor || []).map((x) => [x.pessoaId, x]));
  const classeDias = (d) => (d < 1 ? "pct-baixo" : d < 3 ? "pct-meio" : "");
  // ponto do ciclo (próxima geração): setor atual "Finanças, 5ª de 7", dias no
  // setor e dias para fechar a volta (do setor atual até o último da fila)
  const colunasEstoque = (est) => !est ? `<td class="texto-suave">—</td><td>—</td><td>—</td>`
    : `<td style="text-align:left" title="${escapeHtml(est.porTipo.map((t, k) => `${k + 1}. ${t.nome}: ${t.telefones} telefone(s), ${umaCasa(t.dias)} dia(s)`).join(" · "))}">` +
      (est.setorAtual ? `${escapeHtml(est.setorAtual)}, <small class="texto-suave">${est.posicaoAtual}ª de ${est.porTipo.length}${est.prioridade ? " · fila própria" : ` · volta ${est.ciclo}`}</small>` +
        (est.voltaFechando ? ` <span class="chip" title="a volta anterior fecha na próxima geração">nova volta</span>` : "")
        : `<span class="pct-baixo">fila sem estoque</span>`) + `</td>
      <td class="${classeDias(est.diasAtual)}">${est.setorAtual ? `${umaCasa(est.diasAtual)} <small class="texto-suave">(${inteiro(est.telefonesAtual)})</small>` : "0"}</td>
      <td title="fila inteira: ${umaCasa(est.dias)} dia(s), ${inteiro(est.telefones)} telefone(s)">${umaCasa(est.diasVolta)}</td>`;
  const linhas = p.rotasDia.map((r) => {
    const g = r.progresso, est = estoquePor.get(r.pessoaId);
    const curta = g.itens < r.cota;
    const tipos = r.tipos.length > 1 ? `<span class="rota-tipos-mini">${r.tipos.map((t) => `${escapeHtml(t.nome)} ${inteiro(t.itens)}`).join(" + ")}</span>`
      : r.tipos.length ? `<span class="rota-tipos-mini">${escapeHtml(r.tipos[0].nome)}</span>` : "";
    return `<tr data-pessoa="${r.pessoaId}" title="abrir a rota de ${escapeHtml(r.nome)}" class="${String(r.pessoaId) === rotaUi.pessoa ? "rota-linha-atual" : ""}">
      <td style="text-align:left">${escapeHtml(r.nome)}${tipos}</td>
      <td>${curta ? `<span class="pct-meio" title="rota curta: a fila inteira acabou (${inteiro(r.elegiveis)} elegíveis na geração)">${inteiro(g.itens)}/${inteiro(r.cota)}</span>` : `${inteiro(g.itens)}/${inteiro(r.cota)}`}</td>
      <td>${inteiro(g.feitas)}</td><td>${pctDe(g.feitas, g.itens)}</td><td>${inteiro(g.atendidas)}</td><td>${inteiro(g.manuais)}</td><td>${inteiro(g.pendentes)}</td>
      <td title="Rota Extra: feitas de oferecidas (opcional)">${g.extra?.itens ? `${inteiro(g.extra.feitas)}/${inteiro(g.extra.itens)}` : "—"}</td>
      <td style="text-align:left"><div class="rota-barra rota-barra-mini"><i class="rota-barra-feitas" style="width:${g.itens ? (g.feitas / Math.max(g.itens, r.cota)) * 100 : 0}%"></i><i class="rota-barra-atendidas" style="width:${g.itens ? (g.atendidas / Math.max(g.itens, r.cota)) * 100 : 0}%"></i></div></td>
      ${colunasEstoque(est)}</tr>`;
  });
  // consultores com estoque e sem rota no dia (ex.: carteira nova, ou dia sem geração)
  for (const x of e?.porConsultor || []) {
    if (p.rotasDia.some((r) => r.pessoaId === x.pessoaId)) continue;
    linhas.push(`<tr class="sem-clique"><td style="text-align:left">${escapeHtml(x.nome)}</td><td colspan="8" class="texto-suave">sem rota em ${dataBr(p.data)}</td>
      ${colunasEstoque(x)}</tr>`);
  }
  document.querySelector("#tabela-rotas-dia tbody").innerHTML = linhas.join("") ||
    `<tr class="sem-clique"><td colspan="12" class="texto-suave">Nenhuma rota nesta data e nenhum consultor com carteira.</td></tr>`;

  // estoque por regional (soma dos setores da fila)
  document.getElementById("rota-estoque-legenda").textContent = e ? `— fila ${e.tipo}, para ${dataBr(e.data)}` : "";
  document.querySelector("#tabela-rota-regionais tbody").innerHTML = (e?.porRegional || []).map((r) => `<tr class="sem-clique">
      <td>${escapeHtml(r.uf)}</td><td class="celula-nome">${escapeHtml(r.sigla)}</td>
      <td style="text-align:left">${r.titular ? escapeHtml(r.titular) : '<span class="texto-suave">—</span>'}</td><td style="text-align:left" class="texto-suave">${r.apoios.map(escapeHtml).join(", ") || "—"}</td>
      <td>${inteiro(r.universo)}</td><td title="${escapeHtml(r.porTipo.map((t) => `${t.nome}: ${t.telefones}`).join(" · "))}">${inteiro(r.telefones)}</td><td class="${r.dias < 1 ? "pct-baixo" : r.dias < 3 ? "pct-meio" : ""}">${umaCasa(r.dias)}</td></tr>`).join("") ||
    `<tr class="sem-clique"><td colspan="7" class="texto-suave">${e ? "Nenhuma regional com carteira." : "Sem campanha para a próxima geração."}</td></tr>`;

  // histórico: trocas de fila e voltas completas de cada consultor, por data
  const eventos = [
    ...c.historico.map((h) => ({ data: h.valeDesde, html:
      `<li><span>${escapeHtml(dataBr(h.valeDesde))} — ${h.pessoa ? `${escapeHtml(h.pessoa)}: ` : "geral: "}${h.nome ? `<strong>${escapeHtml(h.nome)}</strong>` : "campanha encerrada"}</span>
       <span class="texto-suave">${inteiro(h.rotas)} rota(s) · por ${escapeHtml(h.usuario || "—")} em ${escapeHtml(dataHoraBr(h.criadaEm))}</span></li>` })),
    ...(c.voltas || []).map((v) => ({ data: v.data, html:
      `<li><span>${escapeHtml(dataBr(v.data))} — 🔁 <strong>${escapeHtml(v.nome)}</strong> completou a volta ${inteiro(v.ciclo)} da fila</span>
       <span class="texto-suave">iniciada em ${escapeHtml(dataBr(v.inicio))} · ${inteiro(v.dias)} dia(s) de rota</span></li>` })),
  ].sort((a, b) => b.data.localeCompare(a.data));
  document.getElementById("rota-historico").innerHTML = eventos.map((e) => e.html).join("") ||
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

// ---------- campanhas por vendedor (migração 34) ----------

const turmasDaFila = (fila, desde) => {
  const m = new Map();
  for (const t of fila || []) for (const x of t.turmas || []) if (x.data >= desde) m.set(`${x.data}|${x.curso}`, x);
  return [...m.values()].sort((a, b) => a.data.localeCompare(b.data));
};
const nomeFila = (fila) => (fila || []).map((t, i) => (i ? escapeHtml(t.nome) : `<strong>${escapeHtml(t.nome)}</strong>`)).join(" → ");

function renderizarVendedores(p) {
  const linhas = (p.campanha.vendedores || []).map((v) => {
    const hoje = v.hoje?.tipoId ? nomeFila(v.hoje.fila) : `<span class="texto-suave">${v.hoje ? "encerrada" : "—"}</span>`;
    const prox = v.proxima && v.proxima.id !== v.hoje?.id
      ? (v.proxima.tipoId ? nomeFila(v.proxima.fila) : "encerrada")
      : v.agendada ? `a partir de ${dataBr(v.agendada.valeDesde)}: ${v.agendada.tipoId ? nomeFila(v.agendada.fila) : "encerrada"}`
      : `<span class="texto-suave">igual</span>`;
    const ref = v.agendada || v.proxima || v.hoje;
    const turmas = turmasDaFila(ref?.fila, p.hoje).map((t) => `${escapeHtml(t.curso)} ${dataBr(t.data).slice(0, 5)}`).join(" · ") || "—";
    return `<tr class="sem-clique"><td style="text-align:left"><strong>${escapeHtml(v.nome)}</strong></td><td style="text-align:left">${hoje}</td>
      <td style="text-align:left">${prox}</td><td style="text-align:left" class="texto-suave">${turmas}</td>
      <td><button type="button" class="btn-mini" data-editar-fila="${v.pessoaId}">editar fila</button></td></tr>`;
  });
  document.querySelector("#tabela-rota-vendedores tbody").innerHTML = linhas.join("") ||
    `<tr class="sem-clique"><td colspan="5" class="texto-suave">Nenhum vendedor com campanha própria — todos seguem a fila geral (carteiras).</td></tr>`;
}

// Fila que o editor mostra: a do dono escolhido para a próxima geração (ou a
// agendada para depois dela, ou a de hoje)
function filaDoDono(p) {
  const dono = rotaUi.filaDono || "";
  if (!dono) return (p.campanha.agendada || p.campanha.proxima)?.fila || [];
  const v = (p.campanha.vendedores || []).find((x) => String(x.pessoaId) === dono);
  return (v?.agendada || v?.proxima || v?.hoje)?.fila || [];
}

function renderizarDonosFila(p) {
  const sel = document.getElementById("rota-fila-dono");
  const proprios = new Set((p.campanha.vendedores || []).map((v) => String(v.pessoaId)));
  sel.innerHTML = `<option value="">geral (carteiras regionais)</option>` + (p.consultores || []).map((c) =>
    `<option value="${c.id}">${escapeHtml(c.nome)}${proprios.has(String(c.id)) ? " — própria" : ""}</option>`).join("");
  sel.value = rotaUi.filaDono || "";
}

document.getElementById("rota-fila-dono").addEventListener("change", (ev) => {
  rotaUi.filaDono = ev.target.value;
  rotaUi.filaAlterada = false;
  rotaUi.fila = filaDoDono(rotaUi.painel).map((t) => t.id);
  rotaUi.confirmarTroca = false;
  document.getElementById("rota-trocar").textContent = "Salvar fila";
  renderizarFila();
});
document.getElementById("tabela-rota-vendedores").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-editar-fila]");
  if (!b) return;
  const sel = document.getElementById("rota-fila-dono");
  sel.value = b.dataset.editarFila;
  sel.dispatchEvent(new Event("change"));
  sel.scrollIntoView({ behavior: "smooth", block: "center" });
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
  const donoSel = document.getElementById("rota-fila-dono");
  const dono = rotaUi.filaDono ? `${donoSel.selectedOptions[0]?.textContent.replace(" — própria", "")}: ` : "geral: ";
  const nome = dono + (rotaUi.fila.length ? rotaUi.fila.map((id) => porId.get(id)).join(" → ") : "encerrar a campanha");
  if (!rotaUi.confirmarTroca) {
    rotaUi.confirmarTroca = true;
    btn.textContent = `Confirmar: ${nome}${refazer ? " (refazendo rotas futuras não começadas)" : ""}`;
    setTimeout(() => { if (rotaUi.confirmarTroca) { rotaUi.confirmarTroca = false; btn.textContent = rotaUi.filaAlterada ? "Salvar fila *" : "Salvar fila"; } }, 8000);
    return;
  }
  rotaUi.confirmarTroca = false;
  try {
    const r = await postJson("/api/rota/campanha", { fila: rotaUi.fila, refazerFuturas: refazer, pessoaId: rotaUi.filaDono ? Number(rotaUi.filaDono) : null });
    document.getElementById("rota-refazer").checked = false;
    rotaUi.filaAlterada = false;
    const geradas = (r.geracao || []).reduce((s, g) => s + g.geradas, 0);
    avisar(`${dono}${r.tipo ? `fila ${r.nome}` : "campanha encerrada"} a partir de ${dataBr(r.valeDesde)}` +
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

document.getElementById("rota-antecedencia").addEventListener("change", async (ev) => {
  try {
    const r = await postJson("/api/rota/config", { antecedencia: Number(ev.target.value) }, "PUT");
    const n = r.geracao.reduce((s, g) => s + g.geradas, 0);
    avisar(`Antecedência: ${r.antecedencia} dia(s) útil(eis)${n ? ` — ${n} rota(s) gerada(s): ${r.geracao.map((g) => dataBr(g.data)).join(", ")}` : ""}.`);
    await carregarPainelRota();
    await carregarRota();
  } catch (e) {
    avisar("⚠ " + e.message, true);
  }
});

// ---------- feriados (sem rota e fora dos dias úteis das metas) ----------

async function carregarFeriados() {
  renderizarFeriados((await chamarApi("/api/feriados")).feriados);
}

function renderizarFeriados(lista) {
  const hoje = rotaUi.painel?.hoje || "";
  const futuros = lista.filter((f) => f.data >= hoje);
  document.getElementById("rota-feriados-resumo").textContent =
    futuros.length ? `— próximo: ${dataBr(futuros[0].data)} (${futuros[0].nome})` : "— nenhum à frente";
  document.getElementById("rota-feriados").innerHTML = lista.map((f) => `<li>
      <span><strong>${escapeHtml(dataBr(f.data))}</strong> ${escapeHtml(diaSemana(f.data))} — ${escapeHtml(f.nome)}${f.fimDeSemana ? ' <small class="texto-suave">(fim de semana: não muda nada)</small>' : ""}</span>
      <span class="texto-suave">${f.data >= hoje ? `<button type="button" class="btn-mini" data-remover-feriado="${escapeHtml(f.data)}">remover</button>` : "passado"}</span></li>`).join("") ||
    `<li class="texto-suave">Nenhum feriado cadastrado.</li>`;
}

document.getElementById("fer-adicionar").addEventListener("click", async () => {
  const erroEl = document.getElementById("fer-erro");
  erroEl.classList.add("oculto");
  try {
    const r = await postJson("/api/feriados", { data: document.getElementById("fer-data").value, nome: document.getElementById("fer-nome").value });
    avisar(`Feriado ${dataBr(r.data)} cadastrado` + (r.descartadas ? ` — ${r.descartadas} rota(s) dessa data descartada(s)` : "") +
      (r.comBaixa ? `; ${r.comBaixa} rota(s) com baixa mantida(s)` : "") + ".");
    document.getElementById("fer-data").value = "";
    document.getElementById("fer-nome").value = "";
    renderizarFeriados(r.feriados);
    await carregarPainelRota();
  } catch (e) {
    erroEl.textContent = e.message;
    erroEl.classList.remove("oculto");
  }
});
document.getElementById("rota-feriados").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-remover-feriado]");
  if (!b) return;
  if (b.dataset.confirmar !== "1") { b.dataset.confirmar = "1"; b.textContent = "confirmar remoção"; return; }
  try {
    const r = await chamarApi(`/api/feriados/${b.dataset.removerFeriado}`, { method: "DELETE" });
    avisar(`Feriado ${dataBr(r.data)} removido — a data volta a ser dia útil.`);
    renderizarFeriados(r.feriados);
    await carregarPainelRota();
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
      <td style="text-align:left" class="texto-suave">${(t.turmas || []).map((x) => `${escapeHtml(x.curso)} ${dataBr(x.data)}`).join("<br>") || "—"}</td>
      <td>${t.ativo ? "sim" : '<span class="texto-suave">não</span>'}</td>
      <td><button type="button" class="btn-mini" data-editar-tipo="${t.id}">editar</button></td></tr>`).join("") ||
    `<tr class="sem-clique"><td colspan="6" class="texto-suave">Nenhum tipo de rota.</td></tr>`;
}

function limparFormTipo() {
  rotaUi.editandoTipo = null;
  document.getElementById("rota-tipo-form-titulo").textContent = "Novo tipo de rota";
  document.getElementById("rt-nome").value = "";
  document.getElementById("rt-cota").value = 45;
  document.getElementById("rt-ativo").checked = true;
  document.getElementById("rt-turmas").value = "";
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
  document.getElementById("rt-turmas").value = (t.turmas || []).map((x) => `${x.curso}; ${x.data}`).join("\n");
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
  // turmas: "curso; AAAA-MM-DD" por linha (aceita também DD/MM/AAAA)
  const turmas = document.getElementById("rt-turmas").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.lastIndexOf(";");
    let data = (i < 0 ? "" : l.slice(i + 1)).trim();
    const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(data);
    if (br) data = `${br[3]}-${br[2]}-${br[1]}`;
    return { curso: (i < 0 ? l : l.slice(0, i)).trim(), data };
  });
  const corpo = { nome: document.getElementById("rt-nome").value, cota: Number(document.getElementById("rt-cota").value), ativo: document.getElementById("rt-ativo").checked, setores, turmas };
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
