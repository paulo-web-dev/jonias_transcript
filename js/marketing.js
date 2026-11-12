"use strict";

// /marketing — área do marketing (migração 39; marketing.js no servidor).
// Fase 1: e-mail marketing do Gustavo. O sistema gera 3 envios por turma
// futura; aqui ele só dá o check quando envia (dois cliques: o 1º pede
// confirmação). Atrasado = vermelho com os dias e não some; RETROATIVO (prazo
// anterior à ativação do sistema) aparece à parte, fora do indicador.

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
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
function avisar(texto, erro = false) {
  const el = document.getElementById("aviso");
  el.textContent = texto; el.classList.toggle("aviso-erro", erro); el.classList.add("visivel");
  clearTimeout(avisar.t); avisar.t = setTimeout(() => el.classList.remove("visivel"), 6000);
}

const estado = { dados: null, visao: "pendencias", confirmando: null, admin: false };

// Ordem das pendências: atrasados (maior atraso primeiro), vence hoje, no
// prazo (prazo mais próximo) e os retroativos por último, à parte.
const PESO = { atrasado: 0, vence_hoje: 1, no_prazo: 2 };

function selo(x) {
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
  if (x.retroativo) return `<span class="mk-selo mk-retro" title="O prazo venceu antes de o jonIAs controlar os e-mails (${dataBr(estado.dados.config.ativadoEm)}). Ainda precisa ser enviado, mas não conta como atraso.">retroativo · venceu ${ddmm(x.prazo)}</span>`;
  if (x.situacao === "atrasado") return `<span class="mk-selo mk-atraso">${plural(x.atrasoDias, "dia", "dias")} de atraso${x.nasceuAtrasado ? " · nasceu atrasado" : ""}</span>`;
  if (x.situacao === "vence_hoje") return `<span class="mk-selo mk-hoje">vence hoje${x.nasceuAtrasado ? " · nasceu atrasado" : ""}</span>`;
  return `<span class="mk-selo mk-prazo">vence em ${plural(x.venceEmDias, "dia", "dias")}</span>`;
}

function botao(x) {
  if (x.situacao === "enviado") {
    const info = `<span class="texto-suave">${escapeHtml(dataHoraBr(x.enviadoEm))}${x.enviadoPor ? ` · ${escapeHtml(x.enviadoPor)}` : ""}</span>`;
    return info + (estado.admin ? ` <button type="button" class="btn-mini" data-desfazer="${x.id}" title="só admin; fica registrado">desfazer</button>` : "");
  }
  if (x.situacao === "nao_enviado") return "";
  const conf = estado.confirmando === x.id;
  return `<button type="button" class="btn-mini ${conf ? "btn-primario" : ""}" data-enviar="${x.id}">${conf ? "Confirmar: enviei agora" : "✓ Enviado"}</button>`;
}

function linhaTurma(x) {
  return `<strong>${escapeHtml(x.turma)}</strong>${x.subtitulo ? `<br><small class="texto-suave">${escapeHtml(x.subtitulo)}</small>` : ""}`;
}

function renderResumo() {
  const { resumo: r, config: c, hoje } = estado.dados;
  document.getElementById("mk-intro").innerHTML =
    `Hoje ${dataBr(hoje)} · 3 envios por turma futura (só turmas Unyflex = 0), gerados das turmas sincronizadas da Unyflex. ` +
    `Regra de hoje: <strong>${c.regraHoje.join("/")}</strong> dias antes da turma (${c.regraAntes.join("/")} até ${dataBr(prevDia(c.virada))}, ${c.regraDepois.join("/")} desde ${dataBr(c.virada)}). ` +
    `Prazo em fim de semana ou feriado = dia útil anterior. Controle desde ${dataBr(c.ativadoEm)}.`;
  const card = (rotulo, valor, extra, classe = "") =>
    `<div class="metrica-card ${classe}"><span class="metrica-rotulo">${rotulo}</span><span class="metrica-valor">${valor}</span><span class="metrica-extra">${extra}</span></div>`;
  document.getElementById("mk-resumo").innerHTML = [
    card("Atrasados", r.pendentesAtrasados, r.pendentesAtrasados ? `maior atraso: ${plural(r.maiorAtraso, "dia", "dias")}` : "nenhum ✓", r.pendentesAtrasados ? "mk-card-vermelho" : "mk-card-verde"),
    card("Vencem hoje", r.venceHoje, `${r.proximos7} nos próximos 7 dias`, r.venceHoje ? "mk-card-amarelo" : ""),
    card("Enviados", r.enviados, r.enviados ? `${r.enviadosNoPrazo} no prazo · ${r.enviadosComAtraso} com atraso · média ${String(r.atrasoMedioEnviados).replace(".", ",")} d` : "nenhum ainda"),
    card("Não enviados", r.naoEnviados, "turma começou ou foi cancelada sem o envio", r.naoEnviados ? "mk-card-vermelho" : ""),
    card("Retroativos", r.retroativos.pendentes, `pendentes de ${r.retroativos.total} · prazo vencido antes do sistema — fora do indicador`, "mk-card-retro"),
  ].join("");
}
function prevDia(d) { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); }

function renderPendencias() {
  const abertos = estado.dados.envios.filter((x) => x.situacao !== "enviado" && x.situacao !== "nao_enviado");
  const oficiais = abertos.filter((x) => !x.retroativo).sort((a, b) =>
    PESO[a.situacao] - PESO[b.situacao] || (b.atrasoDias || 0) - (a.atrasoDias || 0) || a.prazo.localeCompare(b.prazo) || a.ordem - b.ordem);
  const retro = abertos.filter((x) => x.retroativo).sort((a, b) => a.inicio.localeCompare(b.inicio) || a.ordem - b.ordem);
  const linha = (x) => `<tr class="mk-linha mk-l-${x.retroativo ? "retro" : x.situacao}">
      <td>${selo(x)}</td><td><strong>${x.ordem}.</strong> ${escapeHtml(x.envio)}<br><small class="texto-suave">${x.antecedencia} dias antes</small></td>
      <td style="text-align:left">${linhaTurma(x)}</td>
      <td>${diaSemana(x.inicio)} ${ddmm(x.inicio)}</td><td>${diaSemana(x.prazo)} ${ddmm(x.prazo)}</td>
      <td style="text-align:left">${botao(x)}</td></tr>`;
  const cab = `<thead><tr><th>Situação</th><th>Envio</th><th style="text-align:left">Turma</th><th>Turma em</th><th>Prazo</th><th></th></tr></thead>`;
  let html = oficiais.length
    ? `<div class="tabela-scroll"><table class="tabela-metricas mk-tabela">${cab}<tbody>${oficiais.map(linha).join("")}</tbody></table></div>`
    : `<p class="mk-vazio">✓ Nenhum envio pendente no indicador.</p>`;
  if (retro.length) {
    html += `<h3 class="secao-titulo">Retroativos — prazo vencido antes de ${dataBr(estado.dados.config.ativadoEm)} (${retro.length})</h3>
      <p class="texto-suave">A turma ainda vai acontecer, então o envio ainda precisa sair — mas não conta como atraso. Marque assim que enviar (ou se já tinha enviado antes do sistema).</p>
      <div class="tabela-scroll"><table class="tabela-metricas mk-tabela">${cab}<tbody>${retro.map(linha).join("")}</tbody></table></div>`;
  }
  return html;
}

function renderTurmas() {
  const porTurma = new Map();
  for (const x of estado.dados.envios) {
    if (!porTurma.has(x.turmaId)) porTurma.set(x.turmaId, []);
    porTurma.get(x.turmaId).push(x);
  }
  const grupos = [...porTurma.values()].sort((a, b) => b[0].inicio.localeCompare(a[0].inicio));
  if (!grupos.length) return `<p class="mk-vazio">Nenhuma turma futura com envio gerado ainda — sincronize a Unyflex.</p>`;
  return `<div class="tabela-scroll"><table class="tabela-metricas mk-tabela mk-historico"><thead><tr><th style="text-align:left">Turma</th>
    <th>Turma em</th><th>1. Divulgação inicial</th><th>2. Intermediário</th><th>3. Últimas vagas</th></tr></thead><tbody>` +
    grupos.map((g) => {
      const t = g[0];
      const enc = t.encerrada === "cancelada" ? ` <span class="mk-selo mk-retro">cancelada</span>` : t.encerrada === "aconteceu" ? ` <span class="mk-selo mk-prazo">já aconteceu</span>` : "";
      const cel = (o) => {
        const x = g.find((e) => e.ordem === o);
        if (!x) return "<td>—</td>";
        return `<td class="mk-celula"><small class="texto-suave">prazo ${ddmm(x.prazo)} (${x.antecedencia} d)</small><br>${selo(x)}<br>${botao(x)}</td>`;
      };
      return `<tr class="sem-clique"><td style="text-align:left">${linhaTurma(t)}${enc}</td><td>${diaSemana(t.inicio)} ${dataBr(t.inicio)}</td>${cel(1)}${cel(2)}${cel(3)}</tr>`;
    }).join("") + `</tbody></table></div>`;
}

function render() {
  if (!estado.dados) return;
  renderResumo();
  document.querySelectorAll(".mk-filtro [data-visao]").forEach((b) => b.classList.toggle("ativo", b.dataset.visao === estado.visao));
  document.getElementById("mk-legenda").textContent = estado.visao === "pendencias"
    ? "Atrasado continua cobrando até ser enviado ou a turma começar. O atraso é contado em dias corridos."
    : "Todas as turmas com envio gerado, inclusive canceladas e já realizadas.";
  document.getElementById("mk-lista").innerHTML = estado.visao === "pendencias" ? renderPendencias() : renderTurmas();
}

async function carregar() {
  try {
    estado.dados = await chamarApi("/api/marketing/emails");
    document.getElementById("mk-virada").value = estado.dados.config.virada;
    render();
  } catch (e) { document.getElementById("mk-intro").textContent = "⚠ " + e.message; }
}

function substituir(envio) {
  const i = estado.dados.envios.findIndex((x) => x.id === envio.id);
  if (i >= 0) estado.dados.envios[i] = envio;
}

document.getElementById("mk-lista").addEventListener("click", async (ev) => {
  const enviar = ev.target.closest("[data-enviar]");
  const desfazer = ev.target.closest("[data-desfazer]");
  if (enviar) {
    const id = Number(enviar.dataset.enviar);
    if (estado.confirmando !== id) {
      estado.confirmando = id; render();
      clearTimeout(estado.tConf); estado.tConf = setTimeout(() => { estado.confirmando = null; render(); }, 5000);
      return;
    }
    estado.confirmando = null;
    enviar.disabled = true;
    try {
      const { envio } = await chamarApi(`/api/marketing/emails/${id}/enviado`, json("POST"));
      avisar(`✓ "${envio.envio}" de ${envio.turma} marcado como enviado` + (envio.atrasoDias && !envio.retroativo ? ` — ${plural(envio.atrasoDias, "dia", "dias")} de atraso.` : "."));
      await carregar();
    } catch (e) { avisar("⚠ " + e.message, true); render(); }
  } else if (desfazer) {
    const id = Number(desfazer.dataset.desfazer);
    if (estado.confirmando !== -id) {
      estado.confirmando = -id; desfazer.textContent = "confirmar desfazer"; desfazer.classList.add("btn-primario");
      clearTimeout(estado.tConf); estado.tConf = setTimeout(() => { estado.confirmando = null; render(); }, 5000);
      return;
    }
    estado.confirmando = null;
    try {
      const { envio } = await chamarApi(`/api/marketing/emails/${id}/enviado`, json("DELETE", { observacao: "desfeito na tela /marketing" }));
      substituir(envio);
      avisar("Check desfeito (registrado no histórico do envio).");
      await carregar();
    } catch (e) { avisar("⚠ " + e.message, true); render(); }
  }
});

document.querySelector(".mk-filtro").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-visao]");
  if (!b) return;
  estado.visao = b.dataset.visao;
  render();
});

document.getElementById("mk-virada-salvar").addEventListener("click", async () => {
  try {
    await chamarApi("/api/marketing/config", json("PUT", { virada: document.getElementById("mk-virada").value }));
    avisar("Data de virada salva.");
    await carregar();
  } catch (e) { avisar("⚠ " + e.message, true); }
});

function aplicarSessao(sessao) {
  estado.admin = sessao.papel === "admin";
  document.getElementById("mk-admin").classList.toggle("oculto", !estado.admin);
  render();
}
document.addEventListener("sessao-pronta", (ev) => aplicarSessao(ev.detail));
if (window.SESSAO) aplicarSessao(window.SESSAO);

document.getElementById("btn-sair").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }).catch(() => {}); location.href = "/login"; });

carregar();
setInterval(() => { if (!estado.confirmando) carregar(); }, 5 * 60 * 1000); // a virada do dia muda prazos e atrasos
