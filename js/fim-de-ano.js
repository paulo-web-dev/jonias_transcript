"use strict";

// /fim-de-ano — ROTA FINALIZAÇÃO DE ANO (fimdeano.js, migração 36).
// Admin: plano vendedor × dia (curso de cada dia), editável antes e depois de
// publicar; publicar; contador dos R$ 500 mil (ligar depois de conferir);
// importação dos órgãos novos. Vendedor: a própria linha, depois de publicada.

function escapeHtml(t) { const d = document.createElement("div"); d.textContent = t ?? ""; return d.innerHTML; }
async function chamarApi(url, opcoes = {}) {
  const r = await fetch(url, opcoes);
  if (r.status === 401) { location.href = "/login"; throw new Error("sessão expirada"); }
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.error || corpo.erro || `erro ${r.status}`);
  return corpo;
}
const json = (method, corpo) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
const reais = (c) => "R$ " + Math.round((c || 0) / 100).toLocaleString("pt-BR");
const inteiro = (n) => (n || 0).toLocaleString("pt-BR");
const dataBr = (s) => (s ? s.split("-").reverse().join("/") : "");
const ddmm = (s) => dataBr(s).slice(0, 5);
const diaSemana = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" }).replace(".", "");
function avisar(texto) { const el = document.getElementById("aviso"); el.textContent = texto; el.classList.add("visivel"); clearTimeout(avisar.t); avisar.t = setTimeout(() => el.classList.remove("visivel"), 6000); }

const CORES = ["#6c7bff", "#38d6e0", "#3ddc84", "#ffc857", "#ff8f5c", "#f06bd0", "#b06cff", "#7fd0ff", "#c8e66b", "#ff5c72", "#9aa3b8"];
const estado = { dados: null, contador: null, confirmarPublicar: false };
const corDe = (tipoId) => { const i = estado.dados.cursos.findIndex((c) => c.tipoId === tipoId); return CORES[i % CORES.length]; };
const curto = (c) => (c.papel === "licitaexpo" ? "LicitaExpo" : c.papel === "2027" ? "Turmas 2027" : c.curso.split(/[,:]| e | com | para /)[0].slice(0, 22));

async function carregar() {
  const d = await chamarApi("/api/fim-de-ano");
  estado.dados = d;
  if (d.admin) estado.contador = await chamarApi("/api/fim-de-ano/contador");
  render();
}

function render() {
  const d = estado.dados;
  document.getElementById("fa-titulo").textContent = d.admin ? "Plano fim de ano — ROTA FINALIZAÇÃO DE ANO" : "ROTA FINALIZAÇÃO DE ANO";
  document.getElementById("fa-intro").textContent = d.admin
    ? `De ${dataBr(d.inicio)} a ${dataBr(d.fim)}, ${d.datas.length} dias úteis. Cada vendedor tem ${d.cota} obrigatórias por dia (prefeituras e câmaras da faixa alfabética dele, no curso do dia), ${d.extra} da Rota Extra e ${d.novosPorDia} de órgãos novos. ` +
      "O curso do dia é o setor principal. Se faltar estoque, os outros cursos com captação aberta completam a cota. Ajuste qualquer célula; a mudança vale para a geração. Depois de publicado, as rotas futuras que ninguém começou são refeitas."
    : d.publicadoEm
      ? `Seu plano de ${dataBr(d.inicio)} a ${dataBr(d.fim)}: o curso que você oferece em cada dia. Todo dia a rota traz ${d.cota} obrigatórias (as que contam para a meta e o prêmio), ${d.extra} da Rota Extra e ${d.novosPorDia} de órgãos novos.`
      : "O plano ainda não foi publicado. Ele aparece aqui assim que o administrador publicar.";
  document.getElementById("fa-admin").classList.toggle("oculto", !d.admin);
  if (d.admin) { renderAdmin(); renderProgresso(); }
  renderLegenda();
  renderPlano();
}

function renderAdmin() {
  const d = estado.dados;
  const st = document.getElementById("fa-status");
  st.textContent = d.publicadoEm ? `✓ publicado em ${new Date(d.publicadoEm).toLocaleString("pt-BR")}` : "rascunho — os vendedores ainda não veem e a geração não usa";
  st.className = "rota-bloco " + (d.publicadoEm ? "b-base" : "b-extra");
  document.getElementById("fa-publicar").textContent = estado.confirmarPublicar ? "Confirmar publicação" : d.publicadoEm ? "Publicar de novo" : "Publicar plano";
  document.getElementById("fa-publicar-dica").textContent = estado.confirmarPublicar
    ? "Publicar descarta as rotas de amanhã em diante que ninguém começou e gera tudo de novo pelo plano. Renato e a campanha atual saem da geração."
    : "";
  // contador
  const c = estado.contador;
  document.getElementById("fa-contador").innerHTML = c
    ? `Vendido em nov/dez (consultores, sem canceladas): <strong>${reais(c.vendidoCentavos)}</strong> em ${inteiro(c.matriculas)} matrícula(s). ` +
      `Faltam ${reais(c.supermeta.faltaCentavos)} para R$ 500 mil e ${reais(c.base.faltaCentavos)} para R$ 400 mil, em ${c.diasUteisRestantes} dias úteis. ` +
      `<span class="texto-suave">Unyflex sincronizada em ${c.sincronizadoEm ? new Date(c.sincronizadoEm).toLocaleString("pt-BR") : "—"}. ${c.ativo ? "Visível para todos." : "Desligado: só você vê a prévia."}</span>`
    : "";
  document.getElementById("fa-contador-ligar").textContent = c?.ativo ? "Desligar contador" : "Ligar contador (conferi o número)";
  // cotas: comparação com o plano de 10/11 (PDF) para conferir a atribuição por pessoa antes de ligar
  const PDF = { Frederico: 2128000, Eduardo: 2410000, Bianca: 1450000, Agnes: 940000, Danilo: 0, Renato: 1030000 };
  const ct = c?.cotas;
  const difPdf = (nome, v) => (PDF[nome] === undefined ? "—" : v === PDF[nome] ? '<span class="pct-ok">✓ bate</span>' : `<span class="pct-baixo">${v > PDF[nome] ? "+" : ""}${reais(v - PDF[nome])}</span>`);
  document.getElementById("fa-cotas").innerHTML = ct
    ? `<thead><tr><th>Vendedor</th><th>Vendido nov/dez</th><th>Matrículas</th><th>Plano 10/11</th><th>Diferença</th><th>Falta p/ supermeta</th><th>Falta p/ base</th><th>Por dia útil (super)</th></tr></thead><tbody>` +
      ct.lista.map((x) => `<tr class="sem-clique"><td>${escapeHtml(x.nome)}</td><td>${reais(x.vendidoCentavos)}</td><td>${inteiro(x.matriculas)}</td>
        <td>${PDF[x.nome] !== undefined ? reais(PDF[x.nome]) : "—"}</td><td>${difPdf(x.nome, x.vendidoCentavos)}</td>
        <td>${x.supermeta ? `${reais(x.supermeta.faltaCentavos)} <small class="texto-suave">de ${reais(x.supermeta.metaCentavos)}</small>` : "sem cota"}</td>
        <td>${x.base ? `${reais(x.base.faltaCentavos)} <small class="texto-suave">de ${reais(x.base.metaCentavos)}</small>` : "sem cota"}</td>
        <td>${x.supermeta ? reais(x.supermeta.porDiaCentavos || 0) : "—"}</td></tr>`).join("") +
      (ct.fora || []).map((f) => `<tr class="sem-clique texto-suave"><td>${escapeHtml(f.nome)} <small>(sem cota, coletivo)</small></td><td>${reais(f.vendidoCentavos)}</td><td></td>
        <td>${PDF[f.nome] !== undefined ? reais(PDF[f.nome]) : "—"}</td><td>${difPdf(f.nome, f.vendidoCentavos)}</td><td colspan="3"></td></tr>`).join("") + "</tbody>" +
      `<tfoot><tr><td colspan="8" class="texto-suave" style="text-align:left">Mesma fonte do contador (matrículas por data de criação, nov/dez, sem canceladas), por vendedor da matrícula (wallet). Diferença ≠ 0 = atribuição torta ou venda nova/cancelada depois de 10/11: confira antes de ligar.</td></tr></tfoot>`
    : "";
  document.getElementById("fa-cotas-ligar").textContent = c?.cotasAtivas ? "Desligar cotas individuais" : "Ligar cotas individuais (conferi por pessoa)";
  // faixas
  const faixas = d.faixas;
  const porPessoa = (pid, uf) => faixas.find((f) => f.pessoaId === pid && f.uf === uf);
  document.getElementById("fa-faixas").innerHTML =
    `<thead><tr><th>Vendedor</th><th style="text-align:left">PR</th><th style="text-align:left">SC</th><th>Municípios</th><th>Órgãos novos</th><th>com telefone</th><th>confirmar</th><th>Ramal</th></tr></thead><tbody>` +
    d.vendedores.map((v) => {
      const pr = porPessoa(v.id, "PR"), sc = porPessoa(v.id, "SC");
      return `<tr class="sem-clique"><td>${escapeHtml(v.nome)}</td>
        <td style="text-align:left">${pr ? `${escapeHtml(pr.inicio)} → ${escapeHtml(pr.fim)}` : "—"}</td>
        <td style="text-align:left">${sc ? `${escapeHtml(sc.inicio)} → ${escapeHtml(sc.fim)}` : "—"}</td>
        <td>${inteiro(v.municipios)}</td><td>${v.orgaos ? inteiro(v.orgaos.orgaos) : "—"}</td><td>${v.orgaos ? inteiro(v.orgaos.comTelefone) : "—"}</td>
        <td>${v.orgaos ? inteiro(v.orgaos.confirmar) : "—"}</td>
        <td>${v.ramal ? escapeHtml(v.ramal) : '<span class="pct-baixo" title="sem ramal, o CDR não atribui as ligações: a baixa só sai manual">sem ramal</span>'}</td></tr>`;
    }).join("") + "</tbody>" +
    `<tfoot><tr><td colspan="8" class="texto-suave" style="text-align:left">Vigência temporária de ${dataBr(faixas[0]?.desde)} a ${dataBr(faixas[0]?.ate)}; em janeiro voltam as carteiras regionais.` +
    `${d.problemasFaixas.length ? ` ⚠ ${escapeHtml(d.problemasFaixas.join("; "))}` : ""}</td></tr></tfoot>`;
  // cursos × estoque
  const est = d.estoque || {};
  document.getElementById("fa-cursos").innerHTML =
    `<thead><tr><th>Curso</th><th style="text-align:left">Setor</th><th>Turma</th><th>Captação</th>${d.vendedores.map((v) => `<th>${escapeHtml(v.nome)}</th>`).join("")}<th>Dias no plano</th></tr></thead><tbody>` +
    d.cursos.filter((c) => c.papel !== "novos").map((c) => {
      const dias = Object.values(d.celulas).filter((x) => x.tipoId === c.tipoId).length;
      return `<tr class="sem-clique"><td><span class="fa-chip" style="background:${corDe(c.tipoId)}">${escapeHtml(c.curso)}</span></td>
        <td style="text-align:left">${escapeHtml(c.setor)}</td><td>${c.turma ? ddmm(c.turma) : "—"}</td><td>${ddmm(c.de)}–${ddmm(c.ate)}</td>
        ${d.vendedores.map((v) => `<td>${inteiro(est[`${v.id}|${c.tipoId}`])}</td>`).join("")}<td>${inteiro(dias)}</td></tr>`;
    }).join("") + "</tbody>" +
    `<tfoot><tr><td colspan="${5 + d.vendedores.length}" class="texto-suave" style="text-align:left">Estoque = telefones distintos aptos da faixa nas abas do curso, sem descontar bloqueios. Cada curso é um tipo de rota novo, então o bloqueio por telefone não herda as rotas anteriores; entre cursos, o bloqueio é por contato.</td></tr></tfoot>`;
}

// Calendário de progresso (admin): vendedores × dias; a célula abre a rota
// do vendedor naquele dia na aba Rota do dia (a mesma tela que ele vê)
const linkRota = (pessoaId, data) => `/prospeccao#rota?data=${data}&pessoa=${pessoaId}`;
function renderProgresso() {
  const d = estado.dados;
  const alvo = document.getElementById("fa-progresso");
  const cab = `<tr><th class="fa-vend">Vendedor</th>${d.datas.map((dt) => `<th class="${dt === d.hoje ? "fa-hoje" : ""}">${diaSemana(dt)}<br>${ddmm(dt)}</th>`).join("")}<th>Total</th></tr>`;
  const corPct = (p, futuro) => (futuro ? "rgba(255,255,255,0.05)" : p >= 100 ? "rgba(61,220,132,0.35)" : p >= 70 ? "rgba(255,200,87,0.3)" : "rgba(255,92,114,0.28)");
  const linhas = d.vendedores.map((v) => {
    const tot = { feitas: 0, base: 0, extraFeitas: 0, novosFeitos: 0 };
    const cels = d.datas.map((dt) => {
      const r = d.rotas[`${v.id}|${dt}`];
      if (!r) return `<td class="texto-suave">—</td>`;
      const futuro = dt > d.hoje;
      if (!futuro) { tot.feitas += r.feitas; tot.base += r.base; tot.extraFeitas += r.extraFeitas; tot.novosFeitos += r.novosFeitos; }
      const pct = r.base ? Math.round((r.feitas / r.base) * 100) : 0;
      return `<td class="fa-cel ${dt === d.hoje ? "fa-hoje" : ""}" style="background:${corPct(pct, futuro)}"><a href="${linkRota(v.id, dt)}" title="abrir a rota de ${escapeHtml(v.nome)} em ${dataBr(dt)}">` +
        (futuro ? `<span class="texto-suave">${r.base} + E${r.extra} + N${r.novos}</span>`
          : `<strong>${r.feitas}/${r.base}</strong><span class="fa-rota">E ${r.extraFeitas}/${r.extra} · N ${r.novosFeitos}/${r.novos}</span>`) + "</a></td>";
    }).join("");
    return `<tr><td class="fa-vend">${escapeHtml(v.nome)}</td>${cels}<td><strong>${inteiro(tot.feitas)}/${inteiro(tot.base)}</strong><span class="fa-rota">E ${inteiro(tot.extraFeitas)} · N ${inteiro(tot.novosFeitos)}</span></td></tr>`;
  }).join("");
  alvo.innerHTML = `<div class="fa-grade-wrap"><table class="fa-grade"><thead>${cab}</thead><tbody>${linhas}</tbody></table></div>` +
    `<p class="texto-suave">Dias passados e hoje: obrigatórias feitas/total (verde ≥ 100%, âmbar ≥ 70%), E = Rota Extra, N = órgãos novos. Dias à frente: o que a rota já tem gerado. Total = até hoje.</p>`;
}

function renderLegenda() {
  const d = estado.dados;
  document.getElementById("fa-legenda").innerHTML = d.cursos.filter((c) => c.papel !== "novos")
    .map((c) => `<span style="background:${corDe(c.tipoId)}" title="${escapeHtml(c.setor)} · captação ${ddmm(c.de)}–${ddmm(c.ate)}${c.turma ? ` · turma ${dataBr(c.turma)}` : ""}">${escapeHtml(curto(c))}</span>`).join("");
}

function renderPlano() {
  const d = estado.dados;
  const alvo = document.getElementById("fa-plano");
  const porTipo = new Map(d.cursos.map((c) => [c.tipoId, c]));
  if (!d.admin) {
    const v = d.vendedores[0];
    if (!v || !d.publicadoEm) { alvo.innerHTML = ""; return; }
    alvo.innerHTML = `<div class="fa-dia-vendedor">${d.datas.map((dt) => {
      const cel = d.celulas[`${v.id}|${dt}`];
      const c = cel && porTipo.get(cel.tipoId);
      const r = d.rotas[`${v.id}|${dt}`];
      return `<div class="fa-dia-card ${dt === d.hoje ? "fa-hoje" : ""}"><small>${diaSemana(dt)} ${dataBr(dt)}${dt === d.hoje ? " · hoje" : ""}${r ? ` · <a href="/prospeccao#rota?data=${dt}">abrir a rota ›</a>` : ""}</small>
        ${c ? `<span class="fa-chip" style="background:${corDe(c.tipoId)}">${escapeHtml(c.curso)}</span><small>${escapeHtml(c.setor)}${c.turma ? ` · turma ${dataBr(c.turma)}` : ""}</small>` : "<small>—</small>"}
        ${r ? `<small>obrigatórias ${inteiro(r.feitas)}/${inteiro(r.base)} · Extra ${inteiro(r.extraFeitas)}/${inteiro(r.extra)} · órgãos novos ${inteiro(r.novosFeitos)}/${inteiro(r.novos)}</small>` : ""}</div>`;
    }).join("")}</div>`;
    return;
  }
  const opcoes = d.cursos.filter((c) => c.papel !== "novos");
  const cab = `<tr><th class="fa-vend">Vendedor</th>${d.datas.map((dt) => `<th class="${dt === d.hoje ? "fa-hoje" : ""}">${diaSemana(dt)}<br>${ddmm(dt)}</th>`).join("")}</tr>`;
  const linhas = d.vendedores.map((v) => `<tr><td class="fa-vend">${escapeHtml(v.nome)}</td>${d.datas.map((dt) => {
    const cel = d.celulas[`${v.id}|${dt}`];
    const r = d.rotas[`${v.id}|${dt}`];
    const passou = dt <= d.hoje && r;
    const abertos = opcoes.filter((c) => c.papel !== "curso" ? c.de <= dt && dt <= c.ate : c.de <= dt && dt <= c.ate);
    const sel = `<select data-pessoa="${v.id}" data-data="${dt}" ${passou ? "disabled" : ""} style="background:${cel ? corDe(cel.tipoId) : ""};color:#0b0e17">
      ${cel ? "" : '<option value="">—</option>'}${(abertos.length ? abertos : opcoes).concat(cel && !abertos.some((c) => c.tipoId === cel.tipoId) ? [porTipo.get(cel.tipoId)] : [])
        .map((c) => `<option value="${c.tipoId}" ${cel?.tipoId === c.tipoId ? "selected" : ""}>${escapeHtml(curto(c))}</option>`).join("")}</select>`;
    return `<td class="fa-cel ${cel?.manual ? "fa-manual" : ""} ${dt === d.hoje ? "fa-hoje" : ""}" title="${cel ? escapeHtml(porTipo.get(cel.tipoId)?.curso || "") + (cel.manual ? " (ajustado à mão)" : "") : "sem curso"}">${sel}` +
      (r ? `<span class="fa-rota">${inteiro(r.feitas)}/${inteiro(r.base)} · N ${inteiro(r.novosFeitos)}/${inteiro(r.novos)}</span>` : "") + "</td>";
  }).join("")}</tr>`).join("");
  alvo.innerHTML = `<div class="fa-grade-wrap"><table class="fa-grade"><thead>${cab}</thead><tbody>${linhas}</tbody></table></div>`;
  document.getElementById("fa-rodape").textContent = "Cada célula mostra os cursos com captação aberta no dia. Borda tracejada = ajustada à mão (\"Gerar rascunho\" não a altera). " +
    "Embaixo da célula: rota gerada, com feitas/obrigatórias e órgãos novos feitos/oferecidos.";
}

document.addEventListener("change", async (ev) => {
  const s = ev.target;
  if (s.matches(".fa-grade select")) {
    try {
      const r = await chamarApi("/api/fim-de-ano/plano", json("PUT", { pessoaId: Number(s.dataset.pessoa), data: s.dataset.data, tipoId: Number(s.value) }));
      avisar(`${dataBr(r.data)}: ${r.curso}${r.refeita ? " (rota do dia refeita)" : ""}`);
      await carregar();
    } catch (e) { avisar("⚠ " + e.message); await carregar(); }
  }
  if (s.id === "fa-orgaos" && s.files[0]) {
    const f = s.files[0];
    const res = document.getElementById("fa-orgaos-res");
    res.textContent = "importando…";
    try {
      const r = await chamarApi(`/api/fim-de-ano/orgaos?arquivo=${encodeURIComponent(f.name)}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: await f.arrayBuffer() });
      res.textContent = `${inteiro(r.novos)} novo(s), ${inteiro(r.atualizados)} atualizado(s), ${inteiro(r.ignoradas.length)} ignorada(s) · ` +
        Object.entries(r.porVendedor).map(([n, v]) => `${n} ${v.orgaos}`).join(" · ") +
        ` · ${inteiro(r.comTelefone)} com telefone · ${inteiro(r.confirmar)} a confirmar` + (r.semMunicipio.length ? ` · ${r.semMunicipio.length} sem município casado (não atrapalha a rota)` : "");
      await carregar();
    } catch (e) { res.textContent = "⚠ " + e.message; }
    s.value = "";
  }
});

document.getElementById("fa-rascunho").addEventListener("click", async () => {
  try { const r = await chamarApi("/api/fim-de-ano/rascunho", { method: "POST" }); avisar(`Rascunho gerado: ${r.gravadas} célula(s).`); await carregar(); }
  catch (e) { avisar("⚠ " + e.message); }
});
document.getElementById("fa-publicar").addEventListener("click", async () => {
  if (!estado.confirmarPublicar) { estado.confirmarPublicar = true; renderAdmin(); setTimeout(() => { estado.confirmarPublicar = false; renderAdmin(); }, 8000); return; }
  estado.confirmarPublicar = false;
  try {
    const r = await chamarApi("/api/fim-de-ano/publicar", { method: "POST" });
    const g = (r.geracao || []).map((x) => `${dataBr(x.data)}: ${x.geradas} rota(s)${x.curtas?.length ? ` (curtas: ${x.curtas.join(", ")})` : ""}`).join(" · ");
    avisar(`Publicado: vale a partir de ${dataBr(r.vale)}. ${r.descartadas} rota(s) futura(s) refeita(s). ${g}`);
    await carregar();
  } catch (e) { avisar("⚠ " + e.message); renderAdmin(); }
});
document.getElementById("fa-refazer").addEventListener("click", async () => {
  const desde = document.getElementById("fa-refazer-data").value;
  const b = document.getElementById("fa-refazer");
  if (b.dataset.confirmar !== "1") {
    b.dataset.confirmar = "1"; b.textContent = `Confirmar: refazer ${desde ? "de " + dataBr(desde) : "de amanhã"} a 15/12`;
    setTimeout(() => { b.dataset.confirmar = ""; b.textContent = "↻ Refazer"; }, 8000);
    return;
  }
  b.dataset.confirmar = ""; b.textContent = "↻ Refazer";
  try {
    const r = await chamarApi("/api/fim-de-ano/refazer", json("POST", { desde: desde || undefined }));
    avisar(`Refeito a partir de ${dataBr(r.desde)}: ${r.descartadas} rota(s) descartada(s) e geradas de novo` +
      (r.mantidas.length ? `; ${r.mantidas.length} mantida(s) por já terem baixa` : "") + ".");
    await carregar();
  } catch (e) { avisar("⚠ " + e.message); }
});
document.getElementById("fa-cotas-ligar").addEventListener("click", async () => {
  try { estado.contador = await chamarApi("/api/fim-de-ano/contador", json("PUT", { cotas: !estado.contador?.cotasAtivas })); renderAdmin(); avisar(estado.contador.cotasAtivas ? "Cotas ligadas: cada vendedor vê a dele; a TV mostra todas." : "Cotas desligadas."); }
  catch (e) { avisar("⚠ " + e.message); }
});
document.getElementById("fa-contador-ligar").addEventListener("click", async () => {
  try { estado.contador = await chamarApi("/api/fim-de-ano/contador", json("PUT", { ativo: !estado.contador?.ativo })); renderAdmin(); avisar(estado.contador.ativo ? "Contador ligado: aparece no header de todas as telas e na TV." : "Contador desligado."); }
  catch (e) { avisar("⚠ " + e.message); }
});
document.getElementById("btn-sair").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }).catch(() => {}); location.href = "/login"; });

carregar().catch((e) => { document.getElementById("fa-intro").textContent = "⚠ " + e.message; });
