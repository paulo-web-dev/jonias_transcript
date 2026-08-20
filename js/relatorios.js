"use strict";

const el = {
  lista: document.getElementById("lista-periodos"),
  vazio: document.getElementById("periodos-vazio"),
  painel: document.getElementById("painel-periodo"),
  painelTitulo: document.getElementById("painel-titulo"),
  painelCongelado: document.getElementById("painel-congelado"),
  seletorVersao: document.getElementById("seletor-versao"),
  btnRecongelar: document.getElementById("btn-recongelar"),
  btnFecharPainel: document.getElementById("btn-fechar-painel"),
  cardsEquipe: document.getElementById("cards-equipe"),
  tabela: document.getElementById("tabela-consultores"),
  detalhe: document.getElementById("detalhe-consultor"),
  detalheTitulo: document.getElementById("detalhe-titulo"),
  detalheConteudo: document.getElementById("detalhe-conteudo"),
  btnFecharDetalhe: document.getElementById("btn-fechar-detalhe"),
  modal: document.getElementById("modal-periodo"),
  campoNome: document.getElementById("campo-periodo-nome"),
  campoDe: document.getElementById("campo-periodo-de"),
  campoAte: document.getElementById("campo-periodo-ate"),
  modalErro: document.getElementById("modal-periodo-erro"),
  aviso: document.getElementById("aviso"),
};

let periodoAberto = null;
let avisoTimerId = null;
// Feedback individual (IA): estado do período aberto
let feedbackInfo = { porPessoa: new Map(), elegiveis: new Set() };
let versoesSnapshot = [];

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t ?? "";
  return d.innerHTML;
}
function mostrarAviso(m) {
  el.aviso.textContent = "⚠ " + m;
  el.aviso.classList.add("visivel");
  clearTimeout(avisoTimerId);
  avisoTimerId = setTimeout(() => el.aviso.classList.remove("visivel"), 8000);
}
async function chamarApi(url, opcoes) {
  const r = await fetch(url, opcoes);
  if (r.status === 401) { location.href = "/login"; throw new Error("sessão expirada"); }
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.error || `erro ${r.status}`);
  return corpo;
}

const dinheiro = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const reais = (centavos) => dinheiro.format((centavos || 0) / 100);
const dataBr = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const dataHoraBr = (iso) => { const d = new Date(iso); return isNaN(d) ? "—" : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); };
const segundos = (s) => (s == null ? "—" : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`);
const pctClasse = (p) => (p == null ? "" : p >= 100 ? "pct-ok" : p >= 70 ? "pct-meio" : "pct-baixo");
const pctTexto = (p) => (p == null ? "—" : p.toLocaleString("pt-BR") + "%");

// ---------- Lista de períodos ----------

async function carregarPeriodos() {
  const { periodos } = await chamarApi("/api/periodos").catch(() => ({ periodos: [] }));
  el.vazio.classList.toggle("oculto", periodos.length > 0);
  el.lista.innerHTML = "";
  for (const p of periodos) {
    const item = document.createElement("div");
    item.className = "aula-item";
    item.innerHTML = `
      <div class="aula-info">
        <div class="aula-nome-linha">
          <span class="aula-nome">${escapeHtml(p.nome)}</span>
          <span class="chip chip-andamento">congelado v${p.versoes}</span>
        </div>
        <div class="aula-meta">
          <span>📅 ${dataBr(p.data_inicio)} a ${dataBr(p.data_fim)}</span>
          <span>🧊 ${dataHoraBr(p.congelado_em)}</span>
        </div>
      </div>
      <div class="aula-acoes">
        <button class="btn btn-secundario btn-mini" data-acao="abrir">Abrir</button>
        <button class="btn btn-perigo btn-mini" data-acao="excluir">Excluir</button>
      </div>`;
    item.querySelector('[data-acao="abrir"]').addEventListener("click", () => abrirPeriodo(p.id));
    item.querySelector('[data-acao="excluir"]').addEventListener("click", async () => {
      if (!confirm(`Excluir o período "${p.nome}" e todas as versões congeladas?`)) return;
      try {
        await chamarApi(`/api/periodos/${p.id}`, { method: "DELETE" });
        if (periodoAberto === p.id) el.painel.classList.add("oculto");
        carregarPeriodos();
      } catch (e) { mostrarAviso(`Não foi possível excluir. (${e.message})`); }
    });
    el.lista.appendChild(item);
  }
}

// ---------- Painel do período ----------

async function abrirPeriodo(id, versao) {
  try {
    const r = await chamarApi(`/api/periodos/${id}${versao ? `?versao=${versao}` : ""}`);
    periodoAberto = id;
    versoesSnapshot = r.versoes;
    await carregarFeedbacks(id);
    renderizarPeriodo(r);
    el.painel.classList.remove("oculto");
    el.painel.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { mostrarAviso(`Não foi possível abrir o período. (${e.message})`); }
}

function renderizarPeriodo(r) {
  const d = r.dados;
  el.painelTitulo.textContent = r.periodo.nome;
  el.painelCongelado.textContent =
    `${dataBr(d.de)} a ${dataBr(d.ate)} · ${d.diasUteis} dia(s) útil(eis) · ` +
    `congelado em ${dataHoraBr(r.congeladoEm)} (versão ${r.versoes.findIndex((v) => v.id === r.versaoAtual) + 1} de ${r.versoes.length})`;

  el.seletorVersao.innerHTML = r.versoes
    .map((v, i) => `<option value="${v.id}" ${v.id === r.versaoAtual ? "selected" : ""}>v${i + 1} — ${dataHoraBr(v.criado_em)} (${escapeHtml(v.usuario)})</option>`)
    .join("");
  el.seletorVersao.onchange = () => abrirPeriodo(periodoAberto, el.seletorVersao.value);
  el.btnRecongelar.onclick = async () => {
    if (!confirm("Recalcular com os dados atuais e gravar uma NOVA versão? A atual fica guardada.")) return;
    try {
      await chamarApi(`/api/periodos/${periodoAberto}/recongelar`, { method: "POST" });
      abrirPeriodo(periodoAberto);
      carregarPeriodos();
    } catch (e) { mostrarAviso(`Não foi possível recongelar. (${e.message})`); }
  };

  // Cards do time — matrículas, vendas e receita SEMPRE lado a lado
  const eq = d.equipe;
  const card = (titulo, valor, extra) =>
    `<div class="metrica-card"><span class="metrica-rotulo">${titulo}</span>
      <span class="metrica-valor">${valor}</span>${extra ? `<span class="metrica-extra">${extra}</span>` : ""}</div>`;
  el.cardsEquipe.innerHTML =
    card("Matrículas (equipe)", eq.matriculas, `meta ${eq.metaMatriculas}`) +
    card("Vendas (oportunidades ganhas)", eq.vendas, "") +
    card("Receita (equipe)", reais(eq.receitaCentavos), "") +
    card("Ligações discadas", eq.discadas, `meta ${eq.metaDiscadas} · ${eq.atendidas} atendidas (${pctTexto(eq.taxaAtendimento)})`) +
    card("Leads novos", eq.leadsNovos, `meta ${eq.metaLeads}`) +
    card("TMA da equipe", segundos(eq.tmaSeg), "sobre tempo de conversa") +
    card("Empresa (com canais e sem atribuição)",
      `${d.empresa.matriculas} matr. · ${reais(d.empresa.receitaCentavos)}`,
      d.canais.map((c) => `${escapeHtml(c.nome)}: ${c.matriculas} matr.`).join(" · ") +
        (d.semAtribuicao.matriculas ? ` · sem atribuição: ${d.semAtribuicao.matriculas}` : ""));

  // Tabela por consultor
  const corpo = el.tabela.querySelector("tbody");
  corpo.innerHTML = "";
  for (const p of d.porPessoa) {
    const tr = document.createElement("tr");
    const conflito = p.conflitosAtribuicao
      ? ` <span class="conflito" title="${p.conflitosAtribuicao} matrícula(s) com atribuição em conflito (wallet ≠ vendedor no CRM) — valeu o wallet">⚠</span>`
      : "";
    const perdidas = p.funil.perdidas + (p.funil.perdidasAproximadas ? ` <span class="texto-suave" title="${p.funil.perdidasAproximadas} sem data real de perda — aproximadas pela Data de Atualização">≈${p.funil.perdidasAproximadas}</span>` : "");
    tr.innerHTML = `
      <td class="celula-nome">${escapeHtml(p.nome)}${conflito}</td>
      <td>${p.ligacoes.discadas.valor}</td><td>${p.ligacoes.discadas.meta ?? "—"}</td>
      <td class="${pctClasse(p.ligacoes.discadas.atingimento)}">${pctTexto(p.ligacoes.discadas.atingimento)}</td>
      <td>${p.ligacoes.atendidas}</td><td>${pctTexto(p.ligacoes.taxaAtendimento)}</td>
      <td>${segundos(p.ligacoes.tmaSeg)}</td>
      <td>${p.funil.leadsNovos.valor}</td><td>${p.funil.leadsNovos.meta ?? "—"}</td>
      <td class="${pctClasse(p.funil.leadsNovos.atingimento)}">${pctTexto(p.funil.leadsNovos.atingimento)}</td>
      <td>${perdidas}</td><td>${p.funil.vendas}</td>
      <td>${p.matriculas.valor}</td><td>${p.matriculas.meta ?? "—"}</td>
      <td class="${pctClasse(p.matriculas.atingimento)}">${pctTexto(p.matriculas.atingimento)}</td>
      <td>${reais(p.receitaCentavos)}</td>`;
    tr.addEventListener("click", () => mostrarDetalhe(p, d));
    corpo.appendChild(tr);
  }
  const rodape = el.tabela.querySelector("tfoot");
  rodape.innerHTML = `<tr>
    <td>Equipe</td><td>${eq.discadas}</td><td>${eq.metaDiscadas}</td><td></td>
    <td>${eq.atendidas}</td><td>${pctTexto(eq.taxaAtendimento)}</td><td>${segundos(eq.tmaSeg)}</td>
    <td>${eq.leadsNovos}</td><td>${eq.metaLeads}</td><td></td>
    <td>${eq.perdidas}</td><td>${eq.vendas}</td>
    <td>${eq.matriculas}</td><td>${eq.metaMatriculas}</td><td></td>
    <td>${reais(eq.receitaCentavos)}</td></tr>`;
  el.detalhe.classList.add("oculto");
}

function mostrarDetalhe(p, d) {
  el.detalheTitulo.textContent = p.nome;
  const fases = Object.entries(p.funil.porFase)
    .map(([f, n]) => `<li>${escapeHtml(f)}: <strong>${n}</strong></li>`)
    .join("") || "<li class='texto-suave'>nenhum lead no período</li>";
  const conflitoAviso = p.conflitosAtribuicao
    ? `<p class="conflito-aviso">⚠ ${p.conflitosAtribuicao} matrícula(s) deste consultor casaram com oportunidade
       de OUTRO vendedor no CRM — valeu o wallet, como definido. Detalhe na
       <a href="/saude">saúde dos dados</a>.</p>`
    : "";
  el.detalheConteudo.innerHTML = `
    ${conflitoAviso}
    <div class="grade-metricas">
      <div class="metrica-card"><span class="metrica-rotulo">Matrículas</span>
        <span class="metrica-valor">${p.matriculas.valor}</span>
        <span class="metrica-extra">meta ${p.matriculas.meta ?? "—"} · ${pctTexto(p.matriculas.atingimento)}</span></div>
      <div class="metrica-card"><span class="metrica-rotulo">Vendas</span>
        <span class="metrica-valor">${p.funil.vendas}</span>
        <span class="metrica-extra">ticket ${reais(p.funil.ticketCentavos)}</span></div>
      <div class="metrica-card"><span class="metrica-rotulo">Receita</span>
        <span class="metrica-valor">${reais(p.receitaCentavos)}</span></div>
    </div>
    <h4>Ligações</h4>
    <ul>
      <li>Discadas: <strong>${p.ligacoes.discadas.valor}</strong> (meta ${p.ligacoes.discadas.meta ?? "—"}, ${pctTexto(p.ligacoes.discadas.atingimento)}) — em ${d.diasUteis} dia(s) útil(eis)</li>
      <li>Atendidas: <strong>${p.ligacoes.atendidas}</strong> (taxa ${pctTexto(p.ligacoes.taxaAtendimento)})</li>
      <li>Tempo de conversa: <strong>${segundos(p.ligacoes.conversaSeg)}</strong> · TMA ${segundos(p.ligacoes.tmaSeg)} · toque mediano ${segundos(p.ligacoes.toqueMedianoSeg)}</li>
    </ul>
    <h4>Funil (leads criados no período, fase atual)</h4>
    <ul>${fases}</ul>
    <ul>
      <li>Perdidas no período: <strong>${p.funil.perdidas}</strong>${p.funil.perdidasAproximadas ? ` (${p.funil.perdidasAproximadas} com data aproximada)` : ""}</li>
    </ul>
    <h4>💬 Feedback individual (IA)</h4>
    <div id="area-feedback"></div>`;
  renderizarSecaoFeedback(p);
  el.detalhe.classList.remove("oculto");
  el.detalhe.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- Feedback individual (IA) ----------
// Os números vêm do snapshot congelado; a IA só escreve o texto em volta
// deles. Gerar de novo cria uma nova versão — as anteriores ficam guardadas.

async function carregarFeedbacks(periodoId) {
  const r = await chamarApi(`/api/periodos/${periodoId}/feedbacks`)
    .catch(() => ({ feedbacks: [], elegiveis: [] }));
  feedbackInfo = { porPessoa: new Map(), elegiveis: new Set(r.elegiveis.map((e) => e.id)) };
  for (const f of r.feedbacks) {
    (feedbackInfo.porPessoa.get(f.pessoa_id) ??
      feedbackInfo.porPessoa.set(f.pessoa_id, []).get(f.pessoa_id)).push(f);
  }
}

function renderizarSecaoFeedback(p, feedbackIdEscolhido) {
  const area = document.getElementById("area-feedback");
  if (!area) return;
  if (!feedbackInfo.elegiveis.has(p.pessoaId)) {
    area.innerHTML =
      `<p class="texto-suave">Este consultor está fora do feedback individual (configuração da equipe).</p>`;
    return;
  }
  const lista = feedbackInfo.porPessoa.get(p.pessoaId) || []; // mais recente primeiro
  const escolhido = lista.find((f) => f.id === feedbackIdEscolhido) || lista[0];
  if (!escolhido) {
    area.innerHTML = `
      <p class="texto-suave">Nenhum feedback gerado para este consultor neste período.</p>
      <button id="btn-gerar-feedback" class="btn btn-primario btn-mini">💬 Gerar feedback com IA</button>`;
  } else {
    const versaoNum = (f) => lista.length - lista.indexOf(f);
    const baseNum = versoesSnapshot.findIndex((v) => v.id === escolhido.snapshot_id) + 1;
    const base = baseNum ? ` · números da v${baseNum} do congelamento` : "";
    const seletor = lista.length > 1
      ? `<select id="feedback-versao" class="campo-select">${lista
          .map((f) => `<option value="${f.id}" ${f.id === escolhido.id ? "selected" : ""}>v${versaoNum(f)} — ${dataHoraBr(f.criado_em)} (${escapeHtml(f.usuario)})</option>`)
          .join("")}</select>`
      : `<span class="texto-suave">gerado em ${dataHoraBr(escolhido.criado_em)} por ${escapeHtml(escolhido.usuario)}</span>`;
    area.innerHTML = `
      <div class="painel-acoes feedback-meta">${seletor}
        <button id="btn-gerar-feedback" class="btn btn-secundario btn-mini">⟳ Gerar novamente</button>
        <span class="texto-suave">${escapeHtml(escolhido.modelo)}${base}</span>
      </div>
      <div class="modal-conteudo sem-padding">${MarkdownAula.renderizarMarkdown(escolhido.texto_md)}</div>`;
    document.getElementById("feedback-versao")?.addEventListener("change", (e) =>
      renderizarSecaoFeedback(p, Number(e.target.value)));
  }
  document.getElementById("btn-gerar-feedback").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "jonIAs está escrevendo o feedback…";
    try {
      await chamarApi(`/api/periodos/${periodoAberto}/feedbacks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pessoaId: p.pessoaId }),
      });
      await carregarFeedbacks(periodoAberto);
    } catch (err) {
      mostrarAviso(`Não foi possível gerar o feedback. (${err.message})`);
    }
    renderizarSecaoFeedback(p);
  });
}

// ---------- Novo período ----------

function abrirModal() {
  el.campoNome.value = "";
  el.campoDe.value = "";
  el.campoAte.value = "";
  el.modalErro.classList.add("oculto");
  el.modal.classList.remove("oculto");
  el.campoNome.focus();
}
document.getElementById("btn-novo-periodo").addEventListener("click", abrirModal);
document.querySelector('[data-fechar="modal-periodo"]').addEventListener("click", () =>
  el.modal.classList.add("oculto"));

document.getElementById("btn-semana-passada").addEventListener("click", () => {
  const hoje = new Date();
  const seg = new Date(hoje);
  seg.setDate(hoje.getDate() - ((hoje.getDay() + 6) % 7) - 7);
  const sex = new Date(seg);
  sex.setDate(seg.getDate() + 4);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  el.campoDe.value = iso(seg);
  el.campoAte.value = iso(sex);
  if (!el.campoNome.value) {
    el.campoNome.value = `Semana ${dataBr(iso(seg)).slice(0, 5)}–${dataBr(iso(sex)).slice(0, 5)}`;
  }
});

document.getElementById("btn-confirmar-periodo").addEventListener("click", async () => {
  try {
    const r = await chamarApi("/api/periodos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: el.campoNome.value, de: el.campoDe.value, ate: el.campoAte.value }),
    });
    el.modal.classList.add("oculto");
    await carregarPeriodos();
    abrirPeriodo(r.id);
  } catch (e) {
    el.modalErro.textContent = e.message;
    el.modalErro.classList.remove("oculto");
  }
});

// ---------- Inicialização ----------

el.btnFecharPainel.addEventListener("click", () => el.painel.classList.add("oculto"));
el.btnFecharDetalhe.addEventListener("click", () => el.detalhe.classList.add("oculto"));
document.getElementById("btn-sair").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});

carregarPeriodos();
