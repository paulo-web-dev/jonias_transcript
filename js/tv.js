"use strict";

// Painel de TV — tratado como PÚBLICO. Só mostra o que o payload traz:
// agregados do time, ranking de VOLUME e progresso coletivo contra metas.
// (O servidor não envia receita por consultor nem métricas de qualidade
// individuais para esta rota.)

const REFRESH_MS = 60000;
const token = new URLSearchParams(location.search).get("token") || "";

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t ?? "";
  return d.innerHTML;
}

function card(rotulo, valor, meta) {
  const pct = meta > 0 ? Math.min(100, Math.round((100 * valor) / meta)) : null;
  return `<div class="tv-card">
    <span class="tv-rotulo">${rotulo}</span>
    <span class="tv-valor">${valor.toLocaleString("pt-BR")}</span>
    <span class="tv-meta">${meta > 0 ? `meta da semana: ${meta.toLocaleString("pt-BR")}` : "&nbsp;"}</span>
    ${pct !== null ? `<div class="tv-progresso"><div style="width:${pct}%"></div></div>` : ""}
  </div>`;
}

function ranking(el, itens, campo) {
  el.innerHTML = itens
    .map((i) => `<li><span>${escapeHtml(i.nome)}</span><strong>${i[campo].toLocaleString("pt-BR")}</strong></li>`)
    .join("");
}

async function atualizar() {
  try {
    const r = await fetch(`/api/tv/dados?token=${encodeURIComponent(token)}`);
    if (!r.ok) {
      document.getElementById("tv-relogio").textContent =
        r.status === 401 ? "token inválido" : "painel indisponível";
      return;
    }
    const d = await r.json();
    document.getElementById("tv-cards").innerHTML =
      card("Ligações discadas", d.equipe.discadas, d.equipe.metaDiscadas) +
      card("Leads novos", d.equipe.leadsNovos, d.equipe.metaLeads) +
      card("Matrículas", d.equipe.matriculas, d.equipe.metaMatriculas) +
      card("Vendas", d.equipe.vendas, 0);
    ranking(document.getElementById("tv-ranking-ligacoes"), d.rankingLigacoes, "discadas");
    ranking(document.getElementById("tv-ranking-leads"), d.rankingLeads, "leads");
    const agora = new Date();
    document.getElementById("tv-relogio").textContent =
      `semana ${d.de.slice(8)}/${d.de.slice(5, 7)} → hoje · ${d.diasUteis} dia(s) útil(eis) · ` +
      `atualizado às ${agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (_) {
    document.getElementById("tv-relogio").textContent = "sem conexão — tentando de novo…";
  }
}

atualizar();
setInterval(atualizar, REFRESH_MS);
