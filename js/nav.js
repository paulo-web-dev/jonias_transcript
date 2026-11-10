"use strict";

// Menu por papel (Fase 3 da prospecção). Conveniência de interface: esconde
// links que o vendedor não pode abrir e acrescenta os dele. A PROTEÇÃO real é
// no servidor (páginas e APIs de gestão respondem 403; consultas filtradas por
// escopo) — este script só evita cliques em telas proibidas.
(async () => {
  let sessao = null;
  try {
    const r = await fetch("/api/sessao");
    if (r.status === 401) return;
    if (r.status === 403) { location.href = "/trocar-senha"; return; }
    sessao = await r.json();
  } catch (_) {
    return;
  }
  if (!sessao) return;
  document.body.dataset.papel = sessao.papel;
  document.body.dataset.usuario = sessao.nome;
  window.SESSAO = sessao;
  const acoes = document.querySelector(".topo-acoes");
  if (!acoes) return;
  const SO_ADMIN = ["/central", "/relatorios", "/metas", "/saude", "/usuarios"];
  const sair = acoes.querySelector("#btn-sair");
  const link = (href, texto) => {
    const a = document.createElement("a");
    a.href = href; a.className = "btn-topo"; a.textContent = texto;
    return a;
  };
  const atual = location.pathname;
  if (sessao.papel === "vendedor") {
    for (const a of acoes.querySelectorAll("a[href]")) if (SO_ADMIN.includes(a.getAttribute("href"))) a.remove();
    if (atual !== "/meu-painel" && !acoes.querySelector('a[href="/meu-painel"]')) acoes.insertBefore(link("/meu-painel", "📈 Meu painel"), sair);
  } else if (atual !== "/usuarios" && !acoes.querySelector('a[href="/usuarios"]')) {
    acoes.insertBefore(link("/usuarios", "👤 Usuários"), sair);
  }
  if (!acoes.querySelector('a[href="/trocar-senha"]')) acoes.insertBefore(link("/trocar-senha", "🔑 Senha"), sair);
  // ROTA FINALIZAÇÃO DE ANO (migração 36): link para todos até 15/12
  const hoje = new Date().toISOString().slice(0, 10);
  if (atual !== "/fim-de-ano" && hoje <= "2026-12-15") {
    acoes.insertBefore(link("/fim-de-ano", sessao.papel === "vendedor" ? "🎯 Rota fim de ano" : "🎯 Plano fim de ano"), acoes.querySelector('a[href]') || sair);
  }
  contadorFimDeAno(sessao).catch(() => {});
  const quem = document.createElement("span");
  quem.className = "topo-usuario";
  quem.textContent = `${sessao.nome}${sessao.papel === "vendedor" ? " · vendedor" : ""}`;
  acoes.insertBefore(quem, acoes.firstChild);
  document.dispatchEvent(new CustomEvent("sessao-pronta", { detail: sessao }));
})();

// Contador dos R$ 500 mil no header de todas as telas (fimdeano.js): só
// aparece depois que o admin liga em /fim-de-ano; antes disso o admin vê uma
// prévia marcada. Números do servidor (matrículas de nov/dez, sem canceladas).
async function contadorFimDeAno(sessao) {
  const r = await fetch("/api/fim-de-ano/contador");
  if (!r.ok) return;
  const c = await r.json();
  if (!c || c.vendidoCentavos === undefined) return;
  const reais = (v) => "R$ " + Math.round(v / 100).toLocaleString("pt-BR");
  const faixa = document.createElement("div");
  faixa.className = "contador-fim-ano" + (c.ativo ? "" : " contador-previa");
  const sm = c.supermeta, b = c.base;
  const pct = Math.min(100, (c.vendidoCentavos / sm.metaCentavos) * 100);
  faixa.innerHTML =
    `<span class="cfa-rotulo">${c.ativo ? "" : "<em>prévia (só admin) · </em>"}Meta de fim de ano</span>` +
    `<span class="cfa-principal">faltam <strong>${reais(sm.faltaCentavos)}</strong> para R$ 500 mil</span>` +
    `<span class="cfa-barra" title="${reais(c.vendidoCentavos)} vendidos de R$ 500 mil"><span style="width:${pct.toFixed(1)}%"></span></span>` +
    `<span>vendido <strong>${reais(c.vendidoCentavos)}</strong></span>` +
    `<span>base R$ 400 mil: ${b.faltaCentavos ? `faltam ${reais(b.faltaCentavos)}` : "✓ batida"}</span>` +
    `<span title="dias úteis até ${c.ate.split("-").reverse().join("/")}, hoje incluído">${c.diasUteisRestantes} dias úteis · ` +
    `<strong>${sm.porDiaCentavos !== null ? reais(sm.porDiaCentavos) : "—"}</strong>/dia (500 mil) · ${b.porDiaCentavos !== null ? reais(b.porDiaCentavos) : "—"}/dia (400 mil)</span>`;
  const topo = document.querySelector("header.topo");
  if (topo) topo.after(faixa);
  else document.body.prepend(faixa);
}
