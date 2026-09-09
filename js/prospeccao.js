"use strict";

// /prospeccao — Fase 1: cores encontradas → status (nomeadas pelo usuário) e
// cobertura da carga das planilhas de prospecção ativa.

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t ?? "";
  return d.innerHTML;
}

async function chamarApi(url, opcoes) {
  const r = await fetch(url, opcoes);
  if (r.status === 401) { location.href = "/login"; throw new Error("sessão expirada"); }
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.error || `erro ${r.status}`);
  return corpo;
}

const inteiro = (n) => (n || 0).toLocaleString("pt-BR");
const pctDe = (v, t) => (t ? (Math.round((v / t) * 1000) / 10).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%" : "—");

function avisar(texto, erro = false) {
  const el = document.getElementById("aviso");
  el.textContent = texto;
  el.classList.toggle("aviso-erro", erro);
  el.classList.add("visivel");
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => el.classList.remove("visivel"), erro ? 6000 : 2500);
}

// ---------- Cores → status ----------

let cores = [];

function textoLegivel(hex) {
  // contraste: preto sobre cor clara, branco sobre escura
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? "#0b0e17" : "#ffffff";
}

function linhaCor(c) {
  const exemplos = c.exemplos.map((e) =>
    `<li>${escapeHtml([e.municipio, e.responsavel, e.telefone].filter(Boolean).join(" · ") || "(linha sem cidade/responsável)")}` +
    `${e.observacoes ? ` <span class="texto-suave">— ${escapeHtml(String(e.observacoes).slice(0, 80))}</span>` : ""}</li>`).join("");
  const celulas = c.exemplosCelula.length
    ? `<div class="texto-suave territorio-descricao">só na célula: ${c.exemplosCelula.map((e) => `${escapeHtml(e.campo)} (${escapeHtml(e.municipio || e.setor)})`).join(", ")}</div>`
    : "";
  const abas = c.abas.map((a) => `${escapeHtml(a.aba)} <small>${a.n}</small>`).join("<br>");
  return `<tr class="sem-clique prospeccao-linha-cor ${c.ignorar ? "prospeccao-ignorada" : ""}" data-hex="${c.hex}">
    <td><span class="amostra-cor" style="background:#${c.hex};color:${textoLegivel(c.hex)}">${c.statusNome ? escapeHtml(c.statusNome) : "&nbsp;"}</span></td>
    <td class="texto-suave">#${c.hex}<div class="territorio-descricao">${escapeHtml(c.origem || "")}</div></td>
    <td>${inteiro(c.linhas)}</td><td>${inteiro(c.celulas)}</td>
    <td style="text-align:left" class="texto-suave prospeccao-abas">${abas || "—"}</td>
    <td style="text-align:left"><ul class="prospeccao-exemplos">${exemplos || "<li class='texto-suave'>sem linha inteira nesta cor</li>"}</ul>${celulas}</td>
    <td style="text-align:left"><input type="text" class="campo-select campo-status" placeholder="ex.: não tem interesse" value="${escapeHtml(c.statusNome || "")}" ${c.ignorar ? "disabled" : ""} /></td>
    <td style="text-align:left"><input type="text" class="campo-select campo-significado" placeholder="o que essa cor quer dizer" value="${escapeHtml(c.significado || "")}" ${c.ignorar ? "disabled" : ""} /></td>
    <td><input type="checkbox" class="campo-ignorar" ${c.ignorar ? "checked" : ""} /></td>
  </tr>`;
}

function renderizarCores() {
  const mostrarIgnoradas = document.getElementById("mostrar-ignoradas").checked;
  const visiveis = cores.filter((c) => mostrarIgnoradas || !c.ignorar);
  document.getElementById("chip-cores").textContent = cores.length;
  document.querySelector("#tabela-cores tbody").innerHTML = visiveis.length
    ? visiveis.map(linhaCor).join("")
    : `<tr class="sem-clique"><td colspan="9" class="texto-suave">Nenhuma cor registrada ainda — importe as planilhas em /central.</td></tr>`;
  const nomeadas = cores.filter((c) => c.statusNome).length;
  const ignoradas = cores.filter((c) => c.ignorar).length;
  document.getElementById("resumo-cores").textContent =
    `${cores.length} cor(es): ${nomeadas} com nome, ${ignoradas} marcada(s) como formatação, ${cores.length - nomeadas - ignoradas} ainda sem decisão.`;
}

async function carregarCores() {
  cores = (await chamarApi("/api/prospeccao/cores")).cores;
  renderizarCores();
}

async function salvarCor(tr) {
  const hex = tr.dataset.hex;
  const corpo = {
    statusNome: tr.querySelector(".campo-status").value,
    significado: tr.querySelector(".campo-significado").value,
    ignorar: tr.querySelector(".campo-ignorar").checked,
  };
  try {
    const atualizada = await chamarApi(`/api/prospeccao/cores/${hex}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo),
    });
    const i = cores.findIndex((c) => c.hex === hex);
    if (i >= 0) cores[i] = atualizada;
    renderizarCores();
    avisar(`#${hex} salva${atualizada.statusNome ? ` como "${atualizada.statusNome}"` : ""}.`);
  } catch (e) {
    avisar("⚠ " + e.message, true);
  }
}

document.getElementById("tabela-cores").addEventListener("change", (ev) => {
  const tr = ev.target.closest("tr[data-hex]");
  if (tr && ev.target.matches(".campo-status, .campo-significado, .campo-ignorar")) salvarCor(tr);
});
document.getElementById("tabela-cores").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ev.target.matches(".campo-status, .campo-significado")) {
    ev.preventDefault();
    ev.target.blur();
  }
});
document.getElementById("mostrar-ignoradas").addEventListener("change", renderizarCores);

// ---------- Cobertura ----------

const ROTULO_GRUPO = { casado: "casado com município", pendente: "pendente de revisão", fora: "fora da UF", sem_cidade: "sem cidade", ignorado: "ignorado na revisão", nao_processado: "não processado" };

function renderizarCobertura(c) {
  const total = c.porUf.reduce((s, u) => s + u.linhas, 0);
  const cards = c.porUf.map((u) => `<div class="metrica-card"><span class="metrica-rotulo">${escapeHtml(u.uf)} — ${u.abas} abas</span>
    <span class="metrica-valor">${inteiro(u.linhas)}</span>
    <span class="metrica-extra">${inteiro(u.ocultas)} ocultas · telefone válido ${pctDe(u.telefonesValidos, u.linhas)} · município casado ${pctDe(u.municipiosCasados, u.linhas)} (${inteiro(u.municipiosDistintos)} municípios) · ${u.municipiosPendentes} pendentes · ${u.cores} cores</span></div>`).join("");
  const grupos = c.municipiosPorGrupo.map((g) => `${escapeHtml(g.uf)} ${ROTULO_GRUPO[g.grupo] || g.grupo}: ${inteiro(g.n)}`).join(" · ");
  document.getElementById("cards-cobertura").innerHTML = cards +
    `<div class="metrica-card"><span class="metrica-rotulo">Total</span><span class="metrica-valor">${inteiro(total)}</span>
     <span class="metrica-extra">${escapeHtml(grupos || "nenhuma linha")}</span></div>` +
    `<div class="metrica-card"><span class="metrica-rotulo">Cores → status</span><span class="metrica-valor">${inteiro(c.status.nomeadas)} <small>de ${inteiro(c.status.cores)}</small></span>
     <span class="metrica-extra">com nome · ${inteiro(c.status.ignoradas)} marcadas como formatação</span></div>`;

  const linhas = c.porAba.map((a) => `<tr class="sem-clique">
    <td>${escapeHtml(a.uf)}</td><td class="celula-nome">${escapeHtml(a.setor)}</td><td>${escapeHtml(a.orgao || "—")}</td>
    <td>${inteiro(a.linhas)}</td><td>${inteiro(a.ocultas)}</td><td>${inteiro(a.telefonesValidos)}</td><td class="${a.telefonesValidos / a.linhas >= 0.7 ? "pct-ok" : a.telefonesValidos / a.linhas >= 0.4 ? "pct-meio" : "pct-baixo"}">${pctDe(a.telefonesValidos, a.linhas)}</td>
    <td>${inteiro(a.whatsapps)}</td><td>${inteiro(a.emails)}</td>
    <td>${inteiro(a.municipiosCasados)}</td><td class="${a.municipiosCasados / a.linhas >= 0.9 ? "pct-ok" : a.municipiosCasados / a.linhas >= 0.6 ? "pct-meio" : "pct-baixo"}">${pctDe(a.municipiosCasados, a.linhas)}</td>
    <td>${a.municipiosPendentes ? `<span class="pct-baixo">${inteiro(a.municipiosPendentes)}</span>` : "0"}</td><td>${inteiro(a.semMunicipio)}</td>
    <td>${inteiro(a.cores)}</td><td>${inteiro(a.editadas)}</td></tr>`).join("");
  document.querySelector("#tabela-abas tbody").innerHTML = linhas ||
    `<tr class="sem-clique"><td colspan="15" class="texto-suave">Nenhuma planilha importada ainda.</td></tr>`;
  const soma = (k) => c.porAba.reduce((s, a) => s + (a[k] || 0), 0);
  document.querySelector("#tabela-abas tfoot").innerHTML = c.porAba.length
    ? `<tr><td colspan="3">Total (${c.porAba.length} abas)</td><td>${inteiro(soma("linhas"))}</td><td>${inteiro(soma("ocultas"))}</td>
       <td>${inteiro(soma("telefonesValidos"))}</td><td>${pctDe(soma("telefonesValidos"), soma("linhas"))}</td><td>${inteiro(soma("whatsapps"))}</td><td>${inteiro(soma("emails"))}</td>
       <td>${inteiro(soma("municipiosCasados"))}</td><td>${pctDe(soma("municipiosCasados"), soma("linhas"))}</td><td>${inteiro(soma("municipiosPendentes"))}</td>
       <td>${inteiro(soma("semMunicipio"))}</td><td></td><td>${inteiro(soma("editadas"))}</td></tr>`
    : "";

  const blocos = Object.entries(c.naoReconhecidas || {}).map(([uf, info]) => {
    const colunas = (info.colunas || []).map((col) => `<li><code>${escapeHtml(col.rotulo)}</code> — ${col.abas.length} aba(s), ${inteiro(col.linhas)} valor(es) <span class="texto-suave">(${col.abas.slice(0, 5).map(escapeHtml).join(", ")}${col.abas.length > 5 ? "…" : ""})</span></li>`).join("");
    const abas = (info.abasNaoImportadas || []).map((a) => `<li><strong>${escapeHtml(a.aba)}</strong>: ${escapeHtml(a.motivo)}</li>`).join("");
    return `<div class="fonte-card"><h3>${escapeHtml(uf)}</h3>
      ${abas ? `<p class="texto-suave">Abas não importadas:</p><ul class="lista-simples prospeccao-lista">${abas}</ul>` : ""}
      <ul class="lista-simples prospeccao-lista">${colunas || "<li class='saude-ok'>✔ todas as colunas reconhecidas</li>"}</ul></div>`;
  });
  document.getElementById("nao-reconhecidas").innerHTML = blocos.length
    ? `<div class="grade-fontes">${blocos.join("")}</div>`
    : `<p class="texto-suave">Nenhuma importação ainda.</p>`;
}

async function carregarCobertura() {
  renderizarCobertura(await chamarApi("/api/prospeccao/cobertura"));
}

document.getElementById("btn-sair").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});

(async () => {
  try {
    await Promise.all([carregarCores(), carregarCobertura()]);
  } catch (e) {
    avisar("⚠ Não foi possível carregar. (" + e.message + ")", true);
  }
})();
