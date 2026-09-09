"use strict";

// /territorio — mapas de PR e SC em SVG puro (malha do IBGE embutida, sem CDN)
// com drill down estado → regional → município, cobertura do casamento cidade
// → município e revisão manual com confirmação em lote.
// Estado de navegação em location.hash: #/  |  #/r/<regionalId>  |  #/m/<codigoIbge>
// (+ ?de=&ate= quando há período) — o botão voltar do navegador funciona.

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

const reais = (c) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format((c || 0) / 100);
const inteiro = (n) => (n || 0).toLocaleString("pt-BR");
const pctTexto = (p) => (p == null ? "—" : p.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%");
const pctDe = (v, t) => (t ? pctTexto(Math.round((v / t) * 1000) / 10) : "—");
const dataBr = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join("/") : "—");
const ticket = (receita, n) => (n ? reais(Math.round(receita / n)) : "—");

function avisar(texto, erro = false) {
  const el = document.getElementById("aviso");
  el.textContent = texto;
  el.classList.toggle("aviso-erro", erro);
  el.classList.add("visivel");
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => el.classList.remove("visivel"), erro ? 6000 : 3500);
}

// ---------- Período e rota (hash) ----------

const periodo = { de: null, ate: null };
let modo = "receita"; // receita | matriculas | prospeccao

function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function lerPeriodoDaTela() {
  const m = document.querySelector('input[name="modo-periodo"]:checked').value;
  if (m === "inteiro") return { de: null, ate: null };
  const de = document.getElementById("periodo-de").value;
  const ate = document.getElementById("periodo-ate").value;
  if (!de || !ate) throw new Error("Informe as duas datas do intervalo.");
  if (ate < de) throw new Error("A data final não pode ser anterior à inicial.");
  return { de, ate };
}

const queryPeriodo = () => (periodo.de ? `?de=${periodo.de}&ate=${periodo.ate}` : "");

function refletirPeriodoNaTela() {
  const intervalo = Boolean(periodo.de);
  document.querySelector(`input[name="modo-periodo"][value="${intervalo ? "intervalo" : "inteiro"}"]`).checked = true;
  alternarCamposPeriodo();
  if (intervalo) {
    document.getElementById("periodo-de").value = periodo.de;
    document.getElementById("periodo-ate").value = periodo.ate;
  }
  document.getElementById("periodo-legenda").textContent = intervalo
    ? `matrículas criadas de ${dataBr(periodo.de)} a ${dataBr(periodo.ate)}`
    : "toda a base de matrículas";
}

function preencherMes(deslocamento) {
  const hoje = new Date();
  const ini = new Date(hoje.getFullYear(), hoje.getMonth() + deslocamento, 1);
  const fim = new Date(hoje.getFullYear(), hoje.getMonth() + deslocamento + 1, 0);
  document.querySelector('input[name="modo-periodo"][value="intervalo"]').checked = true;
  alternarCamposPeriodo();
  document.getElementById("periodo-de").value = isoLocal(ini);
  document.getElementById("periodo-ate").value = isoLocal(fim);
}

function alternarCamposPeriodo() {
  const intervalo = document.querySelector('input[name="modo-periodo"]:checked').value === "intervalo";
  document.getElementById("periodo-de").disabled = !intervalo;
  document.getElementById("periodo-ate").disabled = !intervalo;
}

function lerRota() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [caminho, query = ""] = h.split("?");
  const q = new URLSearchParams(query);
  const partes = caminho.split("/").filter(Boolean);
  const rota = { nivel: "estado", id: null, de: q.get("de") || null, ate: q.get("ate") || null };
  if (partes[0] === "r" && partes[1]) { rota.nivel = "regional"; rota.id = Number(partes[1]); }
  if (partes[0] === "m" && partes[1]) { rota.nivel = "municipio"; rota.id = Number(partes[1]); }
  if (!rota.de || !rota.ate) { rota.de = null; rota.ate = null; }
  return rota;
}

function hashDe(nivel, id) {
  const caminho = nivel === "regional" ? `/r/${id}` : nivel === "municipio" ? `/m/${id}` : "/";
  return `#${caminho}${queryPeriodo()}`;
}

function irPara(nivel, id) {
  location.hash = hashDe(nivel, id);
}

// ---------- Dados ----------

const cache = { agregado: new Map(), municipio: new Map() };
let referencia = null; // { regionais, municipios }

async function agregado() {
  const k = queryPeriodo();
  if (!cache.agregado.has(k)) cache.agregado.set(k, await chamarApi("/api/territorio/agregado" + k));
  return cache.agregado.get(k);
}

async function detalheMunicipio(codigo) {
  const k = codigo + queryPeriodo();
  if (!cache.municipio.has(k)) cache.municipio.set(k, await chamarApi(`/api/territorio/municipios/${codigo}${queryPeriodo()}`));
  return cache.municipio.get(k);
}

function limparCache() {
  cache.agregado.clear();
  cache.municipio.clear();
}

// ---------- Mapa (SVG puro) ----------

const NS = "http://www.w3.org/2000/svg";
const CORES_ESCALA = ["#12303f", "#155a6e", "#1b8798", "#2ab5c2", "#8af3f8"]; // mais escuro = menor
const COR_NEUTRA = "#232a3d";   // sem dado em nenhum período
const COR_CLIENTE = "#2cb0bb";  // modo prospecção: já comprou
const COR_NUNCA = "#ffc857";    // modo prospecção: nunca comprou
const COR_FORA = "#141827";     // fora do recorte (esmaecido)

const malha = { pronta: null, grupos: {}, transform: [0.0001, -0.0001], bboxPath: new Map() };

// Baixa o SVG uma vez, guarda os <g> de cada UF e mede o bbox de cada path
// (num svg temporário visível, porque getBBox não funciona em display:none).
async function carregarMalha() {
  if (malha.pronta) return malha.pronta;
  malha.pronta = (async () => {
    const r = await fetch("/api/territorio/mapa");
    if (r.status === 401) { location.href = "/login"; throw new Error("sessão expirada"); }
    if (!r.ok) throw new Error("mapa indisponível (" + r.status + ")");
    const doc = new DOMParser().parseFromString(await r.text(), "image/svg+xml");
    const medidor = document.createElementNS(NS, "svg");
    medidor.setAttribute("style", "position:absolute;width:10px;height:10px;left:-9999px;top:0;opacity:0");
    document.body.appendChild(medidor);
    for (const g of doc.querySelectorAll("g[data-uf]")) {
      const uf = g.getAttribute("data-uf");
      const m = (g.getAttribute("transform") || "").match(/scale\(([-\d.e]+),([-\d.e]+)\)/);
      if (m) malha.transform = [Number(m[1]), Number(m[2])];
      const copia = document.importNode(g, true);
      medidor.appendChild(copia);
      for (const p of copia.querySelectorAll("path")) {
        const b = p.getBBox();
        malha.bboxPath.set(Number(p.id.slice(1)), { x: b.x, y: b.y, w: b.width, h: b.height });
      }
      medidor.removeChild(copia);
      malha.grupos[uf] = g; // original (do documento parseado), clonado a cada render
    }
    document.body.removeChild(medidor);
    return malha;
  })();
  return malha.pronta;
}

// bbox de um conjunto de códigos, já em coordenadas do viewBox (transform aplicado)
function bboxDe(codigos) {
  const [sx, sy] = malha.transform;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of codigos) {
    const b = malha.bboxPath.get(c);
    if (!b) continue;
    const xs = [b.x * sx, (b.x + b.w) * sx];
    const ys = [b.y * sy, (b.y + b.h) * sy];
    x0 = Math.min(x0, ...xs); x1 = Math.max(x1, ...xs);
    y0 = Math.min(y0, ...ys); y1 = Math.max(y1, ...ys);
  }
  return isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function centroDe(codigo) {
  const b = malha.bboxPath.get(codigo);
  const [sx, sy] = malha.transform;
  return b ? { x: (b.x + b.w / 2) * sx, y: (b.y + b.h / 2) * sy } : null;
}

function viewBoxTexto(b, margem = 0.06) {
  const mx = b.w * margem, my = b.h * margem;
  return `${b.x - mx} ${b.y - my} ${b.w + 2 * mx} ${b.h + 2 * my}`;
}

// Quantis sobre os valores > 0 → função valor → cor (zero no período = classe mais escura)
function escalaQuantis(valores) {
  const v = valores.filter((x) => x > 0).sort((a, b) => a - b);
  const n = CORES_ESCALA.length;
  const cortes = Array.from({ length: n - 1 }, (_, i) => v[Math.min(v.length - 1, Math.floor(((i + 1) * v.length) / n))] ?? 0);
  return {
    cor: (x) => {
      if (!(x > 0)) return CORES_ESCALA[0];
      let i = 0;
      while (i < cortes.length && x > cortes[i]) i++;
      return CORES_ESCALA[Math.min(i, n - 1)];
    },
    cortes, temValores: v.length > 0,
  };
}

// Monta um <svg> com a malha de uma UF, pinta cada município pela função `estilo(codigo)`
// → { cor, opacidade, classe, hachura } e devolve o elemento.
function montarSvg(uf, viewBox, estilo, opcoes = {}) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("class", "mapa-svg");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const defs = document.createElementNS(NS, "defs");
  defs.innerHTML = `<pattern id="hachura-${uf}" patternUnits="userSpaceOnUse" width="0.06" height="0.06" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="0.06" stroke="rgba(255,255,255,0.45)" stroke-width="0.015"/></pattern>`;
  svg.appendChild(defs);
  const g = document.importNode(malha.grupos[uf], true);
  g.removeAttribute("id");
  const escala = Math.abs(malha.transform[0]);
  const larguraTraco = (opcoes.traco || 0.006) / escala; // em unidades do path (dentro do transform)
  for (const p of g.querySelectorAll("path")) {
    const codigo = Number(p.id.slice(1));
    p.removeAttribute("id");
    p.dataset.codigo = codigo;
    const e = estilo(codigo) || {};
    p.setAttribute("fill", e.cor || COR_NEUTRA);
    p.setAttribute("stroke", e.traco || "#0b0e17");
    p.setAttribute("stroke-width", String((e.tracoLargura || 1) * larguraTraco));
    p.setAttribute("vector-effect", "none");
    if (e.opacidade != null) p.setAttribute("opacity", String(e.opacidade));
    if (e.classe) p.setAttribute("class", e.classe);
    if (e.hachura) {
      const h = p.cloneNode(true);
      h.setAttribute("fill", `url(#hachura-${uf})`);
      h.setAttribute("stroke", "none");
      h.setAttribute("pointer-events", "none");
      p.after(h);
    }
  }
  svg.appendChild(g);
  // Rótulos ficam fora do transform (que espelha o eixo y): coordenadas já convertidas
  if (opcoes.rotulos) {
    const gr = document.createElementNS(NS, "g");
    gr.setAttribute("class", "mapa-rotulos");
    gr.setAttribute("pointer-events", "none");
    const vb = viewBox.split(" ").map(Number);
    for (const r of opcoes.rotulos) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", r.x);
      t.setAttribute("y", r.y);
      t.setAttribute("font-size", String(vb[2] * (r.tamanho || 0.018)));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("dominant-baseline", "middle");
      t.setAttribute("class", r.classe || "");
      t.textContent = r.texto;
      gr.appendChild(t);
    }
    svg.appendChild(gr);
  }
  return svg;
}

function legendaHtml(itens) {
  return `<div class="mapa-legenda">${itens.map((i) => `<span class="mapa-legenda-item"><i style="background:${i.cor};${i.hachura ? "background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.45) 0 2px,transparent 2px 5px);" : ""}${i.borda ? `border:1px dashed ${i.borda};` : ""}"></i>${escapeHtml(i.texto)}</span>`).join("")}</div>`;
}

function legendaEscala(escala, formatar, rotuloZero) {
  if (!escala.temValores) return legendaHtml([{ cor: COR_NEUTRA, texto: "sem dado" }]);
  const faixas = CORES_ESCALA.map((cor, i) => {
    const ini = i === 0 ? null : escala.cortes[i - 1];
    const fim = i < escala.cortes.length ? escala.cortes[i] : null;
    const texto = i === 0 ? `${rotuloZero} a ${formatar(fim)}` : fim == null ? `acima de ${formatar(ini)}` : `${formatar(ini)} a ${formatar(fim)}`;
    return { cor, texto };
  });
  return legendaHtml([...faixas, { cor: COR_NEUTRA, texto: "sem dado (nunca comprou)", borda: "#4a5270" }]);
}

// ---------- Tooltip ----------

const tooltip = document.getElementById("tooltip");
function mostrarTooltip(ev, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  moverTooltip(ev);
}
function moverTooltip(ev) {
  const margem = 14;
  let x = ev.clientX + margem, y = ev.clientY + margem;
  const r = tooltip.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - margem;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - margem;
  tooltip.style.left = x + "px";
  tooltip.style.top = y + "px";
}
function esconderTooltip() {
  tooltip.hidden = true;
}

// ---------- Renderização dos níveis ----------

function card(rotulo, valor, extra = "", classe = "") {
  return `<div class="metrica-card ${classe}"><span class="metrica-rotulo">${escapeHtml(rotulo)}</span>
    <span class="metrica-valor">${valor}</span><span class="metrica-extra">${extra}</span></div>`;
}

function renderizarConferencia(c) {
  const el = document.getElementById("conferencia");
  const linhas = c.elos.map((e) => `<li class="${e.bate ? "saude-ok" : "saude-alerta"}">${e.bate ? "✓" : "✗"} ${escapeHtml(e.rotulo)}:
    ${inteiro(e.a.matriculas)} matr. / ${reais(e.a.receitaCentavos)} ${e.bate ? "=" : "≠"} ${inteiro(e.b.matriculas)} / ${reais(e.b.receitaCentavos)}
    ${e.bate ? "" : `<strong>(diferença ${e.diferenca.matriculas} matr. / ${reais(e.diferenca.receitaCentavos)})</strong>`}</li>`).join("");
  el.className = "territorio-conferencia " + (c.bate ? "territorio-conferencia-ok" : "territorio-conferencia-erro");
  el.innerHTML = `<details ${c.bate ? "" : "open"}><summary>${c.bate
    ? "✓ Conferência fecha: municípios = regionais = estados, e estados + outros estados + sem município = total = receita do período em /api/metricas"
    : "✗ CONFERÊNCIA NÃO FECHA — os números abaixo não batem com os relatórios; não ajustado automaticamente"}</summary>
    <ul class="lista-simples">${linhas}</ul></details>`;
}

function breadcrumb(itens) {
  document.getElementById("breadcrumb").innerHTML = itens
    .map((it, i) => (i === itens.length - 1 || !it.hash)
      ? `<span class="territorio-atual">${escapeHtml(it.rotulo)}</span>`
      : `<a href="${it.hash}">${escapeHtml(it.rotulo)}</a>`)
    .join('<span class="territorio-seta">›</span>');
}

function tabela(colunas, linhasHtml, rodapeHtml = "") {
  return `<div class="tabela-scroll"><table class="tabela-metricas territorio-tabela">
    <thead><tr>${colunas.map((c) => `<th${c.esq ? ' style="text-align:left"' : ""}>${escapeHtml(c.t)}</th>`).join("")}</tr></thead>
    <tbody>${linhasHtml}</tbody>${rodapeHtml ? `<tfoot>${rodapeHtml}</tfoot>` : ""}</table></div>`;
}

const semDado = (texto) => `<tr class="sem-clique"><td colspan="9" class="texto-suave">${escapeHtml(texto)}</td></tr>`;

const valorDoModo = (x) => (modo === "matriculas" ? x.matriculas : x.receitaCentavos);
const formatarModo = (v) => (modo === "matriculas" ? inteiro(v) : reais(v));
const rotuloModo = () => (modo === "matriculas" ? "matrículas" : "receita");

function tooltipMunicipio(m, extra = "") {
  return `<strong>${escapeHtml(m.nome)}</strong> <span class="texto-suave">${escapeHtml(m.uf)}</span><br>
    ${m.temHistorico ? `${reais(m.receitaCentavos)} · ${inteiro(m.matriculas)} matrícula(s) · ${inteiro(m.alunos)} aluno(s)${m.matriculas ? "" : " — zero no período"}` : "<em>nunca comprou</em>"}${extra}`;
}

// ---- nível ESTADO: PR e SC lado a lado ----
function renderizarEstado(a) {
  breadcrumb([{ rotulo: "PR e SC" }]);
  const regionalDe = new Map(a.regionais.map((r) => [r.id, r]));
  const municipioDe = new Map(a.municipios.map((m) => [m.codigo, m]));
  const escala = escalaQuantis(a.regionais.map(valorDoModo));
  const estilo = (codigo) => {
    const m = municipioDe.get(codigo);
    if (!m) return { cor: COR_NEUTRA };
    if (modo === "prospeccao") return { cor: m.temHistorico ? COR_CLIENTE : COR_NUNCA, opacidade: m.temHistorico ? 0.9 : 0.75 };
    const r = regionalDe.get(m.regionalPrincipalId);
    if (!r) return { cor: COR_NEUTRA };
    return { cor: escala.cor(valorDoModo(r)), classe: "mapa-regional-" + r.id };
  };
  const mapas = a.estados.map((e) => {
    const codigos = a.municipios.filter((m) => m.uf === e.uf).map((m) => m.codigo);
    const vb = viewBoxTexto(bboxDe(codigos));
    const rotulos = modo === "prospeccao" ? [] : a.regionais.filter((r) => r.uf === e.uf).map((r) => {
      const b = bboxDe(a.municipios.filter((m) => m.regionalPrincipalId === r.id).map((m) => m.codigo));
      return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2, texto: r.sigla, classe: "mapa-rotulo-regional", tamanho: 0.02 } : null;
    }).filter(Boolean);
    const svg = montarSvg(e.uf, vb, estilo, { rotulos });
    svg.dataset.uf = e.uf;
    const totalMun = a.municipios.filter((m) => m.uf === e.uf).length;
    const clientes = a.municipios.filter((m) => m.uf === e.uf && m.temHistorico).length;
    const legenda = `<div class="mapa-titulo"><strong>${e.uf === "PR" ? "Paraná" : "Santa Catarina"}</strong>
        <span>${reais(e.receitaCentavos)} · ${inteiro(e.matriculas)} matrículas · ${inteiro(e.alunos)} alunos</span></div>
      <div class="mapa-cobertura"><div class="mapa-cobertura-barra"><i style="width:${Math.round((clientes / totalMun) * 100)}%"></i></div>
        <span><strong>${clientes}</strong> de ${totalMun} municípios já compraram (${pctDe(clientes, totalMun)}) · ${e.municipiosComDado} com dado no período</span></div>`;
    return { e, svg, legenda };
  });
  const area = document.getElementById("mapa-area");
  area.innerHTML = "";
  const grade = document.createElement("div");
  grade.className = "mapa-grade mapa-grade-estado";
  for (const { e, svg, legenda } of mapas) {
    const bloco = document.createElement("div");
    bloco.className = "mapa-bloco";
    bloco.dataset.uf = e.uf;
    bloco.innerHTML = legenda;
    bloco.appendChild(svg);
    grade.appendChild(bloco);
  }
  const lateral = document.createElement("div");
  lateral.className = "mapa-lateral";
  lateral.innerHTML = cardsForaDoMapa(a);
  grade.appendChild(lateral);
  area.appendChild(grade);
  const pr = a.estados.find((e) => e.uf === "PR"), sc = a.estados.find((e) => e.uf === "SC");
  const clientesPr = a.municipios.filter((m) => m.uf === "PR" && m.temHistorico).length;
  const clientesSc = a.municipios.filter((m) => m.uf === "SC" && m.temHistorico).length;
  const comparacao = `<p class="mapa-comparacao">PR: ${pr.municipiosComDado} municípios com dado no período (${clientesPr} clientes de ${a.municipios.filter((m) => m.uf === "PR").length}) ·
    SC: ${sc.municipiosComDado} com dado (${clientesSc} clientes de ${a.municipios.filter((m) => m.uf === "SC").length}) —
    <strong>${inteiro(a.municipios.filter((m) => m.uf === "SC" && !m.temHistorico).length)} municípios catarinenses nunca compraram</strong>, contra ${inteiro(a.municipios.filter((m) => m.uf === "PR" && !m.temHistorico).length)} no Paraná.</p>`;
  area.insertAdjacentHTML("beforeend", (modo === "prospeccao"
    ? legendaHtml([{ cor: COR_CLIENTE, texto: `já cliente (${clientesPr + clientesSc})` }, { cor: COR_NUNCA, texto: `nunca comprou (${a.municipios.length - clientesPr - clientesSc})` }])
    : legendaEscala(escala, formatarModo, "zero")) + comparacao);
  ligarInteracaoMapa(area, (codigo) => {
    const m = municipioDe.get(codigo);
    const r = m && regionalDe.get(m.regionalPrincipalId);
    return {
      html: r ? `<strong>${escapeHtml(r.sigla)}</strong> — ${escapeHtml(r.nome || "")}<br>${reais(r.receitaCentavos)} · ${inteiro(r.matriculas)} matrículas · ${r.municipiosComDado}/${r.municipios} municípios com dado<br><span class="texto-suave">${escapeHtml(m.nome)}: ${m.temHistorico ? reais(m.receitaCentavos) : "nunca comprou"}</span>` : tooltipMunicipio(m),
      destaque: r ? `.mapa-regional-${r.id}` : null,
      clique: () => (r ? irPara("regional", r.id) : irPara("municipio", codigo)),
    };
  });

  const regionais = [...a.regionais].sort((x, y) => valorDoModo(y) - valorDoModo(x) || y.matriculas - x.matriculas);
  const estadoDe = new Map(a.estados.map((e) => [e.uf, e]));
  const linhas = regionais.map((r) => `<tr data-ir="regional" data-id="${r.id}">
    <td>${escapeHtml(r.uf)}</td><td class="celula-nome">${escapeHtml(r.sigla)}<div class="texto-suave territorio-descricao">${escapeHtml(r.nome || "")}${r.cidadePolo ? " · polo " + escapeHtml(r.cidadePolo) : ""}</div></td>
    <td>${r.municipiosComDado}/${r.municipios}</td><td>${inteiro(r.matriculas)}</td><td>${inteiro(r.alunos)}</td>
    <td>${reais(r.receitaCentavos)}</td><td>${ticket(r.receitaCentavos, r.matriculas)}</td>
    <td>${pctDe(r.receitaCentavos, estadoDe.get(r.uf)?.receitaCentavos)}</td>
    <td class="texto-suave">${r.compartilhados.municipios.length ? `+${reais(r.compartilhados.receitaCentavos)} em ${r.compartilhados.municipios.length}` : ""}</td>
  </tr>`).join("");
  document.getElementById("nivel-conteudo").innerHTML = `
    <h2 class="secao-titulo">Regionais <span class="texto-suave territorio-dica">clique para abrir</span></h2>
    ${tabela([{ t: "UF" }, { t: "Regional", esq: true }, { t: "Mun. c/ dado" }, { t: "Matrículas" }, { t: "Alunos" }, { t: "Receita" }, { t: "Ticket" }, { t: "% do estado" }, { t: "Compartilhados", esq: true }],
      linhas || semDado("Nenhuma regional carregada — confira dados/regionais_municipios_PR_SC.csv."))}`;
}

function cardsForaDoMapa(a) {
  const outros = a.outrosEstados;
  const listaUf = outros.porUf.map((u) => `<li><span>${escapeHtml(u.uf || "UF desconhecida")}</span><span>${inteiro(u.matriculas)} · ${reais(u.receitaCentavos)}</span></li>`).join("");
  const sem = a.semMunicipio;
  const rotuloGrupo = { sem_cidade: "sem cidade no cadastro", pendente: "pendentes de revisão", ignorado: "ignoradas na revisão", nao_processado: "não processadas" };
  return `<div class="metrica-card territorio-card-lista"><span class="metrica-rotulo">Outros estados (fora de PR/SC)</span>
      <span class="metrica-valor">${reais(outros.receitaCentavos)}</span>
      <span class="metrica-extra">${inteiro(outros.matriculas)} matrículas · ${pctDe(outros.receitaCentavos, a.total.receitaCentavos)} da receita — fora do mapa, dentro do total</span>
      <ul class="lista-simples territorio-lista-uf">${listaUf || "<li><span class='texto-suave'>nenhuma</span></li>"}</ul></div>
    ${card("Sem município", reais(sem.receitaCentavos), `${inteiro(sem.matriculas)} matrículas: ` + (sem.porGrupo.map((g) => `${inteiro(g.matriculas)} ${rotuloGrupo[g.grupo] || g.grupo}`).join(" · ") || "nenhuma"))}
    ${card("Total do período", reais(a.total.receitaCentavos), `${inteiro(a.total.matriculas)} matrículas — mesmo filtro de /relatorios`)}`;
}

// ---- nível REGIONAL (também usado como pano de fundo do MUNICÍPIO) ----
function mapaRegional(a, r, destaqueCodigo = null) {
  const municipioDe = new Map(a.municipios.map((m) => [m.codigo, m]));
  const proprios = a.municipios.filter((m) => m.regionalPrincipalId === r.id);
  const compart = new Set(r.compartilhados.municipios.map((c) => c.codigo));
  const dentro = new Set([...proprios.map((m) => m.codigo), ...compart]);
  const escala = escalaQuantis([...dentro].map((c) => valorDoModo(municipioDe.get(c))));
  const estilo = (codigo) => {
    const m = municipioDe.get(codigo);
    if (!m || !dentro.has(codigo)) return { cor: COR_FORA, opacidade: 0.5, classe: "mapa-fora" };
    const base = modo === "prospeccao"
      ? { cor: m.temHistorico ? COR_CLIENTE : COR_NUNCA }
      : { cor: m.temHistorico ? escala.cor(valorDoModo(m)) : COR_NEUTRA, traco: m.temHistorico ? undefined : "#4a5270" };
    if (compart.has(codigo)) base.hachura = true;
    if (codigo === destaqueCodigo) { base.traco = "#ffffff"; base.tracoLargura = 3; base.classe = "mapa-destaque"; }
    return base;
  };
  const vb = viewBoxTexto(bboxDe([...dentro]), 0.08);
  const rotulos = [...dentro].map((c) => {
    const p = centroDe(c);
    const m = municipioDe.get(c);
    return p && m ? { x: p.x, y: p.y, texto: m.nome, classe: "mapa-rotulo-municipio" + (m.temHistorico ? "" : " mapa-rotulo-vazio"), tamanho: 0.016 } : null;
  }).filter(Boolean);
  const svg = montarSvg(r.uf, vb, estilo, { rotulos, traco: 0.004 });
  const legenda = modo === "prospeccao"
    ? legendaHtml([{ cor: COR_CLIENTE, texto: `já cliente (${proprios.filter((m) => m.temHistorico).length})` }, { cor: COR_NUNCA, texto: `nunca comprou (${proprios.filter((m) => !m.temHistorico).length})` }, { cor: COR_CLIENTE, hachura: true, texto: "compartilhado (contado em outra regional)" }])
    : legendaEscala(escala, formatarModo, "zero no período") + (compart.size ? legendaHtml([{ cor: COR_CLIENTE, hachura: true, texto: "compartilhado (contado em outra regional)" }]) : "");
  return { svg, legenda, municipioDe, proprios };
}

function renderizarRegional(a, id) {
  const r = a.regionais.find((x) => x.id === id);
  if (!r) return renderizarEstado(a);
  breadcrumb([{ rotulo: "PR e SC", hash: hashDe("estado") }, { rotulo: `${r.sigla} (${r.uf})` }]);
  const { svg, legenda, municipioDe, proprios } = mapaRegional(a, r);
  const area = document.getElementById("mapa-area");
  area.innerHTML = "";
  const grade = document.createElement("div");
  grade.className = "mapa-grade mapa-grade-regional";
  const bloco = document.createElement("div");
  bloco.className = "mapa-bloco mapa-bloco-grande";
  bloco.innerHTML = `<div class="mapa-titulo"><strong>${escapeHtml(r.sigla)}</strong> <span>${escapeHtml(r.nome || "")}${r.cidadePolo ? " · polo " + escapeHtml(r.cidadePolo) : ""}</span></div>`;
  bloco.appendChild(svg);
  bloco.insertAdjacentHTML("beforeend", legenda);
  grade.appendChild(bloco);
  const lateral = document.createElement("div");
  lateral.className = "mapa-lateral";
  const nunca = proprios.filter((m) => !m.temHistorico);
  lateral.innerHTML = `
    ${card("Receita", reais(r.receitaCentavos), `${pctDe(r.receitaCentavos, a.estados.find((e) => e.uf === r.uf)?.receitaCentavos)} do ${r.uf} · ${inteiro(r.matriculas)} matrículas · ${inteiro(r.alunos)} alunos · ticket ${ticket(r.receitaCentavos, r.matriculas)}`)}
    ${card("Municípios", `${r.municipiosComDado}/${r.municipios}`, `com dado no período / na regional (principal) · <strong>${proprios.filter((m) => m.temHistorico).length} já compraram</strong>`)}
    <div class="metrica-card territorio-card-lista mapa-card-vazio"><span class="metrica-rotulo">Nunca compraram — o próximo cliente</span>
      <span class="metrica-valor">${inteiro(nunca.length)}</span>
      <span class="metrica-extra">de ${proprios.length} municípios da regional</span>
      <div class="territorio-chips">${nunca.sort((x, y) => x.nome.localeCompare(y.nome)).map((m) => `<a class="chip chip-vazio" href="${hashDe("municipio", m.codigo)}">${escapeHtml(m.nome)}</a>`).join("") || "<span class='saude-ok'>todos já compraram</span>"}</div></div>
    ${r.compartilhados.municipios.length ? card("Compartilhados", `+${reais(r.compartilhados.receitaCentavos)}`, `${inteiro(r.compartilhados.matriculas)} matrículas em ${r.compartilhados.municipios.length} município(s) contados em outra regional — fora do total acima`) : ""}`;
  grade.appendChild(lateral);
  area.appendChild(grade);
  ligarInteracaoMapa(area, (codigo) => {
    const m = municipioDe.get(codigo);
    if (!m) return null;
    const c = r.compartilhados.municipios.find((x) => x.codigo === codigo);
    return {
      html: tooltipMunicipio(m, c ? `<br><span class="texto-suave">compartilhado — contado em ${escapeHtml(c.contadoEm || "?")}</span>` : ""),
      clique: () => irPara("municipio", codigo),
    };
  });

  const ordenados = [...proprios].sort((x, y) => valorDoModo(y) - valorDoModo(x) || y.matriculas - x.matriculas || x.nome.localeCompare(y.nome));
  const linhaMun = (m, extra = "") => `<tr data-ir="municipio" data-id="${m.codigo}" class="${m.temHistorico ? "" : "territorio-sem-historico"}">
    <td class="celula-nome">${escapeHtml(m.nome)}${extra}</td><td>${inteiro(m.matriculas)}</td><td>${inteiro(m.alunos)}</td>
    <td>${reais(m.receitaCentavos)}</td><td>${ticket(m.receitaCentavos, m.matriculas)}</td><td>${pctDe(m.receitaCentavos, r.receitaCentavos)}</td>
    <td class="texto-suave">${m.temHistorico ? (m.matriculas ? "" : "zero no período") : "nunca comprou"}</td></tr>`;
  const compart = r.compartilhados.municipios.map((c) => linhaMun(municipioDe.get(c.codigo),
    `<div class="texto-suave territorio-descricao">compartilhado — contado em ${escapeHtml(c.contadoEm || "?")}</div>`)).join("");
  document.getElementById("nivel-conteudo").innerHTML = `
    <h3 class="secao-titulo">Municípios <span class="texto-suave territorio-dica">clique para abrir</span></h3>
    ${tabela([{ t: "Município", esq: true }, { t: "Matrículas" }, { t: "Alunos" }, { t: "Receita" }, { t: "Ticket" }, { t: "% da regional" }, { t: "", esq: true }],
      ordenados.map((m) => linhaMun(m)).join("") || semDado("Nenhum município nesta regional."))}
    ${compart ? `<h3 class="secao-titulo">Também nesta regional, contados em outra</h3>
      ${tabela([{ t: "Município", esq: true }, { t: "Matrículas" }, { t: "Alunos" }, { t: "Receita" }, { t: "Ticket" }, { t: "" }, { t: "", esq: true }], compart)}` : ""}`;
}

// ---- nível MUNICÍPIO ----
async function renderizarMunicipio(a, codigo) {
  const d = await detalheMunicipio(codigo);
  const m = d.municipio;
  const r = a.regionais.find((x) => x.id === m.regionalPrincipalId);
  breadcrumb([
    { rotulo: "PR e SC", hash: hashDe("estado") },
    ...(r ? [{ rotulo: `${r.sigla} (${r.uf})`, hash: hashDe("regional", r.id) }] : []),
    { rotulo: m.nome },
  ]);
  const area = document.getElementById("mapa-area");
  area.innerHTML = "";
  if (r) {
    const { svg, legenda, municipioDe } = mapaRegional(a, r, codigo);
    const grade = document.createElement("div");
    grade.className = "mapa-grade mapa-grade-regional";
    const bloco = document.createElement("div");
    bloco.className = "mapa-bloco mapa-bloco-grande";
    bloco.innerHTML = `<div class="mapa-titulo"><strong>${escapeHtml(m.nome)}</strong> <span>em ${escapeHtml(r.sigla)} — clique em um vizinho para abrir</span></div>`;
    bloco.appendChild(svg);
    bloco.insertAdjacentHTML("beforeend", legenda);
    grade.appendChild(bloco);
    const lateral = document.createElement("div");
    lateral.className = "mapa-lateral";
    lateral.innerHTML = cardsProspeccao(d, r);
    grade.appendChild(lateral);
    area.appendChild(grade);
    ligarInteracaoMapa(area, (c) => {
      const x = municipioDe.get(c);
      return x ? { html: tooltipMunicipio(x), clique: () => (c !== codigo ? irPara("municipio", c) : null) } : null;
    });
  }

  const res = d.resumo;
  const outras = m.outrasRegionais.length
    ? `<div class="conflito-aviso">Este município também pertence a ${m.outrasRegionais.map((o) => `<a href="${hashDe("regional", o.id)}">${escapeHtml(o.sigla)}</a>`).join(", ")};
       os valores são contados em <strong>${escapeHtml(m.regionalSigla)}</strong> (regional principal — altere na revisão, abaixo).</div>`
    : "";
  const historico = d.temHistorico ? "" : `<p class="mapa-nunca">Este município <strong>nunca comprou</strong>. Abaixo, o que a regional e os vizinhos já fizeram — argumento de venda.</p>`;
  const cursos = d.cursos.map((c) => `<tr class="sem-clique"><td class="celula-nome">${escapeHtml(c.curso || "—")}</td><td>${c.turmas}</td>
    <td>${inteiro(c.matriculas)}</td><td>${inteiro(c.alunos)}</td><td>${reais(c.receitaCentavos)}</td><td>${ticket(c.receitaCentavos, c.matriculas)}</td></tr>`).join("");
  const vendedores = d.vendedores.map((v) => `<tr class="sem-clique"><td class="celula-nome">${escapeHtml(v.vendedor)}${v.tipo === "canal" ? ' <span class="chip">canal</span>' : ""}</td>
    <td>${inteiro(v.matriculas)}</td><td>${inteiro(v.alunos)}</td><td>${reais(v.receitaCentavos)}</td><td>${pctDe(v.receitaCentavos, res.receitaCentavos)}</td><td>${dataBr(v.ultima)}</td></tr>`).join("");
  const alunos = d.matriculas.map((x) => `<tr class="sem-clique"><td class="celula-nome">${escapeHtml(x.aluno || "(sem nome)")}</td>
    <td style="text-align:left">${escapeHtml(x.curso || "—")}${x.turma ? `<div class="texto-suave territorio-descricao">${escapeHtml(x.turma)}</div>` : ""}</td>
    <td style="text-align:left">${escapeHtml(x.vendedor)}</td><td>${reais(x.valorCentavos)}</td><td>${dataBr(x.criadaEm)}</td>
    <td class="texto-suave">${escapeHtml(x.status || "")}</td><td class="texto-suave">${escapeHtml(x.cidadeCadastro || "")}${x.metodo && !["exato_uf", "exato"].includes(x.metodo) ? ` <span class="chip">${escapeHtml(x.metodo)}</span>` : ""}</td></tr>`).join("");
  const viz = d.prospeccao.vizinhos;
  const vizinhosHtml = viz.lista.map((v) => `<tr data-ir="municipio" data-id="${v.codigo}" class="${v.cliente ? "" : "territorio-sem-historico"}">
    <td class="celula-nome">${escapeHtml(v.nome)}</td><td>${v.cliente ? '<span class="saude-ok">cliente</span>' : '<span class="mapa-texto-vazio">nunca comprou</span>'}</td>
    <td>${inteiro(v.matriculas)}</td><td>${reais(v.receitaCentavos)}</td></tr>`).join("");
  document.getElementById("nivel-conteudo").innerHTML = `
    <h2 class="secao-titulo">${escapeHtml(m.nome)} <span class="texto-suave territorio-dica">${escapeHtml(m.uf)}${m.regionalSigla ? " · " + escapeHtml(m.regionalSigla) : ""}</span></h2>
    ${outras}${historico}
    <div class="grade-metricas">
      ${card("Receita", reais(res.receitaCentavos), r ? `${pctDe(res.receitaCentavos, r.receitaCentavos)} de ${escapeHtml(r.sigla)}` : "")}
      ${card("Matrículas", inteiro(res.matriculas), `${res.canceladas ? inteiro(res.canceladas) + " cancelada(s) fora da conta" : "nenhuma cancelada"}`)}
      ${card("Alunos distintos", inteiro(res.alunos), res.matriculas > res.alunos ? `${inteiro(res.matriculas - res.alunos)} rematrícula(s)` : "")}
      ${card("Ticket médio", res.ticketMedioCentavos != null ? reais(res.ticketMedioCentavos) : "—", "receita ÷ matrículas")}
      ${card("Período com venda", res.primeira ? `${dataBr(res.primeira)}` : "—", res.ultima ? `até ${dataBr(res.ultima)}` : "")}
    </div>
    <h3 class="secao-titulo">Vizinhos <span class="texto-suave territorio-dica">${viz.clientes} de ${viz.total} já são clientes · ${reais(viz.receitaCentavos)} no período</span></h3>
    ${tabela([{ t: "Município vizinho", esq: true }, { t: "Situação" }, { t: "Matrículas" }, { t: "Receita" }], vizinhosHtml || semDado("Sem vizinhos na malha."))}
    <h3 class="secao-titulo">Cursos</h3>
    ${tabela([{ t: "Curso", esq: true }, { t: "Turmas" }, { t: "Matrículas" }, { t: "Alunos" }, { t: "Receita" }, { t: "Ticket" }], cursos || semDado("Nenhuma matrícula no período."))}
    <h3 class="secao-titulo">Carteira — quem vende aqui</h3>
    ${tabela([{ t: "Vendedor", esq: true }, { t: "Matrículas" }, { t: "Alunos" }, { t: "Receita" }, { t: "% do município" }, { t: "Última venda" }], vendedores || semDado("Nenhuma matrícula no período."))}
    <h3 class="secao-titulo">Alunos <span class="texto-suave territorio-dica">${inteiro(d.matriculas.length)} matrícula(s)</span></h3>
    ${tabela([{ t: "Aluno", esq: true }, { t: "Curso", esq: true }, { t: "Vendedor", esq: true }, { t: "Valor" }, { t: "Data" }, { t: "Status" }, { t: "Cidade no cadastro" }], alunos || semDado("Nenhuma matrícula no período."))}`;
}

function cardsProspeccao(d, r) {
  const pr = d.prospeccao;
  const reg = pr.regional;
  const viz = pr.vizinhos;
  return `
    ${reg ? `<div class="metrica-card"><span class="metrica-rotulo">Regional ${escapeHtml(reg.sigla)} no período</span>
      <span class="metrica-valor">${reais(reg.receitaCentavos)}</span>
      <span class="metrica-extra">${inteiro(reg.matriculas)} matrículas · <strong>${reg.clientes} de ${reg.municipios} municípios já compraram</strong> (${pctDe(reg.clientes, reg.municipios)})</span></div>` : ""}
    <div class="metrica-card"><span class="metrica-rotulo">Vizinhos que já são clientes</span>
      <span class="metrica-valor">${viz.clientes} <small>de ${viz.total}</small></span>
      <span class="metrica-extra">${reais(viz.receitaCentavos)} · ${inteiro(viz.matriculas)} matrículas no período nos vizinhos</span>
      <div class="territorio-chips">${viz.lista.map((v) => `<a class="chip ${v.cliente ? "chip-cliente" : "chip-vazio"}" href="${hashDe("municipio", v.codigo)}" title="${v.cliente ? reais(v.receitaCentavos) : "nunca comprou"}">${escapeHtml(v.nome)}</a>`).join("")}</div></div>
    ${reg && reg.semCompra.length ? `<div class="metrica-card territorio-card-lista mapa-card-vazio"><span class="metrica-rotulo">Na regional, nunca compraram</span>
      <span class="metrica-valor">${inteiro(reg.semCompra.length)}</span>
      <div class="territorio-chips">${reg.semCompra.map((x) => `<a class="chip chip-vazio" href="${hashDe("municipio", x.codigo)}">${escapeHtml(x.nome)}</a>`).join("")}</div></div>` : ""}`;
}

// Hover/clique nos paths: `info(codigo)` → { html, destaque (seletor), clique }
function ligarInteracaoMapa(area, info) {
  let destacados = [];
  const limpar = () => { for (const p of destacados) p.classList.remove("mapa-hover"); destacados = []; };
  area.addEventListener("mousemove", (ev) => {
    const p = ev.target.closest("path[data-codigo]");
    if (!p) { esconderTooltip(); limpar(); return; }
    const i = info(Number(p.dataset.codigo));
    if (!i) { esconderTooltip(); limpar(); return; }
    mostrarTooltip(ev, i.html);
    limpar();
    destacados = i.destaque ? [...area.querySelectorAll(i.destaque)] : [p];
    for (const x of destacados) x.classList.add("mapa-hover");
  });
  area.addEventListener("mouseleave", () => { esconderTooltip(); limpar(); });
  area.addEventListener("click", (ev) => {
    const p = ev.target.closest("path[data-codigo]");
    if (!p) return;
    const i = info(Number(p.dataset.codigo));
    if (i && i.clique) i.clique();
  });
}

async function renderizarRota() {
  const rota = lerRota();
  periodo.de = rota.de;
  periodo.ate = rota.ate;
  refletirPeriodoNaTela();
  const el = document.getElementById("nivel-conteudo");
  el.classList.add("territorio-carregando");
  try {
    const [a] = await Promise.all([agregado(), carregarMalha()]);
    renderizarConferencia(a.conferencia);
    esconderTooltip();
    if (rota.nivel === "regional") renderizarRegional(a, rota.id);
    else if (rota.nivel === "municipio") await renderizarMunicipio(a, rota.id);
    else renderizarEstado(a);
    await carregarCobertura();
  } catch (e) {
    avisar("⚠ " + e.message, true);
  } finally {
    el.classList.remove("territorio-carregando");
  }
}

// ---------- Cobertura ----------

const ROTULO_METODO = {
  exato_uf: "exato + UF", exato: "exato", aproximado: "aproximado", manual: "manual",
  fora_uf: "UF de outro estado", fora_cep: "CEP de outro estado", fora_brasil: "cidade só existe em outro estado",
  manual_fora: "manual (fora)", manual_ignorar: "manual (ignorar)", sem_cidade: "sem cidade",
  sem_uf: "homônimo PR/SC sem UF", conflito_uf: "cidade × UF em conflito", sem_match: "sem candidato",
};
const CLASSE_GRUPO = {
  exato_uf: "pct-ok", exato: "pct-ok", manual: "pct-ok", aproximado: "pct-meio",
  pendente: "pct-baixo", nao_processado: "pct-baixo",
};

function renderizarCobertura(c) {
  const cards = [
    ["Casadas com município", `${inteiro(c.casadas.matriculas)} <small>(${pctTexto(c.casadas.pctMatriculas)})</small>`,
      `${reais(c.casadas.receitaCentavos)} · ${pctTexto(c.casadas.pctReceita)} da receita`],
    ...c.grupos.filter((g) => ["fora", "pendente"].includes(g.grupo)).map((g) => [
      g.rotulo, `${inteiro(g.matriculas)} <small>(${pctTexto(g.pctMatriculas)})</small>`,
      `${reais(g.receitaCentavos)} · ${pctTexto(g.pctReceita)} da receita`]),
    ["Total no período", inteiro(c.total.matriculas), `${reais(c.total.receitaCentavos)} — mesmo filtro dos relatórios`],
  ];
  document.getElementById("cards-cobertura").innerHTML = cards.map(([r, v, e]) => card(r, v, escapeHtml(e))).join("");
  document.querySelector("#tabela-cobertura tbody").innerHTML = c.grupos
    .map((g) => `<tr class="sem-clique">
      <td class="celula-nome ${CLASSE_GRUPO[g.grupo] || ""}">${escapeHtml(g.rotulo)}
        <div class="texto-suave territorio-descricao">${escapeHtml(g.descricao)}</div></td>
      <td>${inteiro(g.matriculas)}</td><td>${pctTexto(g.pctMatriculas)}</td>
      <td>${reais(g.receitaCentavos)}</td><td>${pctTexto(g.pctReceita)}</td>
      <td style="text-align:left" class="texto-suave">${g.metodos
        .map((m) => `${escapeHtml(ROTULO_METODO[m.metodo] || m.metodo)}: ${inteiro(m.matriculas)}`)
        .join(" · ") || "—"}</td>
    </tr>`)
    .join("");
  document.querySelector("#tabela-cobertura tfoot").innerHTML =
    `<tr><td>Total</td><td>${inteiro(c.total.matriculas)}</td><td>100%</td>
     <td>${reais(c.total.receitaCentavos)}</td><td>100%</td><td></td></tr>`;
  const chaves = c.chaves || {};
  const semData = c.semData && c.semData.matriculas
    ? ` ${inteiro(c.semData.matriculas)} matrícula(s) sem data de criação (${reais(c.semData.receitaCentavos)}) ficam fora de qualquer período — inclusive daqui.`
    : "";
  document.getElementById("nota-cobertura").textContent =
    `Chaves (cidade + UF normalizadas) na base de apelidos: ${inteiro(chaves.municipio)} casadas, ` +
    `${inteiro(chaves.fora)} fora de PR/SC, ${inteiro(chaves.pendente)} pendentes, ${inteiro(chaves.ignorar)} ignoradas. ` +
    `Matrícula cancelada não conta (mesma regra dos relatórios).` + semData;
}

async function carregarCobertura() {
  renderizarCobertura(await chamarApi("/api/territorio/cobertura" + queryPeriodo()));
}

// ---------- Revisão manual (lote) ----------

const municipioPorRotulo = new Map();
const rotuloMunicipio = (m) => `${m.nome} (${m.uf})`;

async function carregarReferencia() {
  referencia = await chamarApi("/api/territorio/municipios");
  municipioPorRotulo.clear();
  for (const m of referencia.municipios) municipioPorRotulo.set(rotuloMunicipio(m).toLowerCase(), m);
  document.getElementById("lista-municipios").innerHTML = referencia.municipios
    .map((m) => `<option value="${escapeHtml(rotuloMunicipio(m))}"></option>`)
    .join("");
}

function celulaResolver(p) {
  const s = p.sugestao || {};
  const acao = s.resultado || "municipio";
  const valorInicial = s.resultado === "municipio" && s.codigo ? rotuloMunicipio(s) : "";
  const chips = p.sugestoes
    .filter((c) => !(s.codigo && c.codigo === s.codigo))
    .map((c) => `<button type="button" class="chip chip-sugestao" data-rotulo="${escapeHtml(rotuloMunicipio(c))}"
        title="${escapeHtml(c.motivo)} · distância ${c.distancia}">${escapeHtml(rotuloMunicipio(c))} <small>${c.motivo === "proximo" ? "d=" + c.distancia : c.motivo}</small></button>`)
    .join(" ");
  const ceps = p.ceps.map((c) => `<button type="button" class="chip chip-sugestao chip-cep" data-cep="${c}" title="consultar o CEP no ViaCEP e preencher">CEP ${c.slice(0, 5)}-${c.slice(5)} 🔍</button>`).join(" ");
  return `<td style="text-align:left" class="territorio-resolver" data-cidade="${escapeHtml(p.cidadeNorm)}" data-uf="${escapeHtml(p.ufNorm)}">
    <div class="territorio-resolver-linha">
      <select class="campo-select acao">
        <option value="municipio" ${acao === "municipio" ? "selected" : ""}>Município:</option>
        <option value="fora" ${acao === "fora" ? "selected" : ""}>Fora de PR/SC</option>
        <option value="ignorar" ${acao === "ignorar" ? "selected" : ""}>Ignorar</option>
      </select>
      <input type="text" list="lista-municipios" class="campo-select" placeholder="Município (UF)" value="${escapeHtml(valorInicial)}" ${acao === "municipio" ? "" : "disabled"} />
      <button type="button" class="btn-mini" data-acao="salvar">Salvar</button>
    </div>
    ${chips || ceps ? `<div class="territorio-sugestoes">${ceps} ${chips}</div>` : ""}
  </td>`;
}

function linhaRevisao(p, aproximado) {
  const s = p.sugestao || {};
  const uf = p.ufNorm || "—";
  const cadastro = [
    p.estados.length ? `estado: ${p.estados.map(escapeHtml).join(", ")}` : "",
    p.ceps.length ? `CEP: ${p.ceps.map((c) => c.slice(0, 5) + "-" + c.slice(5)).join(", ")}` : "",
  ].filter(Boolean).join(" · ");
  const meio = aproximado
    ? `<td>${escapeHtml(p.municipio ? rotuloMunicipio(p.municipio) : "?")} <small class="texto-suave">d=${p.distancia}</small></td>`
    : `<td>${escapeHtml(ROTULO_METODO[p.metodo] || p.metodo)}</td>`;
  const sugestaoTexto = s.resultado === "municipio" && s.nome ? `<strong>${escapeHtml(rotuloMunicipio(s))}</strong>`
    : s.resultado === "fora" ? "<strong>Fora de PR/SC</strong>"
      : s.resultado === "ignorar" ? "<strong>Ignorar</strong>" : '<span class="texto-suave">sem sugestão</span>';
  return `<tr class="sem-clique territorio-linha-revisao">
    <td><input type="checkbox" class="marcar" ${s.resultado ? "checked" : ""} /></td>
    <td class="celula-nome">${p.amostras.map(escapeHtml).join("<br>")}
      <div class="texto-suave territorio-descricao">${cadastro || "sem estado/CEP no cadastro"}</div></td>
    <td>${escapeHtml(uf)}</td>${meio}
    <td>${inteiro(p.matriculas)}${p.matriculasTotal > p.matriculas ? `<small class="texto-suave"> +${p.matriculasTotal - p.matriculas} canc.</small>` : ""}${p.contatos ? `<div class="texto-suave territorio-descricao" title="${escapeHtml((p.contatosSetores || []).join(", "))}">${inteiro(p.contatos)} contato(s) da prospecção</div>` : ""}</td>
    <td>${reais(p.receitaCentavos)}</td>
    <td style="text-align:left">${sugestaoTexto}<div class="texto-suave territorio-descricao">${escapeHtml(s.motivo || "")}</div></td>
    ${celulaResolver(p)}
  </tr>`;
}

function renderizarCompartilhados(lista) {
  document.getElementById("chip-compartilhados").textContent = lista.length;
  document.querySelector("#tabela-compartilhados tbody").innerHTML = lista.length
    ? lista.map((m) => `<tr class="sem-clique"><td class="celula-nome"><a href="${hashDe("municipio", m.codigo)}">${escapeHtml(m.nome)}</a></td><td>${escapeHtml(m.uf)}</td>
        <td style="text-align:left"><select class="campo-select" data-codigo="${m.codigo}">
          ${m.opcoes.map((o) => `<option value="${o.id}" ${o.id === m.regionalPrincipalId ? "selected" : ""}>
            ${escapeHtml(o.sigla)} — ${escapeHtml(o.nome || "")}</option>`).join("")}
        </select></td></tr>`).join("")
    : `<tr class="sem-clique"><td colspan="3" class="texto-suave">Nenhum município em duas regionais (CSV de regionais não carregado?).</td></tr>`;
}

async function carregarPendencias() {
  const r = await chamarApi("/api/territorio/pendencias");
  document.getElementById("chip-pendentes").textContent = r.pendentes.length;
  document.getElementById("chip-aproximados").textContent = r.aproximados.length;
  document.getElementById("detalhes-revisao").open = r.pendentes.length > 0 || r.aproximados.length > 0;
  document.querySelector("#tabela-pendentes tbody").innerHTML = r.pendentes.length
    ? r.pendentes.map((p) => linhaRevisao(p, false)).join("")
    : `<tr class="sem-clique"><td colspan="8"><span class="saude-ok">✔ nenhuma pendência — toda cidade foi decidida</span></td></tr>`;
  document.querySelector("#tabela-aproximados tbody").innerHTML = r.aproximados.length
    ? r.aproximados.map((p) => linhaRevisao(p, true)).join("")
    : `<tr class="sem-clique"><td colspan="8"><span class="saude-ok">✔ nenhum casamento aproximado pendente de confirmação</span></td></tr>`;
  renderizarCompartilhados(r.compartilhados || []);
  atualizarBotaoLote();
}

function itemDaCelula(celula) {
  const acao = celula.querySelector("select.acao").value;
  const item = { cidadeNorm: celula.dataset.cidade, ufNorm: celula.dataset.uf, resultado: acao };
  if (acao === "municipio") {
    const texto = celula.querySelector("input").value.trim().toLowerCase();
    const m = municipioPorRotulo.get(texto);
    if (!m) throw new Error(`"${celula.dataset.cidade}": escolha um município da lista, no formato "Nome (UF)".`);
    item.codigoIbge = m.codigo;
  }
  return item;
}

function linhasMarcadas() {
  return [...document.querySelectorAll(".territorio-linha-revisao")].filter((tr) => tr.querySelector(".marcar").checked);
}

function atualizarBotaoLote() {
  const n = linhasMarcadas().length;
  const b = document.getElementById("btn-confirmar-lote");
  b.textContent = `Confirmar selecionados (${n})`;
  b.disabled = !n;
}

async function aplicarLote(itens) {
  const r = await chamarApi("/api/territorio/apelidos/lote", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itens }),
  });
  avisar(`${r.aplicados} resolução(ões) gravada(s); ${r.cruzamento.matriculas} matrícula(s) reprocessada(s).`);
  limparCache();
  await Promise.all([carregarPendencias(), renderizarRota()]);
}

async function resolverLinha(celula) {
  try {
    await aplicarLote([itemDaCelula(celula)]);
  } catch (e) {
    avisar("⚠ " + e.message, true);
  }
}

async function confirmarLote() {
  const itens = [];
  try {
    for (const tr of linhasMarcadas()) itens.push(itemDaCelula(tr.querySelector(".territorio-resolver")));
  } catch (e) {
    return avisar("⚠ " + e.message, true);
  }
  if (!itens.length) return;
  document.getElementById("btn-confirmar-lote").disabled = true;
  try {
    await aplicarLote(itens);
  } catch (e) {
    avisar("⚠ " + e.message, true);
    atualizarBotaoLote();
  }
}

// Consulta de CEP feita pelo navegador do revisor (o servidor não acessa a internet)
async function consultarCep(cep, celula) {
  const tentar = async (url, ler) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return ler(await r.json());
  };
  let achado = null;
  try {
    achado = await tentar(`https://viacep.com.br/ws/${cep}/json/`, (j) => (j.erro ? null : { cidade: j.localidade, uf: j.uf }));
  } catch (_) { /* tenta a próxima fonte */ }
  if (!achado) {
    try {
      achado = await tentar(`https://brasilapi.com.br/api/cep/v2/${cep}`, (j) => (j.city ? { cidade: j.city, uf: j.state } : null));
    } catch (_) { /* sem rede ou CEP inexistente */ }
  }
  if (!achado) return avisar(`CEP ${cep}: não encontrado no ViaCEP nem na BrasilAPI.`, true);
  const rotulo = `${achado.cidade} (${achado.uf})`;
  const m = municipioPorRotulo.get(rotulo.toLowerCase());
  const select = celula.querySelector("select.acao");
  const input = celula.querySelector("input");
  if (m) {
    select.value = "municipio";
    input.disabled = false;
    input.value = rotuloMunicipio(m);
    avisar(`CEP ${cep} → ${rotuloMunicipio(m)} (preenchido; confirme).`);
  } else {
    select.value = "fora";
    input.disabled = true;
    input.value = "";
    avisar(`CEP ${cep} → ${rotulo}: fora de PR/SC (ação ajustada; confirme).`);
  }
  celula.closest("tr").querySelector(".marcar").checked = true;
  atualizarBotaoLote();
}

// ---------- Eventos ----------

document.addEventListener("click", (ev) => {
  const botaoModo = ev.target.closest("#modos button[data-modo]");
  if (botaoModo) {
    modo = botaoModo.dataset.modo;
    for (const b of document.querySelectorAll("#modos button")) b.classList.toggle("ativo", b === botaoModo);
    renderizarRota();
    return;
  }
  const linhaNav = ev.target.closest("tr[data-ir]");
  if (linhaNav && !ev.target.closest("a, button, input, select")) {
    irPara(linhaNav.dataset.ir, linhaNav.dataset.id);
    return;
  }
  const cepChip = ev.target.closest(".chip-cep");
  if (cepChip) {
    consultarCep(cepChip.dataset.cep, cepChip.closest(".territorio-resolver"));
    return;
  }
  const chip = ev.target.closest(".chip-sugestao");
  if (chip) {
    const celula = chip.closest(".territorio-resolver");
    celula.querySelector("select.acao").value = "municipio";
    const input = celula.querySelector("input");
    input.disabled = false;
    input.value = chip.dataset.rotulo;
    celula.closest("tr").querySelector(".marcar").checked = true;
    atualizarBotaoLote();
    return;
  }
  const botao = ev.target.closest("button[data-acao='salvar']");
  if (botao) resolverLinha(botao.closest(".territorio-resolver"));
});

document.addEventListener("change", (ev) => {
  if (ev.target.matches("select.acao")) {
    const input = ev.target.closest(".territorio-resolver").querySelector("input");
    input.disabled = ev.target.value !== "municipio";
    ev.target.closest("tr").querySelector(".marcar").checked = true;
    atualizarBotaoLote();
  }
  if (ev.target.matches(".marcar")) atualizarBotaoLote();
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ev.target.matches(".territorio-resolver input")) {
    ev.preventDefault();
    resolverLinha(ev.target.closest(".territorio-resolver"));
    return;
  }
  // Esc sobe um nível
  if (ev.key === "Escape" && !ev.target.matches("input, select, textarea")) {
    const rota = lerRota();
    if (rota.nivel === "municipio") {
      const m = referencia?.municipios.find((x) => x.codigo === rota.id);
      irPara(m?.regionalPrincipalId ? "regional" : "estado", m?.regionalPrincipalId);
    } else if (rota.nivel === "regional") irPara("estado");
  }
});

document.getElementById("btn-confirmar-lote").addEventListener("click", confirmarLote);
document.getElementById("btn-marcar-sugeridas").addEventListener("click", () => {
  for (const tr of document.querySelectorAll(".territorio-linha-revisao")) {
    const temSugestao = Boolean(tr.querySelector("td:nth-child(7) strong"));
    tr.querySelector(".marcar").checked = temSugestao;
  }
  atualizarBotaoLote();
});
document.getElementById("btn-desmarcar").addEventListener("click", () => {
  for (const cb of document.querySelectorAll(".marcar")) cb.checked = false;
  atualizarBotaoLote();
});

document.getElementById("tabela-compartilhados").addEventListener("change", async (ev) => {
  const sel = ev.target.closest("select[data-codigo]");
  if (!sel) return;
  try {
    const r = await chamarApi(`/api/territorio/municipios/${sel.dataset.codigo}/principal`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ regionalId: Number(sel.value) }),
    });
    avisar("Regional principal atualizada — totais recalculados.");
    renderizarCompartilhados(r.compartilhados);
    limparCache();
    await renderizarRota();
  } catch (e) {
    avisar("⚠ " + e.message, true);
  }
});

for (const radio of document.querySelectorAll('input[name="modo-periodo"]')) {
  radio.addEventListener("change", alternarCamposPeriodo);
}
document.getElementById("btn-este-mes").addEventListener("click", () => preencherMes(0));
document.getElementById("btn-mes-passado").addEventListener("click", () => preencherMes(-1));
document.getElementById("btn-aplicar").addEventListener("click", () => {
  try {
    const p = lerPeriodoDaTela();
    const rota = lerRota();
    periodo.de = p.de;
    periodo.ate = p.ate;
    const destino = hashDe(rota.nivel, rota.id);
    if (destino === location.hash || (destino === "#/" && !location.hash)) renderizarRota();
    else location.hash = destino;
  } catch (e) {
    avisar("⚠ " + e.message, true);
  }
});

window.addEventListener("hashchange", renderizarRota);

document.getElementById("btn-sair").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});

(async () => {
  try {
    await carregarReferencia();
    await Promise.all([renderizarRota(), carregarPendencias()]);
  } catch (e) {
    avisar("⚠ Não foi possível carregar. (" + e.message + ")", true);
  }
})();
