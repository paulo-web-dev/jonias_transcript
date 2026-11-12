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
  // Marketing (migração 39): só a área de marketing e a senha
  if (sessao.papel === "marketing") {
    for (const a of acoes.querySelectorAll("a[href]")) if (a.getAttribute("href") !== "/marketing") a.remove();
    if (atual !== "/marketing" && !acoes.querySelector('a[href="/marketing"]')) acoes.insertBefore(link("/marketing", "📣 Marketing"), sair);
    if (!acoes.querySelector('a[href="/trocar-senha"]')) acoes.insertBefore(link("/trocar-senha", "🔑 Senha"), sair);
    const quemMkt = document.createElement("span");
    quemMkt.className = "topo-usuario";
    quemMkt.textContent = `${sessao.nome} · marketing`;
    acoes.insertBefore(quemMkt, acoes.firstChild);
    document.dispatchEvent(new CustomEvent("sessao-pronta", { detail: sessao }));
    return;
  }
  if (sessao.papel === "admin" && atual !== "/marketing" && !acoes.querySelector('a[href="/marketing"]')) {
    acoes.insertBefore(link("/marketing", "📣 Marketing"), sair);
  }
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
  // COTA INDIVIDUAL (migração 38): vendedor vê a DELE; admin vê todas (prévia enquanto desligadas)
  const ct = c.cotas;
  if (ct?.lista?.length) {
    const kmil = (v) => (v >= 100000 ? `${(v / 100000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}k` : reais(v).replace("R$ ", ""));
    const box = document.createElement("div");
    box.className = "cfa-cotas" + (c.cotasAtivas ? "" : " contador-previa");
    if (sessao.papel === "vendedor") {
      const x = ct.lista[0];
      box.innerHTML = `<span class="cfa-rotulo">Sua cota até ${c.ate.split("-").reverse().join("/")}</span>` +
        `<span>vendido <strong>${reais(x.vendidoCentavos)}</strong></span>` +
        (x.supermeta ? `<span>faltam <strong>${reais(x.supermeta.faltaCentavos)}</strong> para ${reais(x.supermeta.metaCentavos)} · <strong>${reais(x.supermeta.porDiaCentavos || 0)}</strong>/dia</span>` : "") +
        (x.base ? `<span>base ${reais(x.base.metaCentavos)}: ${x.base.faltaCentavos ? `faltam ${reais(x.base.faltaCentavos)} · ${reais(x.base.porDiaCentavos || 0)}/dia` : "✓ batida"}</span>` : "");
    } else {
      box.innerHTML = `<span class="cfa-rotulo">${c.cotasAtivas ? "" : "<em>prévia (só admin) · </em>"}Cotas individuais</span>` +
        ct.lista.map((x) => `<span class="cfa-cota" title="${x.nome}: ${reais(x.vendidoCentavos)} vendidos · faltam ${x.supermeta ? reais(x.supermeta.faltaCentavos) : "—"} para a supermeta e ${x.base ? reais(x.base.faltaCentavos) : "—"} para a base">` +
          `<strong>${x.nome}</strong> ${kmil(x.vendidoCentavos)}${x.supermeta ? ` / ${kmil(x.supermeta.metaCentavos)}` : ""}` +
          `<span class="cfa-mini"><span style="width:${Math.min(100, x.supermeta?.pct || 0)}%"></span></span>` +
          `<small>falta ${x.supermeta ? kmil(x.supermeta.faltaCentavos) : "—"} · base ${x.base ? (x.base.faltaCentavos ? kmil(x.base.faltaCentavos) : "✓") : "—"}</small></span>`).join("") +
        (ct.fora?.length ? `<span class="cfa-fora">sem cota (coletivo): ${ct.fora.map((f) => `${f.nome} ${kmil(f.vendidoCentavos)}`).join(" · ")}</span>` : "");
    }
    faixa.append(box);
  }
  const topo = document.querySelector("header.topo");
  if (topo) topo.after(faixa);
  else document.body.prepend(faixa);
}
