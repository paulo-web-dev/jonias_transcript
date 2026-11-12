"use strict";

// /marketing — área do marketing (migrações 39–40; marketing.js no servidor).
// Abas: E-mail marketing (Fase 1), Campanhas de ADS e Grupos de WhatsApp
// (Fase 2). A aba fica no hash (#emails | #ads | #whatsapp). Ações que marcam
// algo como feito pedem dois cliques (o 1º arma a confirmação por 5 s).
// Atrasado = vermelho com os dias, e não some; RETROATIVO (prazo anterior à
// ativação) e turma EXCLUÍDA ficam fora do indicador.

function escapeHtml(t) { const d = document.createElement("div"); d.textContent = t ?? ""; return d.innerHTML; }
async function chamarApi(url, opcoes = {}) {
  const r = await fetch(url, opcoes);
  if (r.status === 401) { location.href = "/login"; throw new Error("sessão expirada"); }
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.error || corpo.erro || `erro ${r.status}`);
  return corpo;
}
const json = (method, corpo) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo ?? {}) });
const dataBr = (s) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "");
const ddmm = (s) => dataBr(s).slice(0, 5);
const diaSemana = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" }).replace(".", "");
const dataHoraBr = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const diaBr = (iso) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "");
const reais = (c) => "R$ " + ((c || 0) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const decimal = (n) => String(n).replace(".", ",");
function avisar(texto, erro = false) {
  const el = document.getElementById("aviso");
  el.textContent = texto; el.classList.toggle("aviso-erro", erro); el.classList.add("visivel");
  clearTimeout(avisar.t); avisar.t = setTimeout(() => el.classList.remove("visivel"), 6000);
}
const card = (rotulo, valor, extra, classe = "") =>
  `<div class="metrica-card ${classe}"><span class="metrica-rotulo">${rotulo}</span><span class="metrica-valor">${valor}</span><span class="metrica-extra">${extra}</span></div>`;

const estado = {
  aba: "emails", admin: false, confirmando: null,
  emails: null, visao: "pendencias", excluindo: null,
  ads: null, adsForm: null, // {setor, modo: "nova" | "editar"}
  wa: null,
};

// Confirmação em dois cliques: chave = string única da ação
function armar(chave) {
  if (estado.confirmando === chave) { estado.confirmando = null; clearTimeout(estado.tConf); return true; }
  estado.confirmando = chave;
  clearTimeout(estado.tConf); estado.tConf = setTimeout(() => { estado.confirmando = null; renderAba(); }, 5000);
  renderAba();
  return false;
}
const armado = (chave) => estado.confirmando === chave;

// =============================== E-MAIL ===============================

const PESO = { atrasado: 0, vence_hoje: 1, no_prazo: 2 };

function selo(x) {
  if (x.situacao === "excluida") return `<span class="mk-selo mk-retro" title="${escapeHtml(x.excluida?.motivo || "")}">turma excluída do e-mail</span>`;
  if (x.situacao === "enviado") {
    if (x.retroativo) return `<span class="mk-selo mk-retro">enviado · retroativo</span>`;
    return x.atrasoDias > 0
      ? `<span class="mk-selo mk-atraso">enviado com ${plural(x.atrasoDias, "dia", "dias")} de atraso</span>`
      : `<span class="mk-selo mk-ok">✓ no prazo</span>`;
  }
  if (x.situacao === "nao_enviado") {
    const motivo = x.encerrada === "cancelada" ? "turma cancelada" : "turma começou";
    return `<span class="mk-selo ${x.retroativo ? "mk-retro" : "mk-atraso"}">não enviado · ${motivo}${x.retroativo ? " · retroativo" : ""}</span>`;
  }
  if (x.retroativo) return `<span class="mk-selo mk-retro" title="O prazo venceu antes de o jonIAs controlar os e-mails (${dataBr(estado.emails.config.ativadoEm)}). Ainda precisa ser enviado, mas não conta como atraso.">retroativo · venceu ${ddmm(x.prazo)}</span>`;
  if (x.situacao === "atrasado") return `<span class="mk-selo mk-atraso">${plural(x.atrasoDias, "dia", "dias")} de atraso${x.nasceuAtrasado ? " · nasceu atrasado" : ""}</span>`;
  if (x.situacao === "vence_hoje") return `<span class="mk-selo mk-hoje">vence hoje${x.nasceuAtrasado ? " · nasceu atrasado" : ""}</span>`;
  return `<span class="mk-selo mk-prazo">vence em ${plural(x.venceEmDias, "dia", "dias")}</span>`;
}

function botaoEnvio(x) {
  if (x.situacao === "enviado") {
    const info = `<span class="texto-suave">${escapeHtml(dataHoraBr(x.enviadoEm))}${x.enviadoPor ? ` · ${escapeHtml(x.enviadoPor)}` : ""}</span>`;
    const k = `desfazer:${x.id}`;
    return info + (estado.admin ? ` <button type="button" class="btn-mini ${armado(k) ? "btn-primario" : ""}" data-desfazer="${x.id}" title="só admin; fica registrado">${armado(k) ? "confirmar desfazer" : "desfazer"}</button>` : "");
  }
  if (x.situacao === "nao_enviado" || x.situacao === "excluida") return "";
  const k = `enviar:${x.id}`;
  return `<button type="button" class="btn-mini ${armado(k) ? "btn-primario" : ""}" data-enviar="${x.id}">${armado(k) ? "Confirmar: enviei agora" : "✓ Enviado"}</button>`;
}

const linhaTurma = (x) => `<strong>${escapeHtml(x.turma)}</strong>${x.subtitulo ? `<br><small class="texto-suave">${escapeHtml(x.subtitulo)}</small>` : ""}`;
const prevDia = (d) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

function renderEmails() {
  const d = estado.emails;
  if (!d) return;
  const { resumo: r, config: c, hoje } = d;
  document.getElementById("mk-intro").innerHTML =
    `Hoje ${dataBr(hoje)} · 3 envios por turma futura (só turmas Unyflex = 0), gerados das turmas sincronizadas da Unyflex. ` +
    `Regra de hoje: <strong>${c.regraHoje.join("/")}</strong> dias antes da turma (${c.regraAntes.join("/")} até ${dataBr(prevDia(c.virada))}, ${c.regraDepois.join("/")} desde ${dataBr(c.virada)}). ` +
    `Prazo em fim de semana ou feriado = dia útil anterior. Controle desde ${dataBr(c.ativadoEm)}.`;
  document.getElementById("mk-resumo").innerHTML = [
    card("Atrasados", r.pendentesAtrasados, r.pendentesAtrasados ? `maior atraso: ${plural(r.maiorAtraso, "dia", "dias")}` : "nenhum ✓", r.pendentesAtrasados ? "mk-card-vermelho" : "mk-card-verde"),
    card("Vencem hoje", r.venceHoje, `${r.proximos7} nos próximos 7 dias`, r.venceHoje ? "mk-card-amarelo" : ""),
    card("Enviados", r.enviados, r.enviados ? `${r.enviadosNoPrazo} no prazo · ${r.enviadosComAtraso} com atraso · média ${decimal(r.atrasoMedioEnviados)} d` : "nenhum ainda"),
    card("Não enviados", r.naoEnviados, "turma começou ou foi cancelada sem o envio", r.naoEnviados ? "mk-card-vermelho" : ""),
    card("Retroativos", r.retroativos.pendentes, `pendentes de ${r.retroativos.total} · prazo vencido antes do sistema — fora do indicador`, "mk-card-retro"),
  ].join("");
  document.querySelectorAll(".mk-filtro [data-visao]").forEach((b) => b.classList.toggle("ativo", b.dataset.visao === estado.visao));
  document.getElementById("mk-legenda").textContent = estado.visao === "pendencias"
    ? "Atrasado continua cobrando até ser enviado ou a turma começar. O atraso é contado em dias corridos."
    : "Todas as turmas com envio gerado, inclusive canceladas, excluídas e já realizadas." + (estado.admin ? " Turma que não deve gerar e-mail (assinatura, por exemplo): \"excluir do e-mail\"." : "");
  document.getElementById("mk-lista").innerHTML = estado.visao === "pendencias" ? renderPendencias() : renderTurmas();
  document.getElementById("mk-excluidas").innerHTML = renderExcluidas();
  document.getElementById("mk-admin").classList.toggle("oculto", !estado.admin);
}

function renderPendencias() {
  const abertos = estado.emails.envios.filter((x) => !["enviado", "nao_enviado", "excluida"].includes(x.situacao));
  const oficiais = abertos.filter((x) => !x.retroativo).sort((a, b) =>
    PESO[a.situacao] - PESO[b.situacao] || (b.atrasoDias || 0) - (a.atrasoDias || 0) || a.prazo.localeCompare(b.prazo) || a.ordem - b.ordem);
  const retro = abertos.filter((x) => x.retroativo).sort((a, b) => a.inicio.localeCompare(b.inicio) || a.ordem - b.ordem);
  const linha = (x) => `<tr class="mk-linha mk-l-${x.retroativo ? "retro" : x.situacao}">
      <td>${selo(x)}</td><td><strong>${x.ordem}.</strong> ${escapeHtml(x.envio)}<br><small class="texto-suave">${x.antecedencia} dias antes</small></td>
      <td style="text-align:left">${linhaTurma(x)}</td>
      <td>${diaSemana(x.inicio)} ${ddmm(x.inicio)}</td><td>${diaSemana(x.prazo)} ${ddmm(x.prazo)}</td>
      <td style="text-align:left">${botaoEnvio(x)}</td></tr>`;
  const cab = `<thead><tr><th>Situação</th><th>Envio</th><th style="text-align:left">Turma</th><th>Turma em</th><th>Prazo</th><th></th></tr></thead>`;
  let html = oficiais.length
    ? `<div class="tabela-scroll"><table class="tabela-metricas mk-tabela">${cab}<tbody>${oficiais.map(linha).join("")}</tbody></table></div>`
    : `<p class="mk-vazio">✓ Nenhum envio pendente no indicador.</p>`;
  if (retro.length) {
    html += `<h3 class="secao-titulo">Retroativos — prazo vencido antes de ${dataBr(estado.emails.config.ativadoEm)} (${retro.length})</h3>
      <p class="texto-suave">A turma ainda vai acontecer, então o envio ainda precisa sair — mas não conta como atraso. Marque assim que enviar (ou se já tinha enviado antes do sistema).</p>
      <div class="tabela-scroll"><table class="tabela-metricas mk-tabela">${cab}<tbody>${retro.map(linha).join("")}</tbody></table></div>`;
  }
  return html;
}

function acaoExcluir(turmaId) {
  if (!estado.admin) return "";
  if (estado.excluindo === turmaId) {
    return `<div class="mk-excluir-form"><input type="text" class="campo-select" id="mk-excluir-motivo" placeholder="motivo (ex.: assinatura recorrente)" maxlength="200" />
      <button type="button" class="btn-mini btn-primario" data-excluir-confirmar="${turmaId}">Excluir do e-mail</button>
      <button type="button" class="btn-mini" data-excluir-cancelar>cancelar</button></div>`;
  }
  return `<br><button type="button" class="btn-mini mk-link" data-excluir="${turmaId}">excluir do e-mail</button>`;
}

function renderTurmas() {
  const porTurma = new Map();
  for (const x of estado.emails.envios) {
    if (!porTurma.has(x.turmaId)) porTurma.set(x.turmaId, []);
    porTurma.get(x.turmaId).push(x);
  }
  const grupos = [...porTurma.values()].sort((a, b) => b[0].inicio.localeCompare(a[0].inicio));
  if (!grupos.length) return `<p class="mk-vazio">Nenhuma turma futura com envio gerado ainda — sincronize a Unyflex.</p>`;
  return `<div class="tabela-scroll"><table class="tabela-metricas mk-tabela mk-historico"><thead><tr><th style="text-align:left">Turma</th>
    <th>Turma em</th><th>1. Divulgação inicial</th><th>2. Intermediário</th><th>3. Últimas vagas</th></tr></thead><tbody>` +
    grupos.map((g) => {
      const t = g[0];
      const enc = t.excluida ? ` <span class="mk-selo mk-retro">excluída</span>`
        : t.encerrada === "cancelada" ? ` <span class="mk-selo mk-retro">cancelada</span>`
        : t.encerrada === "aconteceu" ? ` <span class="mk-selo mk-prazo">já aconteceu</span>` : "";
      const acao = t.excluida
        ? (estado.admin ? `<br><button type="button" class="btn-mini mk-link" data-reincluir="${t.turmaId}">reincluir no e-mail</button>` : "")
        : t.encerrada ? "" : acaoExcluir(t.turmaId);
      const cel = (o) => {
        const x = g.find((e) => e.ordem === o);
        if (!x) return "<td>—</td>";
        return `<td class="mk-celula"><small class="texto-suave">prazo ${ddmm(x.prazo)} (${x.antecedencia} d)</small><br>${selo(x)}<br>${botaoEnvio(x)}</td>`;
      };
      return `<tr class="sem-clique ${t.excluida ? "mk-l-retro" : ""}"><td style="text-align:left">${linhaTurma(t)}${enc}${acao}</td><td>${diaSemana(t.inicio)} ${dataBr(t.inicio)}</td>${cel(1)}${cel(2)}${cel(3)}</tr>`;
    }).join("") + `</tbody></table></div>`;
}

function renderExcluidas() {
  const lista = estado.emails.excluidas || [];
  if (!lista.length) return "";
  return `<h3 class="secao-titulo">Turmas excluídas do e-mail (${lista.length}) — fora das pendências e do indicador</h3>
    <div class="tabela-scroll"><table class="tabela-metricas mk-tabela"><thead><tr><th style="text-align:left">Turma</th><th>Turma em</th><th style="text-align:left">Motivo</th><th>Excluída em</th><th></th></tr></thead><tbody>` +
    lista.map((x) => `<tr class="sem-clique"><td style="text-align:left">${linhaTurma({ turma: x.turma, subtitulo: x.subtitulo })}</td><td>${dataBr(x.inicio)}</td>
      <td style="text-align:left">${escapeHtml(x.motivo || "—")}</td><td class="texto-suave">${escapeHtml(dataHoraBr(x.em))}${x.usuario ? ` · ${escapeHtml(x.usuario)}` : ""}</td>
      <td style="text-align:left">${estado.admin ? `<button type="button" class="btn-mini" data-reincluir="${x.turmaId}">reincluir</button>` : ""}</td></tr>`).join("") +
    `</tbody></table></div>`;
}

async function carregarEmails() {
  try {
    estado.emails = await chamarApi("/api/marketing/emails");
    document.getElementById("mk-virada").value = estado.emails.config.virada;
    const r = estado.emails.resumo;
    document.getElementById("alerta-emails").textContent = r.pendentesAtrasados ? r.pendentesAtrasados : "";
  } catch (e) { document.getElementById("mk-intro").textContent = "⚠ " + e.message; }
}

document.getElementById("aba-emails").addEventListener("click", async (ev) => {
  const alvo = (sel) => ev.target.closest(sel);
  let b;
  if ((b = alvo("[data-visao]"))) { estado.visao = b.dataset.visao; renderEmails(); return; }
  if ((b = alvo("[data-enviar]"))) {
    const id = Number(b.dataset.enviar);
    if (!armar(`enviar:${id}`)) return;
    b.disabled = true;
    try {
      const { envio } = await chamarApi(`/api/marketing/emails/${id}/enviado`, json("POST"));
      avisar(`✓ "${envio.envio}" de ${envio.turma} marcado como enviado` + (envio.atrasoDias && !envio.retroativo ? ` — ${plural(envio.atrasoDias, "dia", "dias")} de atraso.` : "."));
    } catch (e) { avisar("⚠ " + e.message, true); }
    await carregarEmails(); renderEmails();
    return;
  }
  if ((b = alvo("[data-desfazer]"))) {
    const id = Number(b.dataset.desfazer);
    if (!armar(`desfazer:${id}`)) return;
    try {
      await chamarApi(`/api/marketing/emails/${id}/enviado`, json("DELETE", { observacao: "desfeito na tela /marketing" }));
      avisar("Check desfeito (registrado no histórico do envio).");
    } catch (e) { avisar("⚠ " + e.message, true); }
    await carregarEmails(); renderEmails();
    return;
  }
  if ((b = alvo("[data-excluir]"))) { estado.excluindo = Number(b.dataset.excluir); renderEmails(); document.getElementById("mk-excluir-motivo")?.focus(); return; }
  if (alvo("[data-excluir-cancelar]")) { estado.excluindo = null; renderEmails(); return; }
  if ((b = alvo("[data-excluir-confirmar]"))) {
    const id = Number(b.dataset.excluirConfirmar);
    try {
      const r = await chamarApi(`/api/marketing/turmas/${id}/excluir`, json("POST", { motivo: document.getElementById("mk-excluir-motivo")?.value }));
      avisar(`"${r.turma}" excluída do e-mail marketing — fora das pendências e do indicador.`);
      estado.excluindo = null;
    } catch (e) { avisar("⚠ " + e.message, true); }
    await carregarEmails(); renderEmails();
    return;
  }
  if ((b = alvo("[data-reincluir]"))) {
    const id = Number(b.dataset.reincluir);
    if (!armar(`reincluir:${id}`)) { const nb = document.querySelector(`[data-reincluir="${id}"]`); if (nb) { nb.textContent = "confirmar reincluir"; nb.classList.add("btn-primario"); } return; }
    try {
      const r = await chamarApi(`/api/marketing/turmas/${id}/excluir`, json("DELETE"));
      avisar("Turma reincluída no e-mail marketing" + (r.envios ? ` — ${r.envios} envio(s) gerado(s) agora.` : "."));
    } catch (e) { avisar("⚠ " + e.message, true); }
    await carregarEmails(); renderEmails();
  }
});

document.getElementById("mk-virada-salvar").addEventListener("click", async () => {
  try {
    await chamarApi("/api/marketing/config", json("PUT", { virada: document.getElementById("mk-virada").value }));
    avisar("Data de virada salva.");
    await carregarEmails(); renderEmails();
  } catch (e) { avisar("⚠ " + e.message, true); }
});

// =============================== ADS ===============================

const SITUACAO_ADS = {
  ok: ["mk-ok", "✓ ativa"],
  vazio: ["mk-atraso", "SLOT VAZIO"],
  curso_passou: ["mk-atraso", "curso já aconteceu — troque"],
  turma_cancelada: ["mk-atraso", "turma cancelada na origem — troque"],
};

function formAds(s) {
  const editar = estado.adsForm.modo === "editar";
  const a = s.ativa;
  const opcoes = estado.ads.turmas.map((t) => `<option value="${t.id}" data-inicio="${t.inicio}">${escapeHtml(t.nome)}${t.subtitulo ? ` — ${escapeHtml(t.subtitulo)}` : ""} (${dataBr(t.inicio)})</option>`).join("");
  return `<div class="mk-ads-form" data-setor="${s.setor}">
    ${editar ? `<p class="texto-suave">Ajuste da campanha ativa (o curso não muda — para trocar, use "trocar curso").</p>`
      : `<label>Turma <select class="campo-select" name="turmaId"><option value="">escolha…</option>${opcoes}</select></label>`}
    <label>Início da campanha <input type="date" class="campo-select" name="inicio" value="${editar ? a.inicio : estado.ads.hoje}" /></label>
    <label>Data do curso <input type="date" class="campo-select" name="dataCurso" value="${editar ? a.dataCurso : ""}" /></label>
    <label>Orçamento diário (R$) <input type="text" inputmode="decimal" class="campo-select" name="orcamentoDiario" value="${editar ? decimal((a.orcamentoDiarioCentavos / 100).toFixed(2)) : ""}" placeholder="0,00" /></label>
    ${!editar && a ? `<p class="texto-suave">A campanha atual (${escapeHtml(a.turma)}) será encerrada hoje e vai para o histórico.</p>` : ""}
    <div class="mk-controles"><button type="button" class="btn-mini btn-primario" data-ads-salvar="${s.setor}">Salvar</button>
      <button type="button" class="btn-mini" data-ads-cancelar>cancelar</button></div>
  </div>`;
}

function renderAds() {
  const d = estado.ads;
  if (!d) return;
  const todosOk = d.ativos === d.totalSlots;
  document.getElementById("ads-topo").innerHTML = `
    <div class="mk-ads-placar ${todosOk ? "mk-ok-texto" : "mk-vermelho-texto"}"><strong>${d.ativos}</strong> de ${d.totalSlots} slots ativos</div>
    <div class="mk-ads-total">Orçamento diário total: <strong>${reais(d.orcamentoDiarioTotalCentavos)}</strong></div>
    <div class="texto-suave">Sempre 5 campanhas ativas, uma por setor. Slot vazio ou com o curso já realizado é alerta vermelho.</div>`;
  document.getElementById("ads-slots").innerHTML = d.setores.map((s) => {
    const [classe, rotulo] = SITUACAO_ADS[s.situacao];
    const a = s.ativa;
    const aberto = estado.adsForm?.setor === s.setor;
    const k = `encerrar:${s.setor}`;
    return `<article class="mk-ads-slot ${s.situacao === "ok" ? "" : "mk-ads-alerta"}">
      <header><h3>${escapeHtml(s.nome)}</h3><span class="mk-selo ${classe}">${rotulo}</span></header>
      ${a ? `<div class="mk-ads-turma">${linhaTurma(a)}</div>
        <dl class="mk-ads-dados"><dt>Campanha desde</dt><dd>${dataBr(a.inicio)} (${plural(a.dias, "dia", "dias")})</dd>
          <dt>Curso em</dt><dd>${dataBr(a.dataCurso)}</dd><dt>Orçamento/dia</dt><dd>${reais(a.orcamentoDiarioCentavos)}</dd></dl>`
        : `<p class="mk-ads-vazio">Nenhuma campanha neste setor.</p>`}
      ${aberto ? formAds(s) : `<div class="mk-controles">
        <button type="button" class="btn-mini ${a ? "" : "btn-primario"}" data-ads-nova="${s.setor}">${a ? "trocar curso" : "+ nova campanha"}</button>
        ${a ? `<button type="button" class="btn-mini" data-ads-editar="${s.setor}">editar</button>
          <button type="button" class="btn-mini ${armado(k) ? "btn-primario" : ""}" data-ads-encerrar="${s.setor}">${armado(k) ? "confirmar: deixar vazio" : "encerrar"}</button>` : ""}
      </div>`}
    </article>`;
  }).join("");
  const hist = d.setores.flatMap((s) => [...(s.ativa ? [s.ativa] : []), ...s.historico].map((c) => ({ ...c, setorNome: s.nome })));
  document.getElementById("ads-historico").innerHTML = hist.length
    ? `<div class="tabela-scroll"><table class="tabela-metricas mk-tabela"><thead><tr><th style="text-align:left">Setor</th><th style="text-align:left">Turma</th>
        <th>Curso em</th><th>Campanha</th><th>Orçamento/dia</th><th style="text-align:left">Fim</th></tr></thead><tbody>` +
      hist.map((c) => `<tr class="sem-clique"><td style="text-align:left">${escapeHtml(c.setorNome)}</td><td style="text-align:left">${linhaTurma(c)}</td>
        <td>${dataBr(c.dataCurso)}</td><td>${dataBr(c.inicio)} → ${c.encerradaEm ? diaBr(c.encerradaEm) : "hoje"} (${plural(c.dias, "dia", "dias")})</td>
        <td>${reais(c.orcamentoDiarioCentavos)}</td>
        <td style="text-align:left">${c.encerradaEm ? `<span class="texto-suave">${escapeHtml(c.motivoFim || "")}${c.encerradaPor ? ` · ${escapeHtml(c.encerradaPor)}` : ""}</span>` : `<span class="mk-selo mk-ok">ativa</span>`}</td></tr>`).join("") +
      `</tbody></table></div>`
    : `<p class="texto-suave">Nenhuma campanha registrada ainda.</p>`;
}

async function carregarAds() {
  try {
    estado.ads = await chamarApi("/api/marketing/ads");
    const faltam = estado.ads.totalSlots - estado.ads.ativos;
    document.getElementById("alerta-ads").textContent = faltam ? faltam : "";
  } catch (e) { document.getElementById("ads-topo").textContent = "⚠ " + e.message; }
}

document.getElementById("aba-ads").addEventListener("click", async (ev) => {
  const alvo = (sel) => ev.target.closest(sel);
  let b;
  if ((b = alvo("[data-ads-nova]"))) { estado.adsForm = { setor: b.dataset.adsNova, modo: "nova" }; renderAds(); return; }
  if ((b = alvo("[data-ads-editar]"))) { estado.adsForm = { setor: b.dataset.adsEditar, modo: "editar" }; renderAds(); return; }
  if (alvo("[data-ads-cancelar]")) { estado.adsForm = null; renderAds(); return; }
  if ((b = alvo("[data-ads-encerrar]"))) {
    const setor = b.dataset.adsEncerrar;
    if (!armar(`encerrar:${setor}`)) return;
    try { await chamarApi(`/api/marketing/ads/${setor}/encerrar`, json("POST", {})); avisar("Campanha encerrada — o slot ficou vazio."); }
    catch (e) { avisar("⚠ " + e.message, true); }
    await carregarAds(); renderAds();
    return;
  }
  if ((b = alvo("[data-ads-salvar]"))) {
    const setor = b.dataset.adsSalvar;
    const form = b.closest(".mk-ads-form");
    const corpo = Object.fromEntries([...form.querySelectorAll("[name]")].map((i) => [i.name, i.value]));
    const editar = estado.adsForm.modo === "editar";
    try {
      await chamarApi(`/api/marketing/ads/${setor}`, json(editar ? "PATCH" : "PUT", corpo));
      avisar(editar ? "Campanha atualizada." : "Campanha registrada no slot.");
      estado.adsForm = null;
    } catch (e) { avisar("⚠ " + e.message, true); return; }
    await carregarAds(); renderAds();
  }
});
// Escolher a turma preenche a data do curso (editável)
document.getElementById("aba-ads").addEventListener("change", (ev) => {
  if (ev.target.name !== "turmaId") return;
  const inicio = ev.target.selectedOptions[0]?.dataset.inicio;
  const campo = ev.target.closest(".mk-ads-form").querySelector('[name="dataCurso"]');
  if (inicio) campo.value = inicio;
});

// =============================== WHATSAPP ===============================

function seloWa(w) {
  if (w.situacao === "feito") return w.atrasoDias > 0 ? `<span class="mk-selo mk-atraso">feito com ${plural(w.atrasoDias, "dia", "dias")} de atraso</span>` : `<span class="mk-selo mk-ok">✓ feito no dia</span>`;
  if (w.situacao === "nao_feito") return `<span class="mk-selo mk-atraso">NÃO FEITO</span>`;
  if (w.situacao === "atrasado") return `<span class="mk-selo mk-atraso">${plural(w.atrasoDias, "dia", "dias")} de atraso</span>`;
  if (w.situacao === "hoje") return `<span class="mk-selo mk-hoje">é hoje</span>`;
  return `<span class="mk-selo mk-prazo">vence ${diaSemana(w.devido)} ${ddmm(w.devido)}</span>`;
}

function renderWhatsapp() {
  const d = estado.wa;
  if (!d) return;
  const a = d.atual;
  const k = "wa:check";
  let atual;
  if (!a) {
    atual = `<h2>Grupos de WhatsApp</h2><p class="texto-suave">O controle começa na semana de ${dataBr(d.proximaSemana?.semana)} — check devido ${d.proximaSemana?.devido ? `${diaSemana(d.proximaSemana.devido)} ${dataBr(d.proximaSemana.devido)}` : "—"}.</p>`;
  } else if (a.situacao === "feito") {
    atual = `<h2>Semana de ${dataBr(a.semana)}</h2>${seloWa(a)}
      <p class="texto-suave">Check em ${escapeHtml(dataHoraBr(a.feitoEm))}${a.feitoPor ? ` por ${escapeHtml(a.feitoPor)}` : ""}${a.observacao ? ` — ${escapeHtml(a.observacao)}` : ""}.</p>
      ${estado.admin ? `<button type="button" class="btn-mini ${armado("wa:desfazer") ? "btn-primario" : ""}" data-wa-desfazer="${a.semana}">${armado("wa:desfazer") ? "confirmar desfazer" : "desfazer (admin)"}</button>` : ""}`;
  } else {
    atual = `<h2>Semana de ${dataBr(a.semana)} — check devido ${diaSemana(a.devido)} ${dataBr(a.devido)}</h2>${seloWa(a)}
      <p>Mandar os cursos do setor nos grupos pertinentes. Um check por semana.</p>
      <div class="mk-controles"><input type="text" class="campo-select mk-wa-obs" id="wa-obs" placeholder="observação (opcional)" maxlength="300" />
        <button type="button" class="btn-mini ${armado(k) ? "btn-primario" : ""}" data-wa-check>${armado(k) ? "Confirmar: mandei agora" : "✓ Mandei os cursos nos grupos"}</button></div>`;
  }
  const el = document.getElementById("wa-atual");
  el.className = `mk-wa-atual ${a?.situacao === "atrasado" ? "mk-ads-alerta" : ""} ${a?.situacao === "feito" ? "mk-wa-feito" : ""}`;
  const obs = document.getElementById("wa-obs")?.value || "";
  el.innerHTML = atual;
  if (document.getElementById("wa-obs")) document.getElementById("wa-obs").value = obs;
  const r = d.resumo;
  document.getElementById("wa-resumo").innerHTML = [
    card("Semanas cobradas", r.semanas, `desde ${dataBr(d.desde)}`),
    card("Feitas no dia", r.noDia, r.feitas ? `de ${r.feitas} feitas` : "—", r.noDia ? "mk-card-verde" : ""),
    card("Feitas com atraso", r.comAtraso, r.atrasoMedio !== null ? `atraso médio ${decimal(r.atrasoMedio)} d` : "—", r.comAtraso ? "mk-card-amarelo" : ""),
    card("Não feitas", r.naoFeitas, "semana passou sem check", r.naoFeitas ? "mk-card-vermelho" : "mk-card-verde"),
  ].join("");
  document.getElementById("wa-historico").innerHTML = d.semanas.length
    ? `<div class="tabela-scroll"><table class="tabela-metricas mk-tabela"><thead><tr><th style="text-align:left">Semana</th><th>Devido</th><th>Situação</th><th style="text-align:left">Check</th></tr></thead><tbody>` +
      d.semanas.map((w) => `<tr class="sem-clique mk-l-${w.situacao === "nao_feito" ? "atrasado" : w.situacao}"><td style="text-align:left">${dataBr(w.semana)}${w.atual ? " <small class=\"texto-suave\">(esta semana)</small>" : ""}</td>
        <td>${diaSemana(w.devido)} ${ddmm(w.devido)}</td><td>${seloWa(w)}</td>
        <td style="text-align:left" class="texto-suave">${w.feitoEm ? `${escapeHtml(dataHoraBr(w.feitoEm))}${w.feitoPor ? ` · ${escapeHtml(w.feitoPor)}` : ""}${w.observacao ? ` — ${escapeHtml(w.observacao)}` : ""}` : ""}</td></tr>`).join("") +
      `</tbody></table></div>`
    : `<p class="texto-suave">Nenhuma semana cobrada ainda.</p>`;
}

async function carregarWhatsapp() {
  try {
    estado.wa = await chamarApi("/api/marketing/whatsapp");
    const s = estado.wa.atual?.situacao;
    document.getElementById("alerta-whatsapp").textContent = s === "atrasado" || s === "hoje" ? "!" : "";
  } catch (e) { document.getElementById("wa-atual").textContent = "⚠ " + e.message; }
}

document.getElementById("aba-whatsapp").addEventListener("click", async (ev) => {
  if (ev.target.closest("[data-wa-check]")) {
    if (!armar("wa:check")) return;
    try {
      estado.wa = await chamarApi("/api/marketing/whatsapp", json("POST", { observacao: document.getElementById("wa-obs")?.value }));
      const a = estado.wa.atual;
      avisar("✓ Check da semana registrado" + (a?.atrasoDias ? ` — ${plural(a.atrasoDias, "dia", "dias")} de atraso.` : " no dia."));
    } catch (e) { avisar("⚠ " + e.message, true); }
    await carregarWhatsapp(); renderWhatsapp();
    return;
  }
  const b = ev.target.closest("[data-wa-desfazer]");
  if (b) {
    if (!armar("wa:desfazer")) return;
    try { await chamarApi(`/api/marketing/whatsapp/${b.dataset.waDesfazer}`, json("DELETE")); avisar("Check da semana desfeito (fica na trilha)."); }
    catch (e) { avisar("⚠ " + e.message, true); }
    await carregarWhatsapp(); renderWhatsapp();
  }
});

// =============================== ABAS ===============================

const RENDER = { emails: renderEmails, ads: renderAds, whatsapp: renderWhatsapp };
function renderAba() { RENDER[estado.aba]?.(); }

function mostrarAba(aba) {
  if (!RENDER[aba]) aba = "emails";
  estado.aba = aba;
  document.querySelectorAll(".mk-aba[data-aba]").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === aba));
  for (const a of Object.keys(RENDER)) document.getElementById(`aba-${a}`).classList.toggle("oculto", a !== aba);
  if (location.hash !== `#${aba}`) history.replaceState(null, "", `#${aba}`);
  renderAba();
}
document.querySelector(".mk-abas").addEventListener("click", (ev) => {
  const b = ev.target.closest(".mk-aba[data-aba]");
  if (b && !b.disabled) mostrarAba(b.dataset.aba);
});

function aplicarSessao(sessao) {
  estado.admin = sessao.papel === "admin";
  renderAba();
}
document.addEventListener("sessao-pronta", (ev) => aplicarSessao(ev.detail));
if (window.SESSAO) aplicarSessao(window.SESSAO);

document.getElementById("btn-sair").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }).catch(() => {}); location.href = "/login"; });

async function carregarTudo() {
  await Promise.all([carregarEmails(), carregarAds(), carregarWhatsapp()]);
  renderAba();
}
mostrarAba(location.hash.slice(1));
carregarTudo();
// A virada do dia muda prazos e atrasos; não recarrega no meio de uma confirmação ou formulário
setInterval(() => { if (!estado.confirmando && !estado.adsForm && estado.excluindo === null) carregarTudo(); }, 5 * 60 * 1000);
