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
  const quem = document.createElement("span");
  quem.className = "topo-usuario";
  quem.textContent = `${sessao.nome}${sessao.papel === "vendedor" ? " · vendedor" : ""}`;
  acoes.insertBefore(quem, acoes.firstChild);
  document.dispatchEvent(new CustomEvent("sessao-pronta", { detail: sessao }));
})();
