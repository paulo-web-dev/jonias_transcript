"use strict";

// /patrimonio (migração 44): itens, termos e locais. Uma chamada carrega tudo
// (218 itens); filtros e ordenação em memória. Edição inline só do descritivo,
// conservação e local; o responsável muda SÓ por termo assinado (Entregar /
// Devolver). A assinatura é colhida no celular da Emanuelle: canvas com
// pointer events, sem rolar a página enquanto a pessoa assina.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function escapeHtml(t) { const d = document.createElement("div"); d.textContent = t ?? ""; return d.innerHTML; }
function avisar(texto, erro = false) {
  const el = $("#aviso"); el.textContent = texto; el.classList.toggle("aviso-erro", erro); el.classList.add("visivel");
  clearTimeout(avisar.t); avisar.t = setTimeout(() => el.classList.remove("visivel"), erro ? 8000 : 4500);
}
async function api(url, { metodo = "GET", corpo, bruto, tipo } = {}) {
  const opt = { method: metodo, headers: {} };
  if (bruto) { opt.body = bruto; opt.headers["Content-Type"] = tipo || "application/octet-stream"; }
  else if (corpo !== undefined) { opt.body = JSON.stringify(corpo); opt.headers["Content-Type"] = "application/json"; }
  const r = await fetch(url, opt);
  if (r.status === 401) { location.href = "/login"; throw new Error("sessão expirada"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || j.erro || `erro ${r.status}`), { status: r.status, corpo: j });
  return j;
}
const dataHoraBr = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11, 16)}` : "");
const dataBr = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "");
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const ROTULO_STATUS = { em_uso: "em uso", em_estoque: "em estoque", em_reparo: "em reparo", baixado: "baixado" };

let D = { itens: [], locais: [], responsaveis: [], termos: [], importacoes: [], admin: false };
const sel = new Set();
let ordem = { campo: "codigo", dir: 1 };

async function carregar() {
  D = await api("/api/patrimonio");
  preencherFiltros();
  render();
  if (!$("#aba-gerencial").hidden) await carregarGerencial();
  atalhoDoHash();
}
// Atalhos vindos da /usuarios (desativar pessoa bloqueado por itens no nome dela):
// #pessoa=ID abre a aba Itens filtrada; #devolver=ID também seleciona os itens e
// abre a devolução. Consumido uma vez (o hash é limpo).
function atalhoDoHash() {
  const m = /^#(pessoa|devolver)=(\d+)$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  const pessoaId = Number(m[2]);
  const itens = D.itens.filter((i) => i.pessoaId === pessoaId && i.status !== "baixado");
  irParaItens(null, pessoaId);
  if (!itens.length) { avisar("Nenhum item no nome dessa pessoa."); return; }
  if (m[1] === "devolver") { sel.clear(); itens.forEach((i) => sel.add(i.id)); render(); iniciarDevolucao(); }
}

// ---------- filtros ----------
function preencherFiltros() {
  const fl = $("#f-local"), fp = $("#f-pessoa");
  const vl = fl.value, vp = fp.value;
  fl.innerHTML = `<option value="">todos os locais</option><option value="-">⚠ sem local</option>` +
    D.locais.map((l) => `<option value="${l.id}">${l.andar}º · ${escapeHtml(l.nome)}${l.ativo ? "" : " (inativo)"}</option>`).join("");
  // Filtro de CONSULTA: quem tem item no nome, ativo ou não (2026-11-28). Os
  // seletores de NOVO responsável (entrega, transferência) seguem só com ativos.
  const donos = new Map();
  for (const i of D.itens) if (i.pessoaId && !donos.has(i.pessoaId)) donos.set(i.pessoaId, { id: i.pessoaId, nome: i.pessoa, ativa: i.pessoaAtiva });
  fp.innerHTML = `<option value="">todos os responsáveis</option><option value="-">⚠ sem responsável</option>` +
    [...donos.values()].sort((a, b) => b.ativa - a.ativa || a.nome.localeCompare(b.nome, "pt-BR"))
      .map((p) => `<option value="${p.id}">${escapeHtml(p.nome)}${p.ativa ? "" : " (inativa)"}</option>`).join("");
  fl.value = vl; fp.value = vp;
}
let alertaAtivo = null; // "semPessoa" | "semLocal" | "semTermo" | "semConservacao" | "semAssinatura" (os dois últimos vêm da aba Gerencial)
function filtrados() {
  const busca = norm($("#f-busca").value.trim());
  const fl = $("#f-local").value, fp = $("#f-pessoa").value, fs = $("#f-status").value, fc = $("#f-conservacao").value;
  let lista = D.itens.filter((i) => {
    if (busca && !norm(`${i.codigo} ${i.nome} ${i.numeroSerie || ""} ${i.marcaModelo || ""}`).includes(busca)) return false;
    if (fl === "-" ? i.localId : fl && String(i.localId) !== fl) return false;
    if (fp === "-" ? i.pessoaId : fp && String(i.pessoaId) !== fp) return false;
    if (fs === "ativos" ? i.status === "baixado" : fs && i.status !== fs) return false;
    if (fc === "-" ? i.conservacao : fc && i.conservacao !== fc) return false;
    if (alertaAtivo === "semPessoa" && (i.pessoaId || i.status !== "em_uso")) return false;
    if (alertaAtivo === "semLocal" && (i.localId || !["em_uso", "em_estoque"].includes(i.status))) return false;
    if (alertaAtivo === "semTermo" && !i.semTermo) return false;
    if (alertaAtivo === "semConservacao" && (i.conservacao || i.status === "baixado")) return false;
    if (alertaAtivo === "semAssinatura" && (i.termo || i.status !== "em_uso")) return false;
    return true;
  });
  const { campo, dir } = ordem;
  lista.sort((a, b) => String(a[campo] ?? "￿").localeCompare(String(b[campo] ?? "￿"), "pt-BR", { numeric: true }) * dir);
  return lista;
}

// ---------- render: itens ----------
function render() {
  const ativos = D.itens.filter((i) => i.status !== "baixado");
  const semLocal = ativos.filter((i) => !i.localId && ["em_uso", "em_estoque"].includes(i.status)).length;
  const semPessoa = ativos.filter((i) => i.status === "em_uso" && !i.pessoaId).length;
  const semTermo = D.itens.filter((i) => i.semTermo).length;
  const chip = (k, n, txt) => `<button type="button" class="pat-alerta ${n ? "pat-alerta-on" : "pat-alerta-ok"} ${alertaAtivo === k ? "ativo" : ""}" data-alerta="${k}" ${n ? "" : "disabled"}>${n ? "⚠" : "✓"} ${n} ${txt}</button>`;
  $("#pat-alertas").innerHTML =
    `<span class="pat-total"><strong>${ativos.length}</strong> itens ativos · ${D.itens.length - ativos.length} baixados</span>` +
    chip("semLocal", semLocal, "sem local") + chip("semPessoa", semPessoa, "em uso sem responsável") + chip("semTermo", semTermo, "com responsável e sem termo assinado") +
    (alertaAtivo === "semConservacao" ? `<span class="pat-alerta pat-alerta-on ativo">sem conservação</span>` : "") +
    (alertaAtivo === "semAssinatura" ? `<span class="pat-alerta pat-alerta-on ativo">em uso sem termo assinado</span>` : "") +
    (alertaAtivo ? `<button type="button" class="btn-mini" data-alerta="">✕ tirar filtro</button>` : "");

  const lista = filtrados();
  $("#pat-contagem").textContent = `${lista.length} de ${D.itens.length}`;
  const opcLocal = (id) => `<option value="">— sem local —</option>` + D.locais.filter((l) => l.ativo || l.id === id)
    .map((l) => `<option value="${l.id}" ${l.id === id ? "selected" : ""}>${l.andar}º · ${escapeHtml(l.nome)}</option>`).join("");
  const opcCons = (v) => `<option value="">—</option>` + ["bom", "regular", "ruim"].map((x) => `<option ${x === v ? "selected" : ""}>${x}</option>`).join("");
  const txt = (i, campo, valor, rotulo) => `<td class="pat-editavel" data-campo="${campo}" data-rotulo="${rotulo}" tabindex="0">${valor ? escapeHtml(valor) : '<span class="pat-vazio">—</span>'}</td>`;
  $("#pat-tabela tbody").innerHTML = lista.map((i) => `<tr data-id="${i.id}" class="${sel.has(i.id) ? "pat-sel" : ""} ${i.status === "baixado" ? "pat-baixado" : ""}">
    <td class="pat-col-sel"><input type="checkbox" class="sel-item" ${sel.has(i.id) ? "checked" : ""} ${i.status === "baixado" ? "disabled" : ""} aria-label="selecionar ${i.codigo}" /></td>
    <td class="pat-codigo" data-rotulo="Código">${i.codigo}${i.conjunto ? `<small title="conjunto">⛓ ${escapeHtml(i.conjunto)}</small>` : ""}</td>
    ${txt(i, "nome", i.nome, "Item")}${txt(i, "marcaModelo", i.marcaModelo, "Marca / modelo")}${txt(i, "numeroSerie", i.numeroSerie, "Nº de série")}
    <td data-rotulo="Local" class="${i.localId || i.status === "baixado" ? "" : "pat-alerta-celula"}"><select class="campo-select pat-inline" data-campo="localId">${opcLocal(i.localId)}</select></td>
    <td data-rotulo="Responsável" style="text-align:left" class="${!i.pessoaId && i.status === "em_uso" ? "pat-alerta-celula" : ""}">${i.pessoa ? escapeHtml(i.pessoa) : '<span class="pat-vazio">sem responsável</span>'}
      ${i.termo ? `<a class="pat-termo-link" href="/patrimonio/termos/${i.termo.id}/via" target="_blank" rel="noopener" title="termo em aberto desde ${dataHoraBr(i.termo.data)}">📝 ${i.termo.numero}</a>` : i.pessoaId ? '<span class="chip pat-chip-aviso" title="veio da carga inicial: falta colher a assinatura">sem termo</span>' : ""}</td>
    <td data-rotulo="Status"><button type="button" class="chip pat-status pat-st-${i.status}" data-menu-status>${ROTULO_STATUS[i.status]} ▾</button></td>
    <td data-rotulo="Conservação"><select class="campo-select pat-inline" data-campo="conservacao">${opcCons(i.conservacao)}</select></td>
    ${txt(i, "observacao", i.observacao, "Observação")}
    <td><button type="button" class="btn-mini" data-historico title="histórico do item">🕘</button></td>
  </tr>`).join("") || `<tr class="sem-clique"><td colspan="11" class="texto-suave">Nenhum item com esses filtros.</td></tr>`;
  $$("#pat-tabela th[data-ord]").forEach((th) => th.classList.toggle("ordenado", th.dataset.ord === ordem.campo));
  renderSelecao();
  renderTermos();
  renderLocais();
  renderImportacoes();
}

function renderSelecao() {
  const box = $("#pat-selecao");
  for (const id of [...sel]) if (!D.itens.some((i) => i.id === id && i.status !== "baixado")) sel.delete(id);
  box.hidden = sel.size === 0;
  const itens = D.itens.filter((i) => sel.has(i.id));
  const donos = new Set(itens.map((i) => i.pessoa || "—"));
  $("#pat-sel-texto").textContent = `${sel.size} selecionado(s)` + (donos.size === 1 && itens[0]?.pessoa ? ` · com ${itens[0].pessoa}` : donos.size > 1 ? " · com pessoas diferentes" : "");
}

// ---------- edição inline ----------
async function salvarCampo(id, corpo) {
  try {
    const r = await api(`/api/patrimonio/itens/${id}`, { metodo: "PATCH", corpo });
    const k = D.itens.findIndex((i) => i.id === id);
    if (k >= 0) D.itens[k] = r.item;
    return true;
  } catch (e) { avisar(e.message, true); return false; }
}
function editarCelula(td) {
  if (td.querySelector("input")) return;
  const tr = td.closest("tr"); const id = Number(tr.dataset.id); const campo = td.dataset.campo;
  const item = D.itens.find((i) => i.id === id);
  const original = item[campo] ?? "";
  const inp = document.createElement("input");
  inp.className = "campo-select pat-inline-txt"; inp.value = original; inp.maxLength = campo === "observacao" ? 500 : 160;
  td.textContent = ""; td.append(inp); inp.focus(); inp.select();
  let feito = false;
  const fim = async (salvar) => {
    if (feito) return; feito = true;
    if (salvar && inp.value.trim() !== String(original)) {
      if (await salvarCampo(id, { [campo]: inp.value })) avisar(`Item ${item.codigo} salvo.`);
    }
    render();
  };
  inp.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); fim(true); }
    if (ev.key === "Escape") { ev.preventDefault(); fim(false); }
  });
  inp.addEventListener("blur", () => fim(true));
}

// ---------- diálogos ----------
function abrir(id) { $(id).classList.remove("oculto"); }
function fechar(id) { $(id).classList.add("oculto"); }
$$("[data-fechar]").forEach((b) => b.addEventListener("click", () => fechar("#" + b.closest(".modal").id)));
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  for (const m of ["#modal-simples", "#modal-termo"]) if (!$(m).classList.contains("oculto")) { fechar(m); break; }
});

// Diálogo com um campo de texto obrigatório (motivo). Resolve com o texto ou null.
function pedirTexto(titulo, rotulo, botao, { opcional = false } = {}) {
  return new Promise((ok) => {
    $("#simples-titulo").textContent = titulo;
    $("#simples-corpo").innerHTML = `<label class="pat-campo">${escapeHtml(rotulo)}<textarea id="simples-texto" class="campo-select" rows="3" maxlength="300"></textarea></label>`;
    $("#simples-rodape").innerHTML = `<button type="button" class="btn btn-mini" id="simples-cancelar">Cancelar</button><button type="button" class="btn btn-mini btn-primario" id="simples-ok">${escapeHtml(botao)}</button>`;
    abrir("#modal-simples"); $("#simples-texto").focus();
    $("#simples-cancelar").onclick = () => { fechar("#modal-simples"); ok(null); };
    $("#simples-ok").onclick = () => {
      const v = $("#simples-texto").value.trim();
      if (!v && !opcional) { avisar("Informe o motivo.", true); return; }
      fechar("#modal-simples"); ok(v);
    };
  });
}

async function menuStatus(item) {
  const acoes = [];
  if (item.status === "em_reparo") acoes.push(["reparo_retorno", "🔧 Voltou do reparo"]);
  else if (item.status !== "baixado") acoes.push(["reparo_saida", "🔧 Enviar para reparo"]);
  if (item.status !== "baixado") acoes.push(["baixa", "🗑 Dar baixa"]);
  if (item.status === "baixado" && D.admin) acoes.push(["desfazer_baixa", "↺ Desfazer baixa (admin)"]);
  $("#simples-titulo").textContent = `Item ${item.codigo} — ${ROTULO_STATUS[item.status]}`;
  $("#simples-corpo").innerHTML = `<p>${escapeHtml(item.nome)}</p>` + (item.status === "baixado" ? `<p class="texto-suave">Baixado em ${dataHoraBr(item.baixadoEm)}: ${escapeHtml(item.motivoBaixa || "")}</p>` : "") +
    `<div class="pat-menu">${acoes.map(([a, t]) => `<button type="button" class="btn btn-mini" data-acao="${a}">${t}</button>`).join("") || '<p class="texto-suave">Nenhuma ação disponível.</p>'}</div>`;
  $("#simples-rodape").innerHTML = `<button type="button" class="btn btn-mini" id="simples-cancelar">Fechar</button>`;
  $("#simples-cancelar").onclick = () => fechar("#modal-simples");
  abrir("#modal-simples");
  $$("#simples-corpo [data-acao]").forEach((b) => b.addEventListener("click", async () => {
    const acao = b.dataset.acao;
    fechar("#modal-simples");
    let motivo = null;
    if (acao === "baixa") motivo = await pedirTexto(`Baixa do item ${item.codigo}`, "Motivo da baixa (obrigatório)", "Dar baixa");
    if (acao === "desfazer_baixa") motivo = await pedirTexto(`Desfazer a baixa do ${item.codigo}`, "Motivo (obrigatório)", "Desfazer");
    if ((acao === "baixa" || acao === "desfazer_baixa") && !motivo) return;
    if (acao === "reparo_saida") {
      motivo = await pedirTexto(`Reparo do item ${item.codigo}`, "Onde / por quê (opcional)", "Enviar para reparo", { opcional: true });
      if (motivo === null) return;
    }
    try {
      const r = await api(`/api/patrimonio/itens/${item.id}/status`, { metodo: "POST", corpo: { acao, motivo: motivo || null } });
      D.itens[D.itens.findIndex((i) => i.id === item.id)] = r.item;
      avisar(`Item ${item.codigo}: ${ROTULO_STATUS[r.item.status]}.`); render();
    } catch (e) { avisar(e.message, true); }
  }));
}

async function verHistorico(item) {
  try {
    const h = await api(`/api/patrimonio/itens/${item.id}/historico`);
    const TIPO = { entrega: "entrega", devolucao: "devolução", transferencia: "transferência", reparo_saida: "saiu p/ reparo", reparo_retorno: "voltou do reparo", baixa: "baixa", ajuste: "ajuste" };
    $("#simples-titulo").textContent = `Histórico — ${item.codigo} ${item.nome}`;
    $("#simples-corpo").innerHTML = `<ol class="pat-historico">${h.movimentos.map((m) => `<li><strong>${TIPO[m.tipo]}</strong> · ${dataHoraBr(m.dataHora)} · por ${escapeHtml(m.usuario)}
      ${m.termo ? ` · termo <a href="/patrimonio/termos/${m.termoId}/via" target="_blank" rel="noopener">${m.termo}</a>` : ""}<br>
      <span class="texto-suave">${m.pessoaDe !== m.pessoaPara ? `${escapeHtml(m.pessoaDe || "ninguém")} → ${escapeHtml(m.pessoaPara || "ninguém")} · ` : ""}${m.localDe !== m.localPara ? `${escapeHtml(m.localDe || "sem local")} → ${escapeHtml(m.localPara || "sem local")} · ` : ""}${m.statusDe !== m.statusPara ? `${ROTULO_STATUS[m.statusDe] || "—"} → ${ROTULO_STATUS[m.statusPara] || "—"}` : ""}
      ${m.observacao ? `<br>${escapeHtml(m.observacao)}` : ""}</span></li>`).join("")}</ol>`;
    $("#simples-rodape").innerHTML = `<button type="button" class="btn btn-mini" id="simples-cancelar">Fechar</button>`;
    $("#simples-cancelar").onclick = () => fechar("#modal-simples");
    abrir("#modal-simples");
  } catch (e) { avisar(e.message, true); }
}

// ---------- assinatura ----------
// Resolução fixa de 600×200 (o PNG tem sempre o mesmo tamanho, qualquer que
// seja a tela); o desenho é escalado da largura exibida. touch-action: none no
// CSS + preventDefault no touchmove: a página não rola enquanto a pessoa assina.
function criarAssinatura(caixa) {
  caixa.innerHTML = `<div class="pat-assin-quadro"><canvas width="600" height="200" class="pat-assin-canvas" aria-label="quadro de assinatura"></canvas>
    <span class="pat-assin-dica">assine aqui com o dedo</span></div>
    <button type="button" class="btn btn-mini pat-assin-limpar">limpar</button>`;
  const cv = caixa.querySelector("canvas"); const ctx = cv.getContext("2d");
  ctx.lineWidth = 3; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#111";
  let desenhando = false, traco = false, ult = null;
  const ponto = (ev) => { const r = cv.getBoundingClientRect(); return { x: ((ev.clientX - r.left) / r.width) * cv.width, y: ((ev.clientY - r.top) / r.height) * cv.height }; };
  cv.addEventListener("pointerdown", (ev) => {
    ev.preventDefault(); desenhando = true; ult = ponto(ev);
    try { cv.setPointerCapture(ev.pointerId); } catch (_) {}
    ctx.beginPath(); ctx.arc(ult.x, ult.y, 1.5, 0, Math.PI * 2); ctx.fillStyle = "#111"; ctx.fill();
    traco = true; caixa.classList.add("assinado");
  });
  cv.addEventListener("pointermove", (ev) => {
    if (!desenhando) return; ev.preventDefault();
    const p = ponto(ev);
    ctx.beginPath(); ctx.moveTo(ult.x, ult.y); ctx.lineTo(p.x, p.y); ctx.stroke(); ult = p;
  });
  const parar = () => { desenhando = false; ult = null; };
  cv.addEventListener("pointerup", parar); cv.addEventListener("pointercancel", parar); cv.addEventListener("pointerleave", parar);
  cv.addEventListener("touchstart", (ev) => ev.preventDefault(), { passive: false });
  cv.addEventListener("touchmove", (ev) => ev.preventDefault(), { passive: false });
  caixa.querySelector(".pat-assin-limpar").addEventListener("click", () => { ctx.clearRect(0, 0, cv.width, cv.height); traco = false; caixa.classList.remove("assinado"); });
  return { temTraco: () => traco, png: () => cv.toDataURL("image/png") };
}

// ---------- fluxo de termo ----------
function seletorLocal(prefixo, localPadrao) {
  const andares = [...new Set(D.locais.filter((l) => l.ativo).map((l) => l.andar))].sort((a, b) => a - b);
  const padrao = D.locais.find((l) => l.id === localPadrao);
  return `<div class="pat-linha2">
    <label class="pat-campo">Andar<select class="campo-select" id="${prefixo}-andar">${andares.map((a) => `<option value="${a}" ${padrao?.andar === a ? "selected" : ""}>${a}º andar</option>`).join("")}</select></label>
    <label class="pat-campo">Sala<select class="campo-select" id="${prefixo}-sala"></select></label></div>`;
}
function ligarSeletorLocal(prefixo, localPadrao) {
  const an = $(`#${prefixo}-andar`), sa = $(`#${prefixo}-sala`);
  const encher = () => {
    sa.innerHTML = D.locais.filter((l) => l.ativo && String(l.andar) === an.value)
      .map((l) => `<option value="${l.id}" ${l.id === localPadrao ? "selected" : ""}>${escapeHtml(l.nome)}</option>`).join("");
  };
  an.addEventListener("change", encher); encher();
}
const opcoesPessoas = (excluir) => `<option value="">escolha a pessoa…</option>` + D.responsaveis.filter((p) => p.id !== excluir)
  .map((p) => `<option value="${p.id}">${escapeHtml(p.nome)}${p.tipo === "consultor" ? " · comercial" : ""}</option>`).join("");
const listaItens = (itens, escolha) => `<ul class="pat-lista-itens">${itens.map((i) => `<li><span class="pat-codigo">${i.codigo}</span> ${escapeHtml(i.nome)}${i.marcaModelo ? ` <small>· ${escapeHtml(i.marcaModelo)}</small>` : ""}${escolha ? ` — <strong>${escapeHtml((escolha[i.id] || "").toUpperCase())}</strong>` : ""}</li>`).join("")}</ul>`;

// Conservação de cada item, AVALIADA NO ATO (obrigatória na entrega e na
// devolução). Entrega: vem preenchida com a do item, para conferir. Devolução:
// sempre em branco — nunca herdada da entrega (é o que mostra se voltou pior).
// `escolha` ({itemId: estado}) sobrevive ao "‹ Voltar" da assinatura.
function blocoConservacao(itens, escolha, dica) {
  return `<p class="pat-campo">Conservação de cada item — ${escapeHtml(dica)}</p><ul class="pat-lista-itens pat-lista-cons">${itens.map((i) => `<li>
    <span><span class="pat-codigo">${i.codigo}</span> ${escapeHtml(i.nome)}</span>
    <select class="campo-select cons-item" data-item="${i.id}" aria-label="conservação do ${i.codigo}"><option value="">avaliar…</option>
      ${["bom", "regular", "ruim"].map((v) => `<option value="${v}" ${escolha[i.id] === v ? "selected" : ""}>${v}</option>`).join("")}</select></li>`).join("")}</ul>`;
}
function ligarConservacao(escolha) {
  $$("#termo-corpo .cons-item").forEach((s) => s.addEventListener("change", () => { escolha[s.dataset.item] = s.value || undefined; s.classList.toggle("pat-falta", !s.value); }));
}
function faltaConservacao(itens, escolha) {
  const faltam = itens.filter((i) => !escolha[i.id]);
  $$("#termo-corpo .cons-item").forEach((s) => s.classList.toggle("pat-falta", !escolha[s.dataset.item]));
  if (faltam.length) avisar(`Avalie a conservação de: ${faltam.map((i) => i.codigo).join(", ")}.`, true);
  return faltam.length > 0;
}

function etapaAssinatura({ titulo, quem, resumo, voltar, confirmar, rotuloConfirmar }) {
  $("#termo-titulo").textContent = titulo;
  $("#termo-corpo").innerHTML = `${resumo}<label class="pat-campo">Nome de quem assina<input type="text" class="campo-select" id="assin-nome" value="${escapeHtml(quem)}" maxlength="120" /></label>
    <div id="assin-caixa" class="pat-assin"></div>`;
  const assin = criarAssinatura($("#assin-caixa"));
  $("#termo-rodape").innerHTML = `<button type="button" class="btn btn-mini" id="termo-voltar">‹ Voltar</button><button type="button" class="btn btn-mini btn-primario" id="termo-ok">${rotuloConfirmar}</button>`;
  $("#termo-voltar").onclick = voltar;
  $("#termo-ok").onclick = async () => {
    if (!assin.temTraco()) { avisar("Sem assinatura: a pessoa precisa assinar no quadro.", true); return; }
    const nome = $("#assin-nome").value.trim();
    if (!nome) { avisar("Informe o nome de quem assina.", true); return; }
    $("#termo-ok").disabled = true;
    try { await confirmar({ assinatura: assin.png(), assinanteNome: nome }); }
    finally { const b = $("#termo-ok"); if (b) b.disabled = false; }
  };
}

function concluido(mensagem, termos) {
  $("#termo-titulo").textContent = "Termo gerado";
  $("#termo-corpo").innerHTML = `<p class="pat-ok">✓ ${escapeHtml(mensagem)}</p>` +
    termos.map((t) => `<p><a class="btn btn-mini btn-primario" href="/patrimonio/termos/${t.id}/via" target="_blank" rel="noopener">📝 Abrir a via do termo ${t.numero}</a></p>`).join("") +
    `<p class="texto-suave">A via abre para impressão; no celular, "Compartilhar → Imprimir" ou "Salvar como PDF".</p>`;
  $("#termo-rodape").innerHTML = `<button type="button" class="btn btn-mini btn-primario" id="termo-fim">Concluir</button>`;
  $("#termo-fim").onclick = () => fechar("#modal-termo");
  sel.clear();
  carregar().catch((e) => avisar(e.message, true));
}

function iniciarEntrega() {
  const itens = D.itens.filter((i) => sel.has(i.id));
  const abertos = itens.filter((i) => i.termo);
  if (abertos.length) { avisar(`${abertos.map((i) => i.codigo).join(", ")} já está(ão) em termo aberto: para trocar de pessoa, use Devolver → transferir.`, true); return; }
  const localPadrao = itens.find((i) => i.localId)?.localId ?? null;
  const escolha = Object.fromEntries(itens.filter((i) => i.conservacao).map((i) => [i.id, i.conservacao]));
  const passo1 = () => {
    $("#termo-titulo").textContent = `Entregar ${itens.length} item(ns)`;
    $("#termo-corpo").innerHTML = blocoConservacao(itens, escolha, "confira ou preencha agora") +
      `<label class="pat-campo">Para quem<select class="campo-select" id="ent-pessoa">${opcoesPessoas()}</select></label>` +
      seletorLocal("ent", localPadrao) + `<label class="pat-campo">Observação (opcional)<input type="text" class="campo-select" id="ent-obs" maxlength="300" /></label>`;
    ligarSeletorLocal("ent", localPadrao);
    ligarConservacao(escolha);
    const donoCarga = new Set(itens.map((i) => i.pessoaId).filter(Boolean));
    if (donoCarga.size === 1) $("#ent-pessoa").value = String([...donoCarga][0]);
    $("#termo-rodape").innerHTML = `<button type="button" class="btn btn-mini" data-fechar-termo>Cancelar</button><button type="button" class="btn btn-mini btn-primario" id="termo-seguir">Seguir para assinatura ›</button>`;
    $("[data-fechar-termo]").onclick = () => fechar("#modal-termo");
    $("#termo-seguir").onclick = () => {
      const pessoaId = Number($("#ent-pessoa").value), localId = Number($("#ent-sala").value);
      if (faltaConservacao(itens, escolha)) return;
      if (!pessoaId) { avisar("Escolha para quem.", true); return; }
      if (!localId) { avisar("Escolha a sala.", true); return; }
      const pessoa = D.responsaveis.find((p) => p.id === pessoaId); const local = D.locais.find((l) => l.id === localId);
      const obs = $("#ent-obs").value;
      etapaAssinatura({
        titulo: `Assinatura — ${pessoa.nome}`, quem: pessoa.nome, rotuloConfirmar: "✓ Confirmar entrega",
        resumo: `<p>${itens.length} item(ns) para <strong>${escapeHtml(pessoa.nome)}</strong> · ${local.andar}º · ${escapeHtml(local.nome)}</p>${listaItens(itens, escolha)}`,
        voltar: passo1,
        confirmar: async ({ assinatura, assinanteNome }) => {
          try {
            const r = await api("/api/patrimonio/entregas", { metodo: "POST", corpo: { itemIds: itens.map((i) => i.id), pessoaId, localId, assinatura, assinanteNome, observacao: obs, conservacoes: { ...escolha } } });
            concluido(`Entrega registrada: termo ${r.termo.numero}, ${r.itens} item(ns).`, [r.termo]);
          } catch (e) { avisar(e.message, true); }
        },
      });
    };
  };
  passo1(); abrir("#modal-termo");
}

function iniciarDevolucao() {
  const itens = D.itens.filter((i) => sel.has(i.id));
  const semDono = itens.filter((i) => !i.pessoaId);
  if (semDono.length) { avisar(`${semDono.map((i) => i.codigo).join(", ")} não está(ão) com ninguém.`, true); return; }
  const donos = new Set(itens.map((i) => i.pessoaId));
  if (donos.size > 1) { avisar("Uma devolução é de uma pessoa só: selecione os itens de uma pessoa.", true); return; }
  const de = D.responsaveis.find((p) => p.id === itens[0].pessoaId) || { id: itens[0].pessoaId, nome: itens[0].pessoa };
  const estoque = D.locais.find((l) => l.andar === 7 && l.nome === "Estoque")?.id ?? null;
  const escolha = {}; // devolução: sempre avaliada agora, nunca herdada da entrega
  const passo1 = () => {
    $("#termo-titulo").textContent = `Devolver ${itens.length} item(ns) de ${de.nome}`;
    $("#termo-corpo").innerHTML = blocoConservacao(itens, escolha, "avalie agora, como o item está voltando") +
      `<fieldset class="pat-opcoes"><label><input type="radio" name="dev-destino" value="estoque" checked /> volta para o estoque (sem responsável)</label>
       <label><input type="radio" name="dev-destino" value="transferir" /> transferir direto para outra pessoa (ela também assina)</label></fieldset>
       <label class="pat-campo" id="dev-para-caixa" hidden>Para quem<select class="campo-select" id="dev-para">${opcoesPessoas(de.id)}</select></label>` +
      seletorLocal("dev", estoque) + `<label class="pat-campo">Observação (opcional)<input type="text" class="campo-select" id="dev-obs" maxlength="300" /></label>`;
    ligarSeletorLocal("dev", estoque);
    ligarConservacao(escolha);
    $$('input[name="dev-destino"]').forEach((r) => r.addEventListener("change", () => { $("#dev-para-caixa").hidden = !$('input[name="dev-destino"][value="transferir"]').checked; }));
    $("#termo-rodape").innerHTML = `<button type="button" class="btn btn-mini" data-fechar-termo>Cancelar</button><button type="button" class="btn btn-mini btn-primario" id="termo-seguir">Seguir para assinatura ›</button>`;
    $("[data-fechar-termo]").onclick = () => fechar("#modal-termo");
    $("#termo-seguir").onclick = () => {
      const transferir = $('input[name="dev-destino"][value="transferir"]').checked;
      const paraId = transferir ? Number($("#dev-para").value) : null;
      const localId = Number($("#dev-sala").value);
      if (faltaConservacao(itens, escolha)) return;
      if (transferir && !paraId) { avisar("Escolha para quem transferir.", true); return; }
      if (!localId) { avisar("Escolha a sala.", true); return; }
      const para = paraId ? D.responsaveis.find((p) => p.id === paraId) : null;
      const local = D.locais.find((l) => l.id === localId);
      const obs = $("#dev-obs").value;
      const destino = para ? `transferência para <strong>${escapeHtml(para.nome)}</strong> · ${local.andar}º · ${escapeHtml(local.nome)}` : `volta para ${local.andar}º · ${escapeHtml(local.nome)}`;
      etapaAssinatura({
        titulo: `Assinatura de quem devolve — ${de.nome}`, quem: de.nome,
        rotuloConfirmar: para ? "Seguir: assinatura de quem recebe ›" : "✓ Confirmar devolução",
        resumo: `<p><strong>${escapeHtml(de.nome)}</strong> devolve ${itens.length} item(ns) · ${destino}</p>${listaItens(itens, escolha)}`,
        voltar: passo1,
        confirmar: async (assinDe) => {
          const corpo = { itemIds: itens.map((i) => i.id), assinatura: assinDe.assinatura, assinanteNome: assinDe.assinanteNome, observacao: obs, conservacoes: { ...escolha } };
          if (!para) {
            try {
              const r = await api("/api/patrimonio/devolucoes", { metodo: "POST", corpo: { ...corpo, localId } });
              concluido(`Devolução registrada: termo ${r.devolucao.numero}, ${r.itens} item(ns) no estoque.`, [r.devolucao]);
            } catch (e) { avisar(e.message, true); }
            return;
          }
          // transferência: segunda assinatura, de quem recebe
          etapaAssinatura({
            titulo: `Assinatura de quem recebe — ${para.nome}`, quem: para.nome, rotuloConfirmar: "✓ Confirmar transferência",
            resumo: `<p><strong>${escapeHtml(para.nome)}</strong> recebe ${itens.length} item(ns) de ${escapeHtml(de.nome)} · ${local.andar}º · ${escapeHtml(local.nome)}</p>${listaItens(itens, escolha)}`,
            voltar: passo1,
            confirmar: async (assinPara) => {
              try {
                const r = await api("/api/patrimonio/devolucoes", { metodo: "POST", corpo: { ...corpo, transferir: { pessoaId: para.id, localId, assinatura: assinPara.assinatura, assinanteNome: assinPara.assinanteNome } } });
                concluido(`Transferência registrada: devolução ${r.devolucao.numero} e entrega ${r.entrega.numero}.`, [r.devolucao, r.entrega]);
              } catch (e) { avisar(e.message, true); }
            },
          });
        },
      });
    };
  };
  passo1(); abrir("#modal-termo");
}

// ---------- termos ----------
function renderTermos() {
  $("#pat-termos tbody").innerHTML = D.termos.map((t) => {
    const situacao = t.canceladoEm ? `<span class="chip pat-chip-cancelado" title="${escapeHtml(t.motivoCancelamento || "")}">cancelado</span>`
      : t.tipo === "devolucao" ? '<span class="chip">devolução</span>'
      : t.abertos ? `<span class="chip pat-chip-ok">em vigor · ${t.abertos} de ${t.itens}</span>` : '<span class="chip">encerrado</span>';
    return `<tr class="sem-clique" data-termo="${t.id}">
      <td class="pat-codigo" data-rotulo="Nº">${t.numero}</td><td data-rotulo="Tipo">${t.tipo === "entrega" ? "entrega" : "devolução"}${t.relacionadoId ? " ⇄" : ""}</td>
      <td data-rotulo="Pessoa" style="text-align:left">${escapeHtml(t.pessoa)}</td><td data-rotulo="Data">${dataHoraBr(t.dataHora)}</td>
      <td data-rotulo="Itens">${t.itens}</td><td data-rotulo="Local" style="text-align:left">${escapeHtml(t.local || "—")}</td><td data-rotulo="Situação">${situacao}</td>
      <td><a class="btn btn-mini" href="/patrimonio/termos/${t.id}/via" target="_blank" rel="noopener">📝 via</a>
        ${D.admin && !t.canceladoEm ? `<button type="button" class="btn btn-mini btn-perigo" data-cancelar="${t.id}">cancelar</button>` : ""}</td></tr>`;
  }).join("") || `<tr class="sem-clique"><td colspan="8" class="texto-suave">Nenhum termo ainda.</td></tr>`;
}

// ---------- locais ----------
function renderLocais() {
  $("#pat-locais tbody").innerHTML = D.locais.map((l) => `<tr class="sem-clique" data-local="${l.id}">
    <td data-rotulo="Andar">${l.andar}º</td><td data-rotulo="Sala" style="text-align:left"><input type="text" class="campo-select pat-inline-txt" data-nome-local value="${escapeHtml(l.nome)}" maxlength="60" /></td>
    <td data-rotulo="Itens">${l.itens || '<span class="pat-vazio">0</span>'}</td><td data-rotulo="Situação">${l.ativo ? "ativo" : '<span class="pat-vazio">inativo</span>'}</td>
    <td><button type="button" class="btn btn-mini" data-ativo-local>${l.ativo ? "desativar" : "reativar"}</button></td></tr>`).join("");
}

// ---------- importação ----------
function renderImportacoes() {
  $("#pat-importacoes").innerHTML = D.importacoes.length ? `<h3 class="secao-titulo">Importações</h3><table class="tabela-metricas pat-tabela"><thead><tr><th>#</th><th style="text-align:left">Arquivo</th><th>Quando</th><th>Lidas</th><th>Importadas</th><th>Ignoradas</th><th>Novos</th><th>Atualizados</th><th>Idênticos</th></tr></thead><tbody>` +
    D.importacoes.map((i) => `<tr class="sem-clique"><td>${i.id}</td><td style="text-align:left">${escapeHtml(i.arquivo)}</td><td>${dataHoraBr(i.iniciadoEm)}</td><td>${i.lidas}</td><td>${i.validas}</td><td>${i.ignoradas}</td><td>${i.novos}</td><td>${i.atualizados}</td><td>${i.identicos}</td></tr>`).join("") + "</tbody></table>" : "";
}
function renderRelatorio(r) {
  const lista = (titulo, xs, fn) => (xs.length ? `<h4>${titulo} (${xs.length})</h4><ul class="pat-relatorio-lista">${xs.map(fn).join("")}</ul>` : "");
  $("#pat-relatorio").innerHTML = `<div class="pat-relatorio">
    <p><strong>${r.linhasLidas}</strong> linhas lidas · <strong>${r.importadas}</strong> importadas · <strong>${r.ignoradas.length}</strong> ignoradas ·
      ${r.novos} novos · ${r.atualizados} atualizados · ${r.identicos} idênticos (aba "${escapeHtml(r.aba)}")</p>
    ${r.avisos.map((a) => `<p class="pat-aviso">⚠ ${escapeHtml(a)}</p>`).join("")}
    ${lista("Ignoradas", r.ignoradas, (x) => `<li>linha ${x.linha} · ${escapeHtml(x.codigo || "—")} ${escapeHtml(x.item || "")} — ${escapeHtml(x.motivo)}</li>`)}
    ${lista("Ressalvas", r.ressalvas, (x) => `<li>linha ${x.linha} · ${escapeHtml(x.codigo)} — ${escapeHtml(x.msg)}</li>`)}
    ${lista("Já trabalhados no sistema (planilha não aplicada)", r.mantidos, (x) => `<li>linha ${x.linha} · ${escapeHtml(x.codigo)} — ${x.campos.map((c) => escapeHtml(c.campo)).join(", ")}</li>`)}
    ${r.colunasExtras.length ? `<p class="texto-suave">Colunas guardadas como extras: ${r.colunasExtras.map(escapeHtml).join(", ")}</p>` : ""}
  </div>`;
}

// ---------- gerencial ----------
// Estado do inventário (patrimonio.gerencial): totais, os buracos, a barra do
// inventário completo, o ROTEIRO DE COLETA (por pessoa: colher a assinatura;
// sem responsável: descobrir quem usa, por andar e sala), locais, responsáveis,
// reparo longo e termos do mês. Clicar num buraco abre a aba Itens filtrada.
let G = null;
let gerMes = null;
// Grupos do roteiro: "por pessoa" nasce aberto (é a ação do dia); "descobrir quem
// usa" nasce FECHADO (168 itens no primeiro dia enterravam o resto da aba). O que
// a pessoa abre ou fecha é lembrado entre as recargas da aba.
const gruposAbertos = new Map();
const nomeMes = (m) => { const t = new Date(`${m}-15T12:00:00`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }); return t[0].toUpperCase() + t.slice(1); };
const somarMes = (m, n) => { const [a, b] = m.split("-").map(Number); const d = new Date(a, b - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

async function carregarGerencial() {
  G = await api(`/api/patrimonio/gerencial${gerMes ? `?mes=${gerMes}` : ""}`);
  gerMes = G.termosDoMes.mes;
  renderGerencial();
}

function renderGerencial() {
  if (!G) return;
  const inv = G.inventario;
  const st = G.porStatus;
  $("#ger-tv").innerHTML = `📺 Tela do patrimônio na TV: <b class="${G.tv ? "ligada" : ""}">${G.tv ? "LIGADA" : "desligada"}</b>` +
    (D.admin
      ? ` <button type="button" class="btn btn-mini" data-tv-alternar="${G.tv ? "0" : "1"}">${G.tv ? "desligar" : "ligar"}</button>
         <span>prévia: <code>/tv?token=…&amp;fixo=patrimonio&amp;previa=1</code> (só admin logado)</span>`
      : " <span>(só o administrador liga ou desliga)</span>");
  const buraco = (k, n, txt) => `<button type="button" class="pat-ger-buraco ${n ? "" : "pat-ger-buraco-ok"}" data-ir-alerta="${k}" ${n ? "" : "disabled"}><b>${n || "0 ✓"}</b><span>${txt}</span></button>`;
  $("#ger-topo").innerHTML = `
    <div class="pat-ger-status">
      <span><b>${st.em_uso}</b> em uso</span><span><b>${st.em_estoque}</b> em estoque</span>
      <span><b>${st.em_reparo}</b> em reparo</span><span><b>${st.baixado}</b> baixados</span>
    </div>
    <div class="pat-ger-buracos">
      ${buraco("semPessoa", inv.semResponsavel, "em uso sem responsável")}
      ${buraco("semLocal", inv.semLocal, "sem local")}
      ${buraco("semConservacao", inv.semConservacao, "sem conservação")}
      ${buraco("semAssinatura", inv.semAssinatura, "em uso sem termo assinado")}
    </div>
    <div class="pat-ger-inventario ${inv.completo ? "pat-ger-completo" : ""}">
      <div class="pat-ger-inv-linha"><strong>${inv.completo ? "✓ Inventário completo" : "Inventário completo"}</strong><b>${inv.pct}%</b></div>
      <div class="pat-ger-trilha"><div style="width:${inv.pct}%"></div></div>
      <p class="texto-suave">${inv.completos} de ${inv.total} itens com tudo o que o status exige — em uso: responsável, local, conservação e termo assinado;
        em estoque: local e conservação; em reparo: conservação. Baixados ficam fora.</p>
    </div>`;

  // roteiro de coleta
  const ro = G.roteiro;
  const nPessoas = ro.porPessoa.reduce((n, p) => n + p.itens.length, 0);
  const nDescobrir = ro.descobrir.reduce((n, x) => n + x.itens.length, 0);
  $("#ger-roteiro-resumo").textContent = `· ${ro.total} em uso sem termo assinado`;
  const linhaItem = (i, comLocal) => `<li><label><input type="checkbox" class="ger-sel" data-item="${i.id}" ${sel.has(i.id) ? "checked" : ""} />
    <span class="pat-codigo">${i.codigo}</span> ${escapeHtml(i.nome)}${i.marcaModelo ? ` <small class="texto-suave">${escapeHtml(i.marcaModelo)}</small>` : ""}
    ${comLocal ? `<small class="texto-suave">· ${escapeHtml(i.local || "sem local")}</small>` : ""}</label></li>`;
  const grupo = (chave, padraoAberto, titulo, sub, itens, acao, comLocal) => `<details class="pat-ger-grupo" data-grupo="${chave}" ${(gruposAbertos.get(chave) ?? padraoAberto) ? "open" : ""}><summary><span><strong>${titulo}</strong> <small class="texto-suave">${sub}</small></span>
    <span class="pat-ger-acoes">${acao}</span></summary><ul>${itens.map((i) => linhaItem(i, comLocal)).join("")}</ul></details>`;
  $("#ger-roteiro").innerHTML =
    `<h4 class="pat-ger-sub">Colher a assinatura — por pessoa <small class="texto-suave">(${nPessoas})</small></h4>` +
    (ro.porPessoa.map((p) => grupo(`p${p.pessoaId}`, true, escapeHtml(p.pessoa), `${p.itens.length} item(ns)`, p.itens,
      `<button type="button" class="btn btn-mini btn-primario" data-entregar-pessoa="${p.pessoaId}">✍ Colher assinatura</button>`, true)).join("")
      || `<p class="texto-suave">Nenhum item com responsável esperando assinatura.</p>`) +
    `<h4 class="pat-ger-sub">Descobrir quem usa — por andar e sala <small class="texto-suave">(${nDescobrir})</small></h4>` +
    (ro.descobrir.map((x, k) => grupo(`s${x.localId || 0}`, false, escapeHtml(x.local || "Sem local"), `${x.itens.length} item(ns) sem responsável`, x.itens,
      `<button type="button" class="btn btn-mini" data-sel-sala="${k}">selecionar a sala</button>`, false)).join("")
      || `<p class="texto-suave">Nenhum item em uso sem responsável.</p>`);
  renderGerSelecao();

  // locais
  const zerados = G.porLocal.filter((l) => l.zerado).length;
  $("#ger-locais").innerHTML = (zerados ? `<p class="pat-aviso">⚠ ${zerados} sala(s) sem nenhum item — conferir na conferência física.</p>` : "") +
    `<div class="tabela-scroll"><table class="tabela-metricas pat-tabela"><thead><tr><th>Andar</th><th style="text-align:left">Sala</th><th>Itens</th><th>Em uso</th><th>Estoque</th></tr></thead><tbody>` +
    G.porLocal.map((l) => `<tr class="sem-clique ${l.zerado ? "pat-ger-zerado" : ""}"><td data-rotulo="Andar">${l.andar}º</td><td data-rotulo="Sala" style="text-align:left">${escapeHtml(l.nome)}${l.ativo ? "" : ' <span class="pat-vazio">(inativo)</span>'}${l.zerado ? ' <span class="chip pat-chip-aviso">sem item</span>' : ""}</td>
      <td data-rotulo="Itens">${l.itens}</td><td data-rotulo="Em uso">${l.emUso}</td><td data-rotulo="Estoque">${l.emEstoque}</td></tr>`).join("") +
    (G.semLocal ? `<tr class="sem-clique pat-ger-zerado"><td data-rotulo="Andar">—</td><td data-rotulo="Sala" style="text-align:left"><button type="button" class="btn-mini" data-ir-alerta="semLocal">⚠ sem local</button></td><td data-rotulo="Itens">${G.semLocal}</td><td></td><td></td></tr>` : "") +
    "</tbody></table></div>";

  // responsáveis
  $("#ger-pessoas").innerHTML = G.porResponsavel.length
    ? `<div class="tabela-scroll"><table class="tabela-metricas pat-tabela"><thead><tr><th style="text-align:left">Responsável</th><th>Itens</th><th>Em uso</th><th>Sem termo</th></tr></thead><tbody>` +
      G.porResponsavel.map((p) => `<tr class="sem-clique"><td data-rotulo="Responsável" style="text-align:left"><button type="button" class="btn-mini" data-ir-pessoa="${p.pessoaId}">${escapeHtml(p.pessoa)}</button></td>
        <td data-rotulo="Itens">${p.itens}</td><td data-rotulo="Em uso">${p.emUso}</td><td data-rotulo="Sem termo">${p.semTermo ? `<span class="pat-alerta-txt">${p.semTermo}</span>` : "0"}</td></tr>`).join("") +
      "</tbody></table></div>"
    : `<p class="texto-suave">Nenhum item com responsável ainda: o responsável entra pelo termo assinado.</p>`;

  // reparo longo
  $("#ger-reparo-dias").textContent = G.reparoDias;
  $("#ger-reparo").innerHTML = G.reparoLongo.length
    ? `<ul class="pat-ger-lista">${G.reparoLongo.map((x) => `<li><span class="pat-codigo">${x.codigo}</span> ${escapeHtml(x.nome)} — <b class="pat-alerta-txt">${x.dias} dias</b>
        <small class="texto-suave">desde ${dataBr(x.desde)}${x.pessoa ? ` · ${escapeHtml(x.pessoa)}` : ""}${x.motivo ? ` · ${escapeHtml(x.motivo)}` : ""}</small></li>`).join("")}</ul>`
    : `<p class="texto-suave">✓ Nenhum item em reparo há mais de ${G.reparoDias} dias.</p>`;

  // termos do mês
  const t = G.termosDoMes;
  const ehAtual = t.mes >= G.hoje.slice(0, 7);
  $("#ger-termos").innerHTML = `<div class="pat-filtros"><button type="button" class="btn btn-mini" data-mes="-1" aria-label="mês anterior">‹</button>
      <strong class="pat-ger-mes">${nomeMes(t.mes)}</strong><button type="button" class="btn btn-mini" data-mes="1" aria-label="mês seguinte" ${ehAtual ? "disabled" : ""}>›</button></div>
    <div class="pat-ger-status">
      <span><b>${t.emitidos}</b> emitidos</span><span><b>${t.entregas}</b> entregas</span><span><b>${t.devolucoes}</b> devoluções</span>
      <span><b>${t.transferencias}</b> transferências <small class="texto-suave">(2 termos cada)</small></span>
      <span class="${t.cancelados ? "pat-alerta-txt" : ""}"><b>${t.cancelados}</b> cancelados</span>
    </div>`;
}

function renderGerSelecao() {
  $("#ger-selecao").hidden = sel.size === 0;
  $("#ger-sel-texto").textContent = `${sel.size} selecionado(s)`;
}

function irParaItens(alerta, pessoaId) {
  alertaAtivo = alerta || null;
  $("#f-busca").value = ""; $("#f-local").value = ""; $("#f-status").value = ""; $("#f-conservacao").value = "";
  $("#f-pessoa").value = pessoaId ? String(pessoaId) : "";
  $('.pat-abas .aba-btn[data-aba="itens"]').click();
  render();
}

const gerSecao = $("#aba-gerencial");
gerSecao.addEventListener("toggle", (ev) => { const d = ev.target.closest?.("[data-grupo]"); if (d) gruposAbertos.set(d.dataset.grupo, d.open); }, true);
gerSecao.addEventListener("change", (ev) => {
  const c = ev.target.closest(".ger-sel"); if (!c) return;
  const id = Number(c.dataset.item);
  c.checked ? sel.add(id) : sel.delete(id);
  renderGerSelecao(); renderSelecao();
});
gerSecao.addEventListener("click", async (ev) => {
  const ir = ev.target.closest("[data-ir-alerta]"); if (ir) return irParaItens(ir.dataset.irAlerta);
  const ip = ev.target.closest("[data-ir-pessoa]"); if (ip) return irParaItens(null, ip.dataset.irPessoa);
  const ep = ev.target.closest("[data-entregar-pessoa]");
  if (ep) {
    ev.preventDefault();
    const p = G.roteiro.porPessoa.find((x) => x.pessoaId === Number(ep.dataset.entregarPessoa));
    sel.clear(); p.itens.forEach((i) => sel.add(i.id));
    return iniciarEntrega(); // pessoa já preenchida: os itens são todos dela (regularização)
  }
  const ss = ev.target.closest("[data-sel-sala]");
  if (ss) {
    ev.preventDefault();
    const itens = G.roteiro.descobrir[Number(ss.dataset.selSala)].itens;
    const todos = itens.every((i) => sel.has(i.id));
    itens.forEach((i) => (todos ? sel.delete(i.id) : sel.add(i.id)));
    renderGerencial(); renderSelecao();
    return;
  }
  const m = ev.target.closest("[data-mes]");
  if (m) { gerMes = somarMes(gerMes, Number(m.dataset.mes)); return carregarGerencial().catch((e) => avisar(e.message, true)); }
  const tv = ev.target.closest("[data-tv-alternar]");
  if (tv) {
    try {
      const r = await api("/api/patrimonio/tv", { metodo: "PUT", corpo: { ativo: tv.dataset.tvAlternar === "1" } });
      avisar(r.ativo ? "Tela do patrimônio LIGADA na TV — entra na rotação depois do marketing." : "Tela do patrimônio desligada na TV.");
      await carregarGerencial();
    } catch (e) { avisar(e.message, true); }
  }
});
$("#ger-entregar").addEventListener("click", iniciarEntrega);
$("#ger-limpar-sel").addEventListener("click", () => { sel.clear(); renderGerencial(); renderSelecao(); });

// ---------- eventos ----------
$$(".pat-abas .aba-btn").forEach((b) => b.addEventListener("click", () => {
  $$(".pat-abas .aba-btn").forEach((x) => x.classList.toggle("ativo", x === b));
  for (const s of ["itens", "termos", "locais", "gerencial"]) $(`#aba-${s}`).hidden = s !== b.dataset.aba;
  try { sessionStorage.setItem("pat-aba", b.dataset.aba); } catch (_) {}
  if (b.dataset.aba === "gerencial") carregarGerencial().catch((e) => avisar(e.message, true));
}));
for (const id of ["#f-busca", "#f-local", "#f-pessoa", "#f-status", "#f-conservacao"]) $(id).addEventListener("input", render);
$("#pat-alertas").addEventListener("click", (ev) => { const b = ev.target.closest("[data-alerta]"); if (!b) return; alertaAtivo = b.dataset.alerta || null; render(); });
$$("#pat-tabela th[data-ord]").forEach((th) => th.addEventListener("click", () => {
  ordem = { campo: th.dataset.ord, dir: ordem.campo === th.dataset.ord ? -ordem.dir : 1 }; render();
}));
$("#sel-todos").addEventListener("change", (ev) => {
  for (const i of filtrados()) if (i.status !== "baixado") ev.target.checked ? sel.add(i.id) : sel.delete(i.id);
  render();
});
const tbody = $("#pat-tabela tbody");
tbody.addEventListener("change", async (ev) => {
  const tr = ev.target.closest("tr[data-id]"); if (!tr) return;
  const id = Number(tr.dataset.id);
  if (ev.target.classList.contains("sel-item")) { ev.target.checked ? sel.add(id) : sel.delete(id); tr.classList.toggle("pat-sel", ev.target.checked); renderSelecao(); return; }
  const campo = ev.target.dataset.campo;
  if (campo === "localId" || campo === "conservacao") {
    const v = ev.target.value;
    if (await salvarCampo(id, { [campo]: campo === "localId" ? (v ? Number(v) : null) : v || null })) avisar("Salvo.");
    render();
  }
});
tbody.addEventListener("click", (ev) => {
  const tr = ev.target.closest("tr[data-id]"); if (!tr) return;
  const item = D.itens.find((i) => i.id === Number(tr.dataset.id));
  if (ev.target.closest("[data-menu-status]")) return menuStatus(item);
  if (ev.target.closest("[data-historico]")) return verHistorico(item);
  const td = ev.target.closest("td.pat-editavel"); if (td) editarCelula(td);
});
tbody.addEventListener("keydown", (ev) => {
  const td = ev.target.closest("td.pat-editavel");
  if (td && ev.key === "Enter" && !td.querySelector("input")) { ev.preventDefault(); editarCelula(td); }
});
$("#btn-entregar").addEventListener("click", iniciarEntrega);
$("#btn-devolver").addEventListener("click", iniciarDevolucao);
$("#btn-limpar-sel").addEventListener("click", () => { sel.clear(); render(); });

$("#pat-termos").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-cancelar]"); if (!b) return;
  const t = D.termos.find((x) => x.id === Number(b.dataset.cancelar));
  const motivo = await pedirTexto(`Cancelar o termo ${t.numero}`, `Os itens voltam ao estado de antes do termo${t.relacionadoId ? " (transferência: os dois termos são cancelados)" : ""}. Motivo (obrigatório):`, "Cancelar termo");
  if (!motivo) return;
  try { const r = await api(`/api/patrimonio/termos/${t.id}/cancelar`, { metodo: "POST", corpo: { motivo } }); avisar(`Termo ${r.cancelados} cancelado (${r.itens} item(ns)).`); await carregar(); }
  catch (e) { avisar(e.message, true); }
});

$("#btn-novo-local").addEventListener("click", async () => {
  try { await api("/api/patrimonio/locais", { metodo: "POST", corpo: { andar: Number($("#novo-andar").value), nome: $("#novo-local").value } }); $("#novo-local").value = ""; avisar("Local criado."); await carregar(); }
  catch (e) { avisar(e.message, true); }
});
$("#pat-locais").addEventListener("change", async (ev) => {
  const tr = ev.target.closest("tr[data-local]"); if (!tr || !ev.target.matches("[data-nome-local]")) return;
  try { await api(`/api/patrimonio/locais/${tr.dataset.local}`, { metodo: "PATCH", corpo: { nome: ev.target.value } }); avisar("Local renomeado."); await carregar(); }
  catch (e) { avisar(e.message, true); await carregar(); }
});
$("#pat-locais").addEventListener("click", async (ev) => {
  const tr = ev.target.closest("tr[data-local]"); if (!tr || !ev.target.matches("[data-ativo-local]")) return;
  const l = D.locais.find((x) => x.id === Number(tr.dataset.local));
  try { await api(`/api/patrimonio/locais/${l.id}`, { metodo: "PATCH", corpo: { ativo: !l.ativo } }); await carregar(); }
  catch (e) { avisar(e.message, true); }
});

$("#btn-importar").addEventListener("click", async () => {
  const f = $("#arquivo-xlsx").files[0];
  if (!f) { avisar("Escolha a planilha .xlsx.", true); return; }
  $("#btn-importar").disabled = true;
  try {
    const r = await api(`/api/patrimonio/importar?arquivo=${encodeURIComponent(f.name)}`, { metodo: "POST", bruto: await f.arrayBuffer() });
    renderRelatorio(r); avisar(`${r.importadas} importadas, ${r.ignoradas.length} ignoradas.`); await carregar();
  } catch (e) { avisar(e.message, true); }
  finally { $("#btn-importar").disabled = false; }
});
$("#btn-sair").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }).catch(() => {}); location.href = "/login"; });

try { const a = sessionStorage.getItem("pat-aba"); if (a) $(`.pat-abas .aba-btn[data-aba="${a}"]`)?.click(); } catch (_) {}
carregar().catch((e) => avisar(e.message, true));
