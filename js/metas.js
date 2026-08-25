"use strict";

// Painel de metas: padrão da equipe, metas próprias por consultor (diárias e
// mensais) e meta da EQUIPE em R$ (semana/mês). Toda edição cria uma vigência
// nova a partir da data escolhida — o passado nunca é sobrescrito.

const el = {
  cardsEquipe: document.getElementById("cards-equipe"),
  gerencialStatus: document.getElementById("gerencial-status"),
  btnGerencial: document.getElementById("btn-gerencial"),
  tabelaPadrao: document.getElementById("tabela-padrao"),
  blocosPessoas: document.getElementById("blocos-pessoas"),
  tabelaHistorico: document.getElementById("tabela-historico"),
  modal: document.getElementById("modal-meta"),
  modalTitulo: document.getElementById("modal-meta-titulo"),
  modalAjuda: document.getElementById("modal-meta-ajuda"),
  modalCampos: document.getElementById("modal-meta-campos"),
  campoDesde: document.getElementById("campo-meta-desde"),
  modalErro: document.getElementById("modal-meta-erro"),
  btnConfirmar: document.getElementById("btn-confirmar-meta"),
  aviso: document.getElementById("aviso"),
  btnSair: document.getElementById("btn-sair"),
};

let dados = null;
let edicao = null; // { pessoaId, escopo, nome }
let avisoTimerId = null;

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
const reais = (c) => dinheiro.format((c || 0) / 100);
const dataBr = (iso) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const numero = (v) => (v == null ? "—" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 }));
const ehReceita = (ind) => dados.receitaIndicadores.includes(ind);
const valorFmt = (ind, v) => (v == null ? "—" : ehReceita(ind) ? reais(v) : numero(v));
const hojeIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const ROTULO_ESCOPO = { dia: "Diária", mes: "Mensal" };
const ROTULO_CAMPO = { ligacoes: "📞 Ligações", leads: "✨ Leads", matriculas: "🎓 Matrículas", receita: "💰 Receita (R$)",
  semana: "💰 Meta da SEMANA (R$)", mes: "💰 Meta do MÊS (R$)" };
const ROTULO_INDICADOR = {
  ligacoes_dia: "Ligações/dia", leads_dia: "Leads/dia", matriculas_dia: "Matrículas/dia", receita_dia: "Receita/dia",
  ligacoes_mes: "Ligações/mês", leads_mes: "Leads/mês", matriculas_mes: "Matrículas/mês", receita_mes: "Receita/mês",
  receita_semana_equipe: "EQUIPE — receita/semana", receita_mes_equipe: "EQUIPE — receita/mês",
};

// ---------- Render ----------

function celulaMeta(ind, info, comHeranca) {
  // info: { valor, desde, propria?, futura? } (pessoa) ou { vigente, futura } (padrão)
  const valor = comHeranca ? info.valor : info.vigente?.valor ?? null;
  const desde = comHeranca ? info.desde : info.vigente?.desde ?? null;
  const futura = info.futura;
  let sub = "";
  if (valor == null) sub = `<small class="texto-suave">não definida</small>`;
  else if (comHeranca && !info.propria) sub = `<small class="texto-suave">padrão · desde ${dataBr(desde)}</small>`;
  else sub = `<small class="meta-propria">${comHeranca ? "própria · " : ""}desde ${dataBr(desde)}</small>`;
  if (futura) sub += `<br><small class="meta-futura">→ ${valorFmt(ind, futura.valor)} a partir de ${dataBr(futura.desde)}</small>`;
  const classe = comHeranca && info.propria ? "meta-celula meta-celula-propria" : "meta-celula";
  return `<td class="${classe}"><strong>${valorFmt(ind, valor)}</strong><br>${sub}</td>`;
}

function linhaEscopo(escopo, fonte, comHeranca, pessoaId, nome) {
  const inds = dados.indicadores[escopo];
  const celulas = ["ligacoes", "leads", "matriculas", "receita"]
    .map((campo) => celulaMeta(inds[campo], fonte[inds[campo]], comHeranca)).join("");
  return `<tr>
    <td class="celula-nome">${ROTULO_ESCOPO[escopo]}</td>${celulas}
    <td><button class="btn btn-secundario btn-mini" data-editar="${escopo}" data-pessoa="${pessoaId ?? ""}"
      data-nome="${escapeHtml(nome)}">✎ Editar</button></td></tr>`;
}

function render() {
  const eq = dados.equipe;
  const card = (titulo, valor, extra, acao) =>
    `<div class="metrica-card"><span class="metrica-rotulo">${titulo}</span>
      <span class="metrica-valor">${valor}</span>
      ${extra ? `<span class="metrica-extra">${extra}</span>` : ""}${acao || ""}</div>`;
  const equipeCard = (ind, rotulo, soma, explic) => {
    const v = eq[ind].vigente;
    const futura = eq[ind].futura
      ? ` · → ${reais(eq[ind].futura.valor)} a partir de ${dataBr(eq[ind].futura.desde)}` : "";
    return card(rotulo, v ? reais(v.valor) : "<span class='texto-suave'>não definida</span>",
      (v ? `vigente desde ${dataBr(v.desde)}` : "cadastre para o cartão da TV") + futura +
        `<br>soma das individuais: <strong>${reais(soma)}</strong> <span class="texto-suave">(${explic})</span>`);
  };
  const rm = dados.receitaMes;
  el.cardsEquipe.innerHTML =
    equipeCard("receita_semana_equipe", "Meta da equipe — SEMANA", eq.somaIndividuais.semanaCentavos, "receita/dia × 5") +
    equipeCard("receita_mes_equipe", "Meta da equipe — MÊS", eq.somaIndividuais.mesCentavos, "receita/mês de cada um") +
    card(`Equipe em ${rm.mes.slice(5)}/${rm.mes.slice(0, 4)} (realizado)`,
      reais(rm.consultoresCentavos + (rm.incluiGerencial ? rm.gerencialCentavos : 0)),
      `consultores ${reais(rm.consultoresCentavos)} · Gerencial ${reais(rm.gerencialCentavos)} ` +
        `(${rm.gerencialMatriculas} matr.) — ${rm.incluiGerencial ? "incluída" : "fora"} da meta`) +
    `<div class="metrica-card metrica-acao"><button class="btn btn-primario" data-editar="equipe" data-pessoa="" data-nome="Equipe">✎ Editar metas da equipe</button></div>`;

  el.gerencialStatus.innerHTML = rm.incluiGerencial
    ? `Gerencial <strong>INCLUÍDA</strong>: a equipe no mês soma ${reais(rm.consultoresCentavos + rm.gerencialCentavos)} ` +
      `(sem ela seria ${reais(rm.consultoresCentavos)}).`
    : `Gerencial <strong>FORA</strong>: a equipe no mês soma ${reais(rm.consultoresCentavos)} ` +
      `(com ela seria ${reais(rm.consultoresCentavos + rm.gerencialCentavos)}, +${reais(rm.gerencialCentavos)}).`;
  el.btnGerencial.textContent = rm.incluiGerencial ? "Excluir Gerencial da meta da equipe" : "Incluir Gerencial na meta da equipe";
  el.btnGerencial.dataset.inclui = rm.incluiGerencial ? "1" : "0";
  el.btnGerencial.disabled = false;

  el.tabelaPadrao.querySelector("tbody").innerHTML =
    linhaEscopo("dia", dados.padrao, false, null, "Padrão da equipe") +
    linhaEscopo("mes", dados.padrao, false, null, "Padrão da equipe");

  el.blocosPessoas.innerHTML = dados.pessoas.map((p) => `
    <div class="fonte-card metas-pessoa">
      <div class="fonte-cabecalho"><h3>${escapeHtml(p.nome)}</h3></div>
      <div class="tabela-scroll"><table class="tabela-metricas tabela-metas">
        <thead><tr><th>Escopo</th><th>📞 Ligações</th><th>✨ Leads</th><th>🎓 Matrículas</th><th>💰 Receita</th><th></th></tr></thead>
        <tbody>${linhaEscopo("dia", dados.porPessoa[p.id], true, p.id, p.nome)}${linhaEscopo("mes", dados.porPessoa[p.id], true, p.id, p.nome)}</tbody>
      </table></div>
    </div>`).join("");

  el.tabelaHistorico.querySelector("tbody").innerHTML = dados.historico.map((m) => `
    <tr class="sem-clique">
      <td>${m.pessoa ? escapeHtml(m.pessoa) : m.indicador.endsWith("_equipe") ? "Equipe" : "Padrão"}</td>
      <td>${ROTULO_INDICADOR[m.indicador] || m.indicador}</td>
      <td>${valorFmt(m.indicador, m.valor)}</td>
      <td>${dataBr(m.vigente_desde)}</td>
      <td>${m.vigente_ate ? dataBr(m.vigente_ate) : "<span class='texto-suave'>em aberto</span>"}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="texto-suave">Nenhuma meta cadastrada.</td></tr>`;
}

async function carregar() {
  try {
    dados = await chamarApi("/api/metas");
    render();
  } catch (e) {
    mostrarAviso(`Não foi possível carregar as metas. (${e.message})`);
  }
}

// ---------- Modal de edição ----------

function abrirModal(escopo, pessoaId, nome) {
  edicao = { escopo, pessoaId: pessoaId === "" ? null : Number(pessoaId), nome };
  const inds = dados.indicadores[escopo];
  const comHeranca = edicao.pessoaId !== null;
  el.modalTitulo.textContent = escopo === "equipe"
    ? "Meta da equipe (R$)"
    : `${nome} — meta ${ROTULO_ESCOPO[escopo].toLowerCase()}`;
  el.modalAjuda.textContent = escopo === "equipe"
    ? "Alvo próprio da equipe, em reais. Campo em branco = não alterar."
    : comHeranca
      ? "Campo em branco = herda o padrão da equipe (remove a meta própria a partir da data). Receita em reais."
      : "Padrão herdado por quem não tem meta própria. Campo em branco = não alterar. Receita em reais.";
  el.modalCampos.innerHTML = Object.entries(inds).map(([campo, ind]) => {
    let atual = null, placeholder = "";
    if (escopo === "equipe") atual = dados.equipe[ind].vigente?.valor ?? null;
    else if (comHeranca) {
      const info = dados.porPessoa[edicao.pessoaId][ind];
      atual = info.propria ? info.valor : null;
      const padrao = dados.padrao[ind].vigente?.valor;
      placeholder = padrao != null ? `padrão: ${ehReceita(ind) ? padrao / 100 : padrao}` : "sem padrão";
    } else atual = dados.padrao[ind].vigente?.valor ?? null;
    const valorInput = atual == null ? "" : ehReceita(ind) ? atual / 100 : atual;
    return `<label class="campo"><span>${ROTULO_CAMPO[campo]}</span>
      <input type="number" min="0" step="any" data-campo="${campo}" value="${valorInput}" placeholder="${placeholder}" /></label>`;
  }).join("");
  el.campoDesde.value = hojeIso();
  el.modalErro.classList.add("oculto");
  el.modal.classList.remove("oculto");
  el.modalCampos.querySelector("input")?.focus();
}

function fecharModal() {
  el.modal.classList.add("oculto");
  edicao = null;
}

async function confirmar() {
  if (!edicao) return;
  const valores = {};
  const comHeranca = edicao.pessoaId !== null;
  for (const input of el.modalCampos.querySelectorAll("input[data-campo]")) {
    const v = input.value.trim();
    if (v === "") {
      if (comHeranca) valores[input.dataset.campo] = null; // herdar padrão
      continue; // padrão/equipe: em branco = não mexe
    }
    valores[input.dataset.campo] = v;
  }
  if (!Object.keys(valores).length) {
    el.modalErro.textContent = "Preencha ao menos um campo.";
    el.modalErro.classList.remove("oculto");
    return;
  }
  el.btnConfirmar.disabled = true;
  try {
    const resposta = await chamarApi("/api/metas", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pessoaId: edicao.pessoaId, escopo: edicao.escopo, vigenteDesde: el.campoDesde.value, valores }),
    });
    const { mudancas, ...resto } = resposta;
    dados = resto;
    render();
    fecharModal();
    if (!mudancas.length) mostrarAviso("Nada mudou — os valores informados já eram os vigentes.");
  } catch (e) {
    el.modalErro.textContent = e.message;
    el.modalErro.classList.remove("oculto");
  } finally {
    el.btnConfirmar.disabled = false;
  }
}

// ---------- Eventos ----------

document.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-editar]");
  if (btn) abrirModal(btn.dataset.editar, btn.dataset.pessoa, btn.dataset.nome);
  if (ev.target.closest("[data-fechar='modal-meta']")) fecharModal();
});
el.modal.addEventListener("click", (ev) => { if (ev.target === el.modal) fecharModal(); });
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && edicao) fecharModal(); });
el.btnConfirmar.addEventListener("click", confirmar);
el.modalCampos.addEventListener("keydown", (ev) => { if (ev.key === "Enter") confirmar(); });

el.btnGerencial.addEventListener("click", async () => {
  const novo = el.btnGerencial.dataset.inclui !== "1";
  el.btnGerencial.disabled = true;
  try {
    await chamarApi("/api/metas/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ incluiGerencial: novo }),
    });
    await carregar();
  } catch (e) {
    el.btnGerencial.disabled = false;
    mostrarAviso(`Não foi possível alterar a configuração. (${e.message})`);
  }
});

el.btnSair.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});

carregar();
