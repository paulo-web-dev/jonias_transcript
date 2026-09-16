"use strict";

// /prospeccao — Trabalho (Fase 2: tabela virtual com filtros em memória,
// edição inline, status, registro de contato, histórico, novo contato,
// exportação), Cores e status (Fase 1) e Cobertura da carga (Fase 1).

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
const postJson = (url, corpo, metodo = "POST") =>
  chamarApi(url, { method: metodo, headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });

const inteiro = (n) => (n || 0).toLocaleString("pt-BR");
const pctDe = (v, t) => (t ? (Math.round((v / t) * 1000) / 10).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%" : "—");
const dataBr = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).split("-").reverse().join("/") : iso || "");
const dataHoraBr = (iso) => { const d = new Date(iso); return isNaN(d) ? String(iso || "") : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }); };
const hojeIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const normalizar = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function avisar(texto, erro = false) {
  const el = document.getElementById("aviso");
  el.textContent = texto;
  el.classList.toggle("aviso-erro", erro);
  el.classList.add("visivel");
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => el.classList.remove("visivel"), erro ? 6000 : 2200);
}

function textoLegivel(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? "#0b0e17" : "#ffffff";
}

// ---------- Abas ----------

function mostrarAba(nome) {
  for (const b of document.querySelectorAll(".aba-btn")) b.classList.toggle("ativo", b.dataset.aba === nome);
  for (const s of document.querySelectorAll(".aba-painel")) s.classList.toggle("oculto", s.id !== `aba-${nome}`);
  if (nome !== "trabalho") esconderFlutuantes();
}
document.querySelector(".prospeccao-abas").addEventListener("click", (ev) => {
  const b = ev.target.closest(".aba-btn");
  if (!b) return;
  mostrarAba(b.dataset.aba);
  gravarHash();
});

// =====================================================================
// TRABALHO
// =====================================================================

const ALTURA_LINHA = 34;
const MARGEM_LINHAS = 12;
const COR_INEXISTENTE = "6b7280";

const trab = {
  uf: "PR", dados: null, linhas: [], filtradas: [], porId: new Map(),
  ordem: { campo: "municipioNome", dir: 1 }, selecionado: null, editando: null,
  filtros: { busca: "", municipio: "", regional: "", setor: "", consultor: "", marca: "", status: new Set(), ocultas: false, semTelefone: false, inexistente: false, nunca: false, nuncaCdr: false, de: "", ate: "" },
  primeiraVisivel: -1, ultimaVisivel: -1,
  // marcação pessoal (verde/vermelho): as MINHAS vêm no payload; admin pode ver as de outro usuário (só leitura)
  marcas: new Map(), verDe: null, marcasOutro: new Map(),
};
const el = {};
for (const id of ["f-uf", "f-busca", "f-municipio", "f-regional", "f-setor", "f-consultor", "f-marca", "f-marcas-de", "f-status", "f-ocultas", "f-sem-telefone", "f-inexistente", "f-nunca", "f-nunca-cdr", "f-de", "f-ate",
  "trab-contador", "trab-scroll", "trab-tabela", "trab-corpo-tabela", "gaveta", "gaveta-titulo", "gaveta-conteudo", "popover-contato", "popover-quem", "popover-status", "popover-data", "popover-obs",
  "menu-status", "modal-novo", "modal-novo-erro", "lista-municipios-uf", "lista-setores", "n-uf", "n-setor", "n-municipio", "n-status", "n-consultor"]) {
  el[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
}

// ---------- carga e modelo em memória ----------

function montarLinha(arr) {
  const o = {};
  trab.dados.campos.forEach((c, i) => { o[c] = arr[i]; });
  enriquecer(o);
  return o;
}

function enriquecer(o) {
  const d = trab.dados;
  const m = o.codigo_ibge ? d.municipios[o.codigo_ibge] : null;
  o.municipioNome = m ? m[0] : o.municipio_texto || "";
  o.regionalId = m ? m[1] : null;
  o.regionalSigla = o.regionalId ? d.regionaisPorId.get(o.regionalId)?.sigla || "" : "";
  o.consultorNome = o.pessoa_id === -1 ? "outro consultor" : o.pessoa_id ? d.consultoresPorId.get(o.pessoa_id) || "" : "";
  o.marca = (trab.verDe ? trab.marcasOutro : trab.marcas).get(o.id) || null;
  o.statusNome = o.contato_inexistente ? "Contato inexistente" : o.cor_linha ? d.statusPorHex.get(o.cor_linha)?.nome || "" : "";
  o.statusHexVisual = o.contato_inexistente ? COR_INEXISTENTE : o.cor_linha && d.statusPorHex.has(o.cor_linha) ? o.cor_linha : null;
  o.busca = normalizar([o.municipioNome, o.municipio_texto, o.responsavel, o.cargo, o.telefone, o.telefone_original, o.whatsapp, o.email, o.observacoes, o.curso, o.setor, o.consultor_planilha].filter(Boolean).join(" | "));
  // Fase 4 (só leitura): ligação do CDR ao número exato (contato único) ou ao município
  const cm = o.codigo_ibge && d.cdr ? d.cdr.municipios[o.codigo_ibge] : null;
  const cc = d.cdr ? d.cdr.contatos[o.id] : null;
  o.cdrContato = !!cc;
  o.cdrUltima = cc ? cc[0] : cm ? cm[0] : null;
  o.cdrTotal = cc ? cc[1] : cm ? cm[1] : 0;
  o.cdrMunicipioTotal = cm ? cm[1] : 0;
  o.cdrQuem = cm ? (cm[3] === -1 ? "outro consultor" : cm[3] === 0 || cm[3] === null ? "" : d.consultoresPorId.get(cm[3]) || "") : "";
  return o;
}

async function carregarTrabalho() {
  const uf = trab.uf;
  el.trabContador.textContent = "carregando…";
  const t0 = performance.now();
  const d = await chamarApi(`/api/prospeccao/contatos?uf=${uf}`);
  d.regionaisPorId = new Map(d.regionais.map((r) => [r.id, r]));
  d.consultoresPorId = new Map(d.consultores.map((c) => [c.id, c.nome]));
  d.statusPorHex = new Map(d.status.map((s) => [s.hex, s]));
  trab.dados = d;
  trab.marcas = new Map(Object.entries(d.marcacoes || {}).map(([id, cor]) => [Number(id), cor]));
  trab.verDe = null; trab.marcasOutro = new Map();
  preencherMarcasDe(d);
  trab.linhas = d.linhas.map(montarLinha);
  trab.porId = new Map(trab.linhas.map((o) => [o.id, o]));
  aplicarEscopoNaTela(d);
  preencherFiltrosEstaticos();
  aplicarFiltros();
  console.log(`[prospeccao] ${uf}: ${trab.linhas.length} linhas em ${Math.round(performance.now() - t0)} ms`);
}

// Vendedor (escopo vindo do servidor): UF limitada às da carteira, filtro de
// consultor some (é sempre ele) e aviso quando não há carteira atribuída
function aplicarEscopoNaTela(d) {
  const aviso = document.getElementById("aviso-escopo");
  if (!d.escopo) { aviso.classList.add("oculto"); return; }
  const ufs = d.escopo.ufs.length ? d.escopo.ufs : [trab.uf];
  el.fUf.innerHTML = ufs.map((u) => `<option value="${u}" ${u === trab.uf ? "selected" : ""}>${u}</option>`).join("");
  el.fConsultor.classList.add("oculto");
  document.getElementById("n-consultor").closest(".campo").classList.add("oculto");
  aviso.classList.toggle("oculto", !d.escopo.vazio);
  if (d.escopo.vazio) aviso.textContent = "Seu usuário ainda não tem regional atribuída — peça ao administrador para definir a sua carteira em /usuarios.";
}

function preencherFiltrosEstaticos() {
  const d = trab.dados;
  el.fRegional.innerHTML = `<option value="">regional: todas</option>` + d.regionais.map((r) => `<option value="${r.id}">${escapeHtml(r.sigla)}</option>`).join("");
  el.fSetor.innerHTML = `<option value="">setor: todos</option>` + d.setores.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  el.fConsultor.innerHTML = `<option value="">consultor: todos</option><option value="sem">sem consultor</option>` + d.consultores.map((c) => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join("");
  el.listaMunicipiosUf.innerHTML = Object.entries(d.municipios).map(([c, [nome]]) => `<option value="${escapeHtml(nome)}" data-codigo="${c}"></option>`).join("");
  el.listaSetores.innerHTML = d.setores.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("");
  const chips = [{ hex: "", nome: "sem status" }, ...d.status, { hex: "inexistente", nome: "Contato inexistente", cor: COR_INEXISTENTE }];
  el.fStatus.innerHTML = chips.map((s) => `<button type="button" class="chip chip-status ${trab.filtros.status.has(s.hex) ? "ativo" : ""}" data-hex="${s.hex}"
      style="${s.hex && s.hex !== "inexistente" ? `--cor:#${s.hex};` : s.hex === "inexistente" ? `--cor:#${COR_INEXISTENTE};` : ""}">${escapeHtml(s.nome)}</button>`).join("");
  const opcoesStatus = `<option value="">status: manter</option>` + d.status.map((s) => `<option value="${s.hex}">${escapeHtml(s.nome)}</option>`).join("");
  el.popoverStatus.innerHTML = opcoesStatus;
  el.nStatus.innerHTML = `<option value="">sem status</option>` + d.status.map((s) => `<option value="${s.hex}">${escapeHtml(s.nome)}</option>`).join("");
  el.nConsultor.innerHTML = `<option value="">sem consultor</option>` + d.consultores.map((c) => `<option value="${c.id}">${escapeHtml(c.nome)}</option>`).join("");
  // refletir filtros no formulário
  const f = trab.filtros;
  el.fBusca.value = f.busca; el.fMunicipio.value = f.municipio; el.fRegional.value = f.regional; el.fSetor.value = f.setor; el.fConsultor.value = f.consultor; el.fMarca.value = f.marca;
  el.fOcultas.checked = f.ocultas; el.fSemTelefone.checked = f.semTelefone; el.fInexistente.checked = f.inexistente; el.fNunca.checked = f.nunca; el.fNuncaCdr.checked = f.nuncaCdr; el.fDe.value = f.de; el.fAte.value = f.ate;
}

// ---------- filtros ----------

function lerFiltros() {
  const f = trab.filtros;
  f.busca = el.fBusca.value.trim(); f.municipio = el.fMunicipio.value.trim(); f.regional = el.fRegional.value; f.setor = el.fSetor.value; f.consultor = el.fConsultor.value; f.marca = el.fMarca.value;
  f.ocultas = el.fOcultas.checked; f.semTelefone = el.fSemTelefone.checked; f.inexistente = el.fInexistente.checked; f.nunca = el.fNunca.checked; f.nuncaCdr = el.fNuncaCdr.checked; f.de = el.fDe.value; f.ate = el.fAte.value;
}

function aplicarFiltros() {
  const t0 = performance.now();
  const f = trab.filtros;
  const termos = normalizar(f.busca).split(/\s+/).filter(Boolean);
  const municipio = normalizar(f.municipio);
  const regional = f.regional ? Number(f.regional) : null;
  const consultor = f.consultor === "sem" ? "sem" : f.consultor ? Number(f.consultor) : null;
  const status = f.status;
  trab.filtradas = trab.linhas.filter((o) => {
    if (!f.ocultas && o.linha_oculta) return false;
    if (f.setor && o.setor !== f.setor) return false;
    if (regional && o.regionalId !== regional) return false;
    if (municipio && !normalizar(o.municipioNome).includes(municipio) && !normalizar(o.municipio_texto).includes(municipio)) return false;
    if (consultor === "sem" ? o.pessoa_id : consultor && o.pessoa_id !== consultor) return false;
    if (f.marca && (f.marca === "sem" ? o.marca : o.marca !== f.marca)) return false;
    if (f.semTelefone && o.telefone) return false;
    if (f.inexistente && !o.contato_inexistente) return false;
    if (f.nunca && o.data_ultimo_contato) return false;
    if (f.nuncaCdr && o.cdrUltima) return false;
    if (f.de && (!o.data_ultimo_contato || o.data_ultimo_contato < f.de)) return false;
    if (f.ate && (!o.data_ultimo_contato || o.data_ultimo_contato > f.ate)) return false;
    if (status.size) {
      const chave = o.contato_inexistente ? "inexistente" : o.cor_linha && trab.dados.statusPorHex.has(o.cor_linha) ? o.cor_linha : "";
      if (!status.has(chave)) return false;
    }
    for (const t of termos) if (!o.busca.includes(t)) return false;
    return true;
  });
  ordenar();
  atualizarContador();
  el.trabScroll.scrollTop = 0;
  trab.primeiraVisivel = -1;
  renderizarJanela(true);
  gravarHash();
  const ms = performance.now() - t0;
  if (ms > 80) console.warn(`[prospeccao] filtro levou ${Math.round(ms)} ms`);
}

function atualizarContador() {
  let verdes = 0, vermelhas = 0;
  for (const cor of (trab.verDe ? trab.marcasOutro : trab.marcas).values()) { if (cor === "verde") verdes++; else vermelhas++; }
  el.trabContador.textContent = `${inteiro(trab.filtradas.length)} de ${inteiro(trab.linhas.length)}` +
    (verdes || vermelhas ? ` · ${trab.verDe ? `de ${trab.verDe.nome}: ` : ""}🟢 ${inteiro(verdes)} 🔴 ${inteiro(vermelhas)}` : "");
}

function ordenar() {
  const { campo, dir } = trab.ordem;
  // chave pré-calculada por linha (normalizada, sem acento) e comparação simples:
  // localeCompare com opções em 16 k linhas levava ~3 s; assim fica < 50 ms
  const chaves = new Map();
  for (const o of trab.filtradas) {
    const v = o[campo];
    chaves.set(o, v === null || v === undefined || v === "" ? null : typeof v === "number" ? v : normalizar(v));
  }
  trab.filtradas.sort((a, b) => {
    const x = chaves.get(a), y = chaves.get(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  for (const th of document.querySelectorAll("#trab-tabela thead th[data-ordem]")) {
    th.classList.toggle("ordem-asc", th.dataset.ordem === campo && dir === 1);
    th.classList.toggle("ordem-desc", th.dataset.ordem === campo && dir === -1);
  }
}

function serializarFiltros() {
  const f = trab.filtros;
  const q = new URLSearchParams();
  q.set("uf", trab.uf);
  if (f.busca) q.set("q", f.busca); if (f.municipio) q.set("mun", f.municipio); if (f.regional) q.set("reg", f.regional); if (f.setor) q.set("setor", f.setor);
  if (f.consultor) q.set("cons", f.consultor); if (f.marca) q.set("marca", f.marca); if (f.status.size) q.set("st", [...f.status].join(","));
  const flags = ["ocultas", "semTelefone", "inexistente", "nunca", "nuncaCdr"].filter((k) => f[k]); if (flags.length) q.set("flags", flags.join(","));
  if (f.de) q.set("de", f.de); if (f.ate) q.set("ate", f.ate);
  if (trab.ordem.campo !== "municipioNome" || trab.ordem.dir !== 1) q.set("ord", `${trab.ordem.campo}:${trab.ordem.dir}`);
  return q.toString();
}
let ignorarHash = false;
function gravarHash() {
  const aba = document.querySelector(".aba-btn.ativo")?.dataset.aba || "trabalho";
  const novo = `#${aba}${aba === "trabalho" ? "?" + serializarFiltros() : ""}`;
  if (location.hash !== novo) { ignorarHash = true; history.replaceState(null, "", novo); ignorarHash = false; }
}
function lerHash() {
  const h = location.hash.replace(/^#/, "");
  const [aba, query = ""] = h.split("?");
  const q = new URLSearchParams(query);
  const f = trab.filtros;
  if (q.get("uf")) trab.uf = q.get("uf").toUpperCase();
  f.busca = q.get("q") || ""; f.municipio = q.get("mun") || ""; f.regional = q.get("reg") || ""; f.setor = q.get("setor") || ""; f.consultor = q.get("cons") || ""; f.marca = ["verde", "vermelho", "sem"].includes(q.get("marca")) ? q.get("marca") : "";
  f.status = new Set((q.get("st") || "").split(",").filter((s) => s !== "" || (q.get("st") || "").includes(",")));
  if (q.get("st") === "") f.status = new Set([""]);
  const flags = new Set((q.get("flags") || "").split(",")); f.ocultas = flags.has("ocultas"); f.semTelefone = flags.has("semTelefone"); f.inexistente = flags.has("inexistente"); f.nunca = flags.has("nunca"); f.nuncaCdr = flags.has("nuncaCdr");
  f.de = q.get("de") || ""; f.ate = q.get("ate") || "";
  const ord = (q.get("ord") || "").split(":"); if (ord[0]) trab.ordem = { campo: ord[0], dir: Number(ord[1]) === -1 ? -1 : 1 };
  return ["trabalho", "gerencial", "cores", "cobertura"].includes(aba) ? aba : "trabalho";
}

// ---------- tabela virtual ----------

const COLUNAS = [
  { campo: "marca", render: (o) => ["verde", "vermelho"].map((cor) =>
    `<button type="button" class="marca-btn marca-${cor}${o.marca === cor ? " ativo" : ""}" data-acao="marca" data-cor="${cor}"${trab.verDe ? " disabled" : ""}
      title="${trab.verDe ? `marcação de ${escapeHtml(trab.verDe.nome)} (só leitura)` : `${cor} (tecla ${cor === "verde" ? 1 : 2}) — clique de novo limpa`}"></button>`).join("") },
  { campo: "status", render: (o) => chipStatus(o), editavel: "status" },
  { campo: "municipioNome", render: (o) => escapeHtml(o.municipioNome) + (o.codigo_ibge ? "" : o.municipio_texto ? ' <span class="trab-sem-match" title="não casou com município oficial">?</span>' : ""), editavel: "municipio" },
  { campo: "regionalSigla", render: (o) => escapeHtml(o.regionalSigla) },
  { campo: "setor", render: (o) => escapeHtml(o.setor), editavel: "setor" },
  { campo: "responsavel", render: (o) => escapeHtml(o.responsavel || ""), editavel: "texto" },
  { campo: "cargo", render: (o) => escapeHtml(o.cargo || ""), editavel: "texto" },
  { campo: "telefone", render: (o) => escapeHtml(o.telefone_original || "") + (o.telefone_original && o.telefone_valido === 0 ? ' <span class="trab-invalido" title="telefone inválido">!</span>' : ""), editavel: "texto", valor: (o) => o.telefone_original },
  { campo: "whatsapp", render: (o) => escapeHtml(o.whatsapp || ""), editavel: "texto", valor: (o) => o.whatsapp },
  { campo: "email", render: (o) => escapeHtml(o.email || ""), editavel: "texto" },
  { campo: "data_ultimo_contato", render: (o) => (o.data_ultimo_contato ? escapeHtml(dataBr(o.data_ultimo_contato)) : '<span class="trab-nunca">nunca</span>'), editavel: "data" },
  { campo: "cdrUltima", render: (o) => (o.cdrUltima
    ? `<span class="trab-cdr${o.cdrContato ? " trab-cdr-contato" : ""}" title="${o.cdrContato ? `${o.cdrTotal} ligação(ões) do PABX para ESTE número` : `${o.cdrMunicipioTotal} ligação(ões) do PABX para o município (número compartilhado)`}${o.cdrQuem ? ` — última por ${escapeHtml(o.cdrQuem)}` : ""}">${escapeHtml(dataBr(o.cdrUltima))}<small>×${o.cdrTotal}</small></span>`
    : '<span class="trab-nunca" title="nenhuma ligação do PABX para este município">—</span>') },
  { campo: "pessoa_id", render: (o) => escapeHtml(o.consultorNome) || (o.consultor_planilha ? `<span class="texto-suave" title="na planilha: ${escapeHtml(o.consultor_planilha)}">—</span>` : ""), editavel: "consultor" },
  { campo: "curso", render: (o) => escapeHtml(o.curso || ""), editavel: "texto" },
  { campo: "observacoes", render: (o) => escapeHtml(o.observacoes || ""), editavel: "texto" },
  { campo: "acoes", render: (o) => `<button type="button" class="trab-btn" data-acao="registrar" title="registrar contato (R)">📞</button><button type="button" class="trab-btn" data-acao="detalhes" title="detalhes e histórico (D)">▸</button>` },
];

function chipStatus(o) {
  const hex = o.statusHexVisual;
  return hex
    ? `<span class="chip-st" style="background:#${hex};color:${textoLegivel(hex)}">${escapeHtml(o.statusNome)}</span>`
    : `<span class="chip-st chip-st-vazio">${o.cor_linha ? "cor sem nome" : "—"}</span>`;
}

function htmlLinha(o, idx) {
  const classes = ["trab-linha", o.marca ? `trab-marca-${o.marca}` : "", o.linha_oculta ? "trab-oculta" : "", o.id === trab.selecionado ? "trab-selecionada" : "", o.editado_em ? "trab-editada" : ""].filter(Boolean).join(" ");
  return `<tr class="${classes}" data-id="${o.id}" data-idx="${idx}">${COLUNAS.map((c) => `<td class="c-${c.campo}${c.editavel ? " editavel" : ""}" data-campo="${c.campo}">${c.render(o)}</td>`).join("")}</tr>`;
}

function renderizarJanela(forcar = false) {
  const total = trab.filtradas.length;
  const topo = el.trabScroll.scrollTop;
  const altura = el.trabScroll.clientHeight || 600;
  const primeira = Math.max(0, Math.floor(topo / ALTURA_LINHA) - MARGEM_LINHAS);
  const ultima = Math.min(total, Math.ceil((topo + altura) / ALTURA_LINHA) + MARGEM_LINHAS);
  if (!forcar && primeira === trab.primeiraVisivel && ultima === trab.ultimaVisivel) return;
  trab.primeiraVisivel = primeira; trab.ultimaVisivel = ultima;
  const partes = [];
  if (primeira > 0) partes.push(`<tr class="trab-espaco" style="height:${primeira * ALTURA_LINHA}px"><td colspan="${COLUNAS.length}"></td></tr>`);
  for (let i = primeira; i < ultima; i++) partes.push(htmlLinha(trab.filtradas[i], i));
  if (ultima < total) partes.push(`<tr class="trab-espaco" style="height:${(total - ultima) * ALTURA_LINHA}px"><td colspan="${COLUNAS.length}"></td></tr>`);
  if (!total) partes.push(`<tr class="trab-espaco"><td colspan="${COLUNAS.length}" class="texto-suave trab-vazio">Nenhum contato com esses filtros.</td></tr>`);
  el.trabCorpoTabela.innerHTML = partes.join("");
}

let rafScroll = 0;
el.trabScroll.addEventListener("scroll", () => {
  if (rafScroll) return;
  rafScroll = requestAnimationFrame(() => { rafScroll = 0; renderizarJanela(); });
});
window.addEventListener("resize", () => renderizarJanela(true));

function rerenderLinha(id) {
  const o = trab.porId.get(id);
  const tr = el.trabCorpoTabela.querySelector(`tr[data-id="${id}"]`);
  if (!o || !tr) return;
  enriquecer(o);
  const e = trab.editando && trab.editando.o.id === id ? trab.editando : null; // edição em curso nesta linha: preservar o controle
  tr.outerHTML = htmlLinha(o, Number(tr.dataset.idx));
  if (e) {
    const td = el.trabCorpoTabela.querySelector(`tr[data-id="${id}"] td[data-campo="${e.coluna}"]`);
    if (td) {
      td.classList.add("editando");
      td.innerHTML = "";
      td.appendChild(e.controle);
      e.td = td;
      e.controle.focus();
    }
  }
}

function atualizarLinhaLocal(arr) {
  const o = montarLinha(arr);
  const atual = trab.porId.get(o.id);
  if (atual) Object.assign(atual, o); else { trab.linhas.unshift(o); trab.porId.set(o.id, o); }
  return trab.porId.get(o.id);
}

// ---------- marcação pessoal (verde / vermelho) ----------
// Otimista e sem travar: a linha pinta na hora; o PUT leva o estado FINAL
// desejado (idempotente). Uma requisição por contato em voo; cliques durante o
// voo só atualizam o desejado e o laço reenvia até bater com o confirmado.

const marcaSync = new Map(); // id → { confirmada, desejada, emVoo }

function aplicarMarcaLocal(id, cor) {
  if (cor) trab.marcas.set(id, cor); else trab.marcas.delete(id);
  if (trab.verDe) return;
  const o = trab.porId.get(id);
  if (o) o.marca = cor;
  rerenderLinha(id);
  atualizarContador();
}

function marcar(id, cor) {
  if (trab.verDe) return avisar(`Você está vendo as marcações de ${trab.verDe.nome} — volte para "minhas" para marcar.`, true);
  if (!trab.porId.has(id)) return;
  const atual = trab.marcas.get(id) || null;
  const nova = atual === cor ? null : cor;
  let s = marcaSync.get(id);
  if (!s) { s = { confirmada: atual, desejada: atual, emVoo: false }; marcaSync.set(id, s); }
  s.desejada = nova;
  aplicarMarcaLocal(id, nova);
  if (!s.emVoo) enviarMarca(id, s);
}

async function enviarMarca(id, s) {
  s.emVoo = true;
  while (s.desejada !== s.confirmada) {
    const alvo = s.desejada;
    try {
      const r = await postJson(`/api/prospeccao/contatos/${id}/marcacao`, { cor: alvo }, "PUT");
      s.confirmada = r.cor;
    } catch (err) {
      s.desejada = s.confirmada;
      aplicarMarcaLocal(id, s.confirmada);
      avisar("⚠ Marcação não salva: " + err.message, true);
      break;
    }
  }
  s.emVoo = false;
  marcaSync.delete(id);
}

// Admin: seletor "marcações de" (as minhas ou as de outro usuário, só leitura)
function preencherMarcasDe(d) {
  if (!d.marcacoesDe) { el.fMarcasDe.classList.add("oculto"); return; }
  el.fMarcasDe.innerHTML = `<option value="">marcações: minhas</option>` +
    d.marcacoesDe.map((u) => `<option value="${u.id}">marcações de ${escapeHtml(u.nome)} (${inteiro(u.n)})</option>`).join("");
  el.fMarcasDe.value = "";
  el.fMarcasDe.classList.remove("oculto");
}

async function verMarcacoesDe(usuarioId) {
  if (!usuarioId) { trab.verDe = null; trab.marcasOutro = new Map(); }
  else {
    const r = await chamarApi(`/api/prospeccao/marcacoes?uf=${trab.uf}&usuario=${usuarioId}`);
    const u = trab.dados.marcacoesDe.find((x) => x.id === Number(usuarioId));
    trab.marcasOutro = new Map(Object.entries(r.marcacoes).map(([id, cor]) => [Number(id), cor]));
    trab.verDe = { id: Number(usuarioId), nome: u ? u.nome : "outro usuário" };
  }
  for (const o of trab.linhas) o.marca = (trab.verDe ? trab.marcasOutro : trab.marcas).get(o.id) || null;
  aplicarFiltros();
}

// ---------- seleção e teclado ----------

function selecionar(id, rolar = false) {
  const anterior = trab.selecionado;
  trab.selecionado = id;
  if (anterior) rerenderLinha(anterior);
  if (id) rerenderLinha(id);
  if (rolar && id) {
    const idx = trab.filtradas.findIndex((o) => o.id === id);
    if (idx >= 0) {
      const y = idx * ALTURA_LINHA;
      if (y < el.trabScroll.scrollTop) el.trabScroll.scrollTop = y;
      else if (y + ALTURA_LINHA > el.trabScroll.scrollTop + el.trabScroll.clientHeight - 40) el.trabScroll.scrollTop = y - el.trabScroll.clientHeight + ALTURA_LINHA + 40;
      renderizarJanela();
      rerenderLinha(id);
    }
  }
  if (!el.gaveta.classList.contains("oculto") && id) abrirGaveta(id);
}

function moverSelecao(delta) {
  if (!trab.filtradas.length) return;
  const idx = trab.filtradas.findIndex((o) => o.id === trab.selecionado);
  const novo = Math.min(trab.filtradas.length - 1, Math.max(0, (idx < 0 ? -1 : idx) + delta));
  selecionar(trab.filtradas[novo].id, true);
}

// ---------- edição inline ----------

function iniciarEdicao(td) {
  if (trab.editando) concluirEdicao(true);
  const tr = td.closest("tr");
  const o = trab.porId.get(Number(tr.dataset.id));
  const col = COLUNAS.find((c) => c.campo === td.dataset.campo);
  if (!o || !col || !col.editavel) return;
  selecionar(o.id); // re-renderiza a linha: a célula clicada saiu do DOM — buscar de novo
  td = el.trabCorpoTabela.querySelector(`tr[data-id="${o.id}"] td[data-campo="${col.campo}"]`);
  if (!td) return;
  if (col.editavel === "status") return abrirMenuStatus(td, o);
  let campo = col.campo, controle;
  const valor = col.valor ? col.valor(o) : o[col.campo];
  if (col.editavel === "consultor") {
    controle = document.createElement("select");
    controle.innerHTML = `<option value="">sem consultor</option>` + trab.dados.consultores.map((c) => `<option value="${c.id}" ${c.id === o.pessoa_id ? "selected" : ""}>${escapeHtml(c.nome)}</option>`).join("");
  } else if (col.editavel === "data") {
    controle = document.createElement("input"); controle.type = "date"; controle.value = valor || "";
  } else if (col.editavel === "municipio") {
    controle = document.createElement("input"); controle.type = "text"; controle.setAttribute("list", "lista-municipios-uf"); controle.value = o.municipioNome || o.municipio_texto || "";
    campo = "codigo_ibge";
  } else if (col.editavel === "setor") {
    controle = document.createElement("input"); controle.type = "text"; controle.setAttribute("list", "lista-setores"); controle.value = o.setor;
  } else {
    controle = document.createElement("input"); controle.type = "text"; controle.value = valor || "";
  }
  controle.className = "trab-input";
  td.classList.add("editando");
  td.innerHTML = "";
  td.appendChild(controle);
  controle.focus();
  if (controle.select) try { controle.select(); } catch (_) { /* date */ }
  trab.editando = { td, o, campo, coluna: col.campo, controle, original: valor };
}

async function concluirEdicao(cancelar, depois = null) {
  const e = trab.editando;
  if (!e) return;
  trab.editando = null;
  const { td, o, campo, controle } = e;
  let valor = controle.value;
  if (!cancelar) {
    if (campo === "codigo_ibge") {
      const nome = normalizar(valor.trim());
      const achado = Object.entries(trab.dados.municipios).find(([, [n]]) => normalizar(n) === nome);
      if (!nome) valor = null;
      else if (!achado) { rerenderLinha(o.id); avisar("Escolha um município da lista.", true); return; }
      else valor = Number(achado[0]);
      if (valor === o.codigo_ibge) { rerenderLinha(o.id); if (depois) depois(); return; }
    } else if (campo === "pessoa_id") {
      valor = valor === "" ? null : Number(valor);
      if (valor === o.pessoa_id) { rerenderLinha(o.id); if (depois) depois(); return; }
    } else if (String(valor ?? "") === String(e.original ?? "")) { rerenderLinha(o.id); if (depois) depois(); return; }
  } else { rerenderLinha(o.id); if (depois) depois(); return; }
  // otimista
  const copia = { ...o };
  if (campo === "telefone") { o.telefone_original = valor; o.telefone = String(valor || "").replace(/\D/g, "") || null; }
  else if (campo === "whatsapp") { o.whatsapp = String(valor || "").replace(/\D/g, "") || null; }
  else if (campo !== "codigo_ibge") o[campo] = valor === "" ? null : valor;
  rerenderLinha(o.id);
  if (depois) depois();
  try {
    const r = await postJson(`/api/prospeccao/contatos/${o.id}`, { [campo]: valor }, "PATCH");
    atualizarLinhaLocal(r.linha);
    rerenderLinha(o.id);
    td.classList.remove("erro");
  } catch (err) {
    Object.assign(o, copia);
    rerenderLinha(o.id);
    avisar("⚠ " + err.message, true);
  }
}

function proximaEditavel(td, direcao) {
  const tr = td.closest("tr");
  const celulas = [...tr.querySelectorAll("td.editavel")].filter((c) => c.dataset.campo !== "status");
  const i = celulas.indexOf(td);
  if (direcao > 0 && i < celulas.length - 1) return celulas[i + 1];
  if (direcao < 0 && i > 0) return celulas[i - 1];
  const irmao = direcao > 0 ? tr.nextElementSibling : tr.previousElementSibling;
  if (irmao && irmao.dataset.id) {
    const cs = [...irmao.querySelectorAll("td.editavel")].filter((c) => c.dataset.campo !== "status");
    return direcao > 0 ? cs[0] : cs[cs.length - 1];
  }
  return null;
}

// ---------- menu de status ----------

function abrirMenuStatus(td, o) {
  esconderFlutuantes();
  const itens = [{ hex: "", nome: "sem status" }, ...trab.dados.status, { hex: "inexistente", nome: "Contato inexistente", cor: COR_INEXISTENTE }];
  el.menuStatus.innerHTML = itens.map((s, i) => `<button type="button" class="trab-menu-item" data-hex="${s.hex}" data-i="${i}">
    <i style="background:#${s.hex === "inexistente" ? COR_INEXISTENTE : s.hex || "2c3347"}"></i>${escapeHtml(s.nome)}</button>`).join("");
  el.menuStatus.dataset.id = o.id;
  el.menuStatus.classList.remove("oculto");
  posicionar(el.menuStatus, td);
  el.menuStatus.querySelector(".trab-menu-item")?.focus();
}

async function escolherStatus(id, hex) {
  const o = trab.porId.get(id);
  esconderFlutuantes();
  if (!o) return;
  const corpo = hex === "inexistente" ? { contato_inexistente: 1 } : { cor_linha: hex || null, ...(o.contato_inexistente ? { contato_inexistente: 0 } : {}) };
  const copia = { ...o };
  if (hex === "inexistente") o.contato_inexistente = 1; else { o.contato_inexistente = 0; o.cor_linha = hex || null; }
  rerenderLinha(id);
  try {
    const r = await postJson(`/api/prospeccao/contatos/${id}`, corpo, "PATCH");
    atualizarLinhaLocal(r.linha);
    rerenderLinha(id);
  } catch (err) {
    Object.assign(o, copia); rerenderLinha(id); avisar("⚠ " + err.message, true);
  }
}

function posicionar(flutuante, ancora) {
  const r = ancora.getBoundingClientRect();
  flutuante.style.left = Math.min(r.left, window.innerWidth - flutuante.offsetWidth - 12) + "px";
  const abaixo = r.bottom + 6;
  flutuante.style.top = (abaixo + flutuante.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - flutuante.offsetHeight - 6) : abaixo) + "px";
}

function esconderFlutuantes() {
  el.menuStatus.classList.add("oculto");
  el.popoverContato.classList.add("oculto");
}

// ---------- registrar contato ----------

function abrirPopover(id, ancora) {
  const o = trab.porId.get(id);
  if (!o) return;
  esconderFlutuantes();
  selecionar(id);
  el.popoverContato.dataset.id = id;
  el.popoverQuem.textContent = `— ${o.municipioNome || "?"} · ${o.responsavel || o.setor}`;
  el.popoverStatus.value = "";
  el.popoverData.value = hojeIso();
  el.popoverObs.value = "";
  el.popoverContato.classList.remove("oculto");
  posicionar(el.popoverContato, ancora || el.trabCorpoTabela.querySelector(`tr[data-id="${id}"]`) || el.trabScroll);
  el.popoverObs.focus();
}

async function salvarPopover() {
  const id = Number(el.popoverContato.dataset.id);
  const canal = document.querySelector('#popover-canais input:checked').value;
  const corpo = { canal, observacao: el.popoverObs.value, statusHex: el.popoverStatus.value || undefined, data: el.popoverData.value || undefined };
  try {
    const r = await postJson(`/api/prospeccao/contatos/${id}/contatos`, corpo);
    atualizarLinhaLocal(r.linha);
    rerenderLinha(id);
    esconderFlutuantes();
    avisar("Contato registrado.");
    if (!el.gaveta.classList.contains("oculto")) abrirGaveta(id, r.historico);
    el.trabScroll.focus();
  } catch (err) {
    avisar("⚠ " + err.message, true);
  }
}

// ---------- gaveta de detalhes e histórico ----------

const CANAL_ROTULO = { ligacao: "📞 ligação", whatsapp: "💬 WhatsApp", email: "✉ e-mail", visita: "🚗 visita", outro: "outro" };
const CAMPO_ROTULO = { responsavel: "responsável", cargo: "cargo", telefone: "telefone", whatsapp: "WhatsApp", email: "e-mail", observacoes: "observações", curso: "curso", data_ultimo_contato: "último contato", cor_linha: "status", pessoa_id: "consultor", contato_inexistente: "contato inexistente", cadastro_crm: "cadastro CRM", codigo_ibge: "município", setor: "setor", linha_oculta: "oculta" };

async function abrirGaveta(id, historico = null) {
  const o = trab.porId.get(id);
  if (!o) return;
  el.gaveta.classList.remove("oculto");
  el.gavetaTitulo.textContent = o.municipioNome || o.municipio_texto || "Contato";
  const campos = [["Setor", o.setor], ["Órgão", o.orgao], ["Regional", o.regionalSigla], ["Responsável", o.responsavel], ["Cargo", o.cargo],
    ["Telefone", o.telefone_original + (o.telefone && o.telefone !== o.telefone_original ? ` → ${o.telefone}` : "")], ["WhatsApp", o.whatsapp], ["E-mail", o.email],
    ["Último contato", dataBr(o.data_ultimo_contato)], ["Status", o.statusNome || "—"], ["Consultor", o.consultorNome || (o.consultor_planilha ? `— (planilha: ${o.consultor_planilha})` : "—")],
    ["Curso", o.curso], ["Cadastro CRM", o.cadastro_crm === 1 ? "sim" : o.cadastro_crm === 0 ? "não" : ""], ["Origem", o.origem === "manual" ? "criado no jonIAs" : `planilha (${o.linha_oculta ? "linha oculta" : "visível"})`], ["Editado", o.editado_em ? dataHoraBr(o.editado_em) : ""]];
  el.gavetaConteudo.innerHTML = `
    <ul class="lista-simples trab-detalhes">${campos.filter(([, v]) => v).map(([k, v]) => `<li><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></li>`).join("")}</ul>
    ${o.observacoes ? `<p class="trab-obs-completa">${escapeHtml(o.observacoes)}</p>` : ""}
    <div class="trab-gaveta-acoes"><button type="button" class="btn-mini btn-primario" data-acao="registrar" data-id="${o.id}">📞 Registrar contato</button>
      <label class="trab-flag"><input type="checkbox" id="gaveta-oculta" ${o.linha_oculta ? "checked" : ""} /> oculta</label></div>
    <h4>Histórico</h4><div id="gaveta-historico" class="texto-suave">carregando…</div>
    <h4 title="ligações do PABX (CDR) — só leitura, não altera o último contato">Ligações do PABX (CDR)</h4><div id="gaveta-cdr" class="texto-suave">carregando…</div>`;
  try {
    const h = historico || (await chamarApi(`/api/prospeccao/contatos/${id}/historico`)).historico;
    document.getElementById("gaveta-historico").innerHTML = h.length
      ? `<ul class="trab-historico">${h.map((x) => `<li><span class="texto-suave">${escapeHtml(dataHoraBr(x.registradoEm))} · ${escapeHtml(x.usuario)}</span><br>${descreverHistorico(x)}</li>`).join("")}</ul>`
      : `<p class="texto-suave">Nenhum registro ainda — a linha veio da planilha como está.</p>`;
  } catch (err) {
    document.getElementById("gaveta-historico").textContent = "não foi possível carregar o histórico";
  }
  try {
    const l = await chamarApi(`/api/prospeccao/contatos/${id}/ligacoes`);
    const alvo = document.getElementById("gaveta-cdr");
    if (!alvo) return;
    const item = (x) => `<li><span class="texto-suave">${escapeHtml(dataHoraBr(x.dataHora))}</span><span class="${x.atendida ? "lig-ok" : "lig-falha"}">${x.atendida ? `atendida${x.conversaSeg ? ` · ${Math.round(x.conversaSeg / 60)} min` : ""}` : x.eventoFalha ? escapeHtml(x.eventoFalha.toLowerCase()) : "não atendida"}</span><span>${escapeHtml(x.consultor || "sem consultor")}</span>${x.sentido !== "S" ? '<span class="texto-suave">recebida</span>' : ""}</li>`;
    const partes = [];
    if (l.doNumero.length) partes.push(`<p class="texto-suave">Para este número (${l.doNumero.length}${l.doNumero.length >= 30 ? "+" : ""}):</p><ul class="trab-ligacoes">${l.doNumero.map(item).join("")}</ul>`);
    const outras = l.doMunicipio.filter((x) => !l.doNumero.some((y) => y.id === x.id));
    if (outras.length) partes.push(`<p class="texto-suave">Para o município (${inteiro(l.totalMunicipio)} no total; últimas ${outras.length}):</p><ul class="trab-ligacoes">${outras.slice(0, 10).map(item).join("")}</ul>`);
    alvo.innerHTML = partes.join("") || `<p class="texto-suave">Nenhuma ligação do PABX para este número ou município.</p>`;
  } catch (err) {
    const alvo = document.getElementById("gaveta-cdr");
    if (alvo) alvo.textContent = "não foi possível carregar as ligações";
  }
}

function descreverHistorico(x) {
  if (x.tipo === "contato") return `<strong>${escapeHtml(CANAL_ROTULO[x.canal] || x.canal)}</strong>${x.statusNovo && x.valorNovo !== x.valorAnterior ? ` → status <strong>${escapeHtml(x.statusNovo)}</strong>` : ""}${x.observacao ? `<br>${escapeHtml(x.observacao)}` : ""}`;
  if (x.tipo === "criacao") return `<strong>criado</strong> ${escapeHtml(x.observacao || "")}`;
  const campo = CAMPO_ROTULO[x.campo] || x.campo;
  const de = x.campo === "cor_linha" ? x.statusAnterior || (x.valorAnterior ? "cor " + x.valorAnterior : "—") : x.valorAnterior ?? "—";
  const para = x.campo === "cor_linha" ? x.statusNovo || (x.valorNovo ? "cor " + x.valorNovo : "—") : x.valorNovo ?? "—";
  return `<strong>${escapeHtml(campo)}</strong>: <span class="texto-suave">${escapeHtml(String(de).slice(0, 80))}</span> → ${escapeHtml(String(para).slice(0, 120))}`;
}

// ---------- novo contato ----------

function abrirModalNovo() {
  el.nUf.value = trab.uf;
  for (const id of ["n-setor", "n-municipio", "n-responsavel", "n-cargo", "n-telefone", "n-whatsapp", "n-email", "n-curso", "n-obs"]) document.getElementById(id).value = "";
  if (trab.filtros.setor) el.nSetor.value = trab.filtros.setor;
  el.nStatus.value = ""; el.nConsultor.value = "";
  el.modalNovoErro.classList.add("oculto");
  el.modalNovo.classList.remove("oculto");
  el.nSetor.focus();
}

async function salvarNovo() {
  const v = (id) => document.getElementById(id).value.trim();
  const nomeMun = normalizar(v("n-municipio"));
  const achado = nomeMun ? Object.entries(trab.dados.municipios).find(([, [n]]) => normalizar(n) === nomeMun) : null;
  const corpo = { uf: v("n-uf"), setor: v("n-setor"), responsavel: v("n-responsavel"), cargo: v("n-cargo"), telefone: v("n-telefone"), whatsapp: v("n-whatsapp"),
    email: v("n-email"), curso: v("n-curso"), observacoes: v("n-obs"), cor_linha: el.nStatus.value || null, pessoa_id: el.nConsultor.value || null };
  if (achado) corpo.codigo_ibge = Number(achado[0]); else if (v("n-municipio")) corpo.municipio_texto = v("n-municipio");
  try {
    const r = await postJson("/api/prospeccao/contatos", corpo);
    el.modalNovo.classList.add("oculto");
    if (corpo.uf !== trab.uf) { avisar(`Contato criado em ${corpo.uf}.`); return; }
    const o = atualizarLinhaLocal(r.linha);
    if (!trab.dados.setores.includes(o.setor)) { trab.dados.setores.push(o.setor); trab.dados.setores.sort(); preencherFiltrosEstaticos(); }
    aplicarFiltros();
    selecionar(o.id, true);
    avisar("Contato criado.");
  } catch (err) {
    el.modalNovoErro.textContent = err.message;
    el.modalNovoErro.classList.remove("oculto");
  }
}

// ---------- exportação ----------

async function exportar(soFiltro) {
  const corpo = { uf: trab.uf, ids: soFiltro ? trab.filtradas.map((o) => o.id) : undefined };
  avisar(`Gerando .xlsx (${soFiltro ? inteiro(trab.filtradas.length) + " linhas do filtro" : "UF inteira"})…`);
  const r = await fetch("/api/prospeccao/exportar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); return avisar("⚠ " + (e.error || `erro ${r.status}`), true); }
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (r.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/)?.[1] || `prospeccao_${trab.uf}.xlsx`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- eventos da aba Trabalho ----------

el.trabCorpoTabela.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-acao]");
  const tr = ev.target.closest("tr[data-id]");
  if (!tr) return;
  const id = Number(tr.dataset.id);
  if (btn) {
    if (btn.dataset.acao === "marca") {
      if (trab.selecionado !== id) selecionar(id);
      marcar(id, btn.dataset.cor);
      el.trabScroll.focus({ preventScroll: true }); // o botão saiu do DOM no re-render: manter o teclado na tabela
      return;
    }
    if (btn.dataset.acao === "registrar") abrirPopover(id, btn);
    if (btn.dataset.acao === "detalhes") { selecionar(id); abrirGaveta(id); }
    return;
  }
  const td = ev.target.closest("td");
  if (trab.editando && trab.editando.td === td) return;
  if (td && td.classList.contains("editavel")) iniciarEdicao(td);
  else selecionar(id);
});

el.trabCorpoTabela.addEventListener("keydown", (ev) => {
  const e = trab.editando;
  if (!e || !e.td.contains(ev.target)) return;
  if (ev.key === "Escape") { ev.preventDefault(); concluirEdicao(true); el.trabScroll.focus(); }
  else if (ev.key === "Enter" && e.controle.tagName !== "TEXTAREA") { ev.preventDefault(); concluirEdicao(false, () => el.trabScroll.focus()); }
  else if (ev.key === "Tab") {
    ev.preventDefault();
    const proxima = proximaEditavel(e.td, ev.shiftKey ? -1 : 1);
    concluirEdicao(false, () => { if (proxima) { const td = el.trabCorpoTabela.querySelector(`tr[data-id="${proxima.closest("tr").dataset.id}"] td[data-campo="${proxima.dataset.campo}"]`); if (td) iniciarEdicao(td); } });
  }
});
el.trabCorpoTabela.addEventListener("focusout", (ev) => {
  const e = trab.editando;
  // o controle pode ter sido movido de célula (re-render da linha) e re-focado: só salva se o foco realmente saiu
  if (e && ev.target === e.controle) setTimeout(() => { if (trab.editando === e && document.activeElement !== e.controle) concluirEdicao(false); }, 120);
});
el.trabCorpoTabela.addEventListener("change", (ev) => {
  const e = trab.editando;
  if (e && ev.target === e.controle && (e.controle.tagName === "SELECT" || e.controle.type === "date")) concluirEdicao(false, () => el.trabScroll.focus());
});

el.trabScroll.addEventListener("keydown", (ev) => {
  if (trab.editando || ev.target.matches("input, select, textarea")) return;
  if (ev.key === "ArrowDown") { ev.preventDefault(); moverSelecao(1); }
  else if (ev.key === "ArrowUp") { ev.preventDefault(); moverSelecao(-1); }
  else if (["1", "2", "0"].includes(ev.key) && !ev.ctrlKey && !ev.altKey && !ev.metaKey && trab.selecionado) {
    ev.preventDefault();
    const atual = trab.marcas.get(trab.selecionado);
    if (ev.key === "0") { if (atual) marcar(trab.selecionado, atual); }
    else marcar(trab.selecionado, ev.key === "1" ? "verde" : "vermelho");
  }
  else if (ev.key.toLowerCase() === "r" && trab.selecionado) { ev.preventDefault(); abrirPopover(trab.selecionado); }
  else if (ev.key.toLowerCase() === "d" && trab.selecionado) { ev.preventDefault(); abrirGaveta(trab.selecionado); }
  else if (ev.key === "Enter" && trab.selecionado) { const td = el.trabCorpoTabela.querySelector(`tr[data-id="${trab.selecionado}"] td[data-campo="responsavel"]`); if (td) iniciarEdicao(td); }
});

document.querySelector("#trab-tabela thead").addEventListener("click", (ev) => {
  const th = ev.target.closest("th[data-ordem]");
  if (!th) return;
  const campo = th.dataset.ordem;
  trab.ordem = { campo, dir: trab.ordem.campo === campo ? -trab.ordem.dir : 1 };
  ordenar(); trab.primeiraVisivel = -1; renderizarJanela(true); gravarHash();
});

el.menuStatus.addEventListener("click", (ev) => {
  const b = ev.target.closest(".trab-menu-item");
  if (b) escolherStatus(Number(el.menuStatus.dataset.id), b.dataset.hex);
});
el.menuStatus.addEventListener("keydown", (ev) => {
  const itens = [...el.menuStatus.querySelectorAll(".trab-menu-item")];
  const i = itens.indexOf(document.activeElement);
  if (ev.key === "ArrowDown") { ev.preventDefault(); itens[Math.min(itens.length - 1, i + 1)]?.focus(); }
  else if (ev.key === "ArrowUp") { ev.preventDefault(); itens[Math.max(0, i - 1)]?.focus(); }
  else if (ev.key === "Escape") { esconderFlutuantes(); el.trabScroll.focus(); }
  else if (ev.key.length === 1) { const alvo = itens.find((b) => normalizar(b.textContent).trim().startsWith(ev.key.toLowerCase())); alvo?.focus(); }
});

document.getElementById("popover-salvar").addEventListener("click", salvarPopover);
document.getElementById("popover-cancelar").addEventListener("click", () => { esconderFlutuantes(); el.trabScroll.focus(); });
el.popoverContato.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") { esconderFlutuantes(); el.trabScroll.focus(); }
  if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); salvarPopover(); }
});
document.getElementById("btn-fechar-gaveta").addEventListener("click", () => el.gaveta.classList.add("oculto"));
el.gaveta.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-acao='registrar']");
  if (b) abrirPopover(Number(b.dataset.id), b);
});
el.gaveta.addEventListener("change", async (ev) => {
  if (ev.target.id === "gaveta-oculta" && trab.selecionado) {
    const id = trab.selecionado;
    try { const r = await postJson(`/api/prospeccao/contatos/${id}`, { linha_oculta: ev.target.checked ? 1 : 0 }, "PATCH"); atualizarLinhaLocal(r.linha); rerenderLinha(id); }
    catch (err) { avisar("⚠ " + err.message, true); }
  }
});
document.addEventListener("click", (ev) => {
  if (!ev.target.closest("#menu-status, #popover-contato, .c-status, button[data-acao]")) esconderFlutuantes();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (!el.modalNovo.classList.contains("oculto")) el.modalNovo.classList.add("oculto");
    else if (!el.menuStatus.classList.contains("oculto") || !el.popoverContato.classList.contains("oculto")) esconderFlutuantes();
    else if (!el.gaveta.classList.contains("oculto")) el.gaveta.classList.add("oculto");
  }
  if (ev.key === "/" && !ev.target.matches("input, select, textarea") && !document.getElementById("aba-trabalho").classList.contains("oculto")) { ev.preventDefault(); el.fBusca.focus(); el.fBusca.select(); }
});

// filtros
let debounceBusca = 0;
el.fBusca.addEventListener("input", () => { clearTimeout(debounceBusca); debounceBusca = setTimeout(() => { lerFiltros(); aplicarFiltros(); }, 90); });
el.fMunicipio.addEventListener("input", () => { clearTimeout(debounceBusca); debounceBusca = setTimeout(() => { lerFiltros(); aplicarFiltros(); }, 120); });
el.fMarcasDe.addEventListener("change", () => verMarcacoesDe(el.fMarcasDe.value).catch((e) => { el.fMarcasDe.value = ""; avisar("⚠ " + e.message, true); }));
for (const id of ["f-regional", "f-setor", "f-consultor", "f-marca", "f-ocultas", "f-sem-telefone", "f-inexistente", "f-nunca", "f-nunca-cdr", "f-de", "f-ate"]) {
  document.getElementById(id).addEventListener("change", () => { lerFiltros(); aplicarFiltros(); });
}
el.fUf.addEventListener("change", async () => { trab.uf = el.fUf.value; trab.filtros.status = new Set(); trab.filtros.regional = ""; trab.filtros.setor = ""; el.gaveta.classList.add("oculto"); try { await carregarTrabalho(); } catch (e) { avisar("⚠ " + e.message, true); } });
el.fStatus.addEventListener("click", (ev) => {
  const b = ev.target.closest(".chip-status");
  if (!b) return;
  const hex = b.dataset.hex;
  if (trab.filtros.status.has(hex)) trab.filtros.status.delete(hex); else trab.filtros.status.add(hex);
  b.classList.toggle("ativo");
  aplicarFiltros();
});
document.getElementById("btn-limpar-filtros").addEventListener("click", () => {
  Object.assign(trab.filtros, { busca: "", municipio: "", regional: "", setor: "", consultor: "", marca: "", status: new Set(), ocultas: false, semTelefone: false, inexistente: false, nunca: false, nuncaCdr: false, de: "", ate: "" });
  preencherFiltrosEstaticos(); aplicarFiltros();
});
document.getElementById("btn-novo-contato").addEventListener("click", abrirModalNovo);
document.getElementById("btn-salvar-novo").addEventListener("click", salvarNovo);
document.getElementById("btn-exportar-filtro").addEventListener("click", () => exportar(true));
document.getElementById("btn-exportar-tudo").addEventListener("click", () => exportar(false));
for (const b of document.querySelectorAll("[data-fechar]")) b.addEventListener("click", () => document.getElementById(b.dataset.fechar).classList.add("oculto"));
el.modalNovo.addEventListener("click", (ev) => { if (ev.target === el.modalNovo) el.modalNovo.classList.add("oculto"); });
el.modalNovo.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.tagName !== "TEXTAREA") { ev.preventDefault(); salvarNovo(); } });
el.nUf.addEventListener("change", () => { if (el.nUf.value !== trab.uf) avisar("Município será casado pelo texto: a lista mostra só municípios da UF carregada."); });

// =====================================================================
// CORES E STATUS (Fase 1) + criação de status
// =====================================================================

let cores = [];

function linhaCor(c) {
  const exemplos = c.exemplos.map((e) =>
    `<li>${escapeHtml([e.municipio, e.responsavel, e.telefone].filter(Boolean).join(" · ") || "(linha sem cidade/responsável)")}` +
    `${e.observacoes ? ` <span class="texto-suave">— ${escapeHtml(String(e.observacoes).slice(0, 80))}</span>` : ""}</li>`).join("");
  const celulas = c.exemplosCelula.length
    ? `<div class="texto-suave territorio-descricao">só na célula: ${c.exemplosCelula.map((e) => `${escapeHtml(e.campo)} (${escapeHtml(e.municipio || e.setor)})`).join(", ")}</div>` : "";
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
  const corpo = { statusNome: tr.querySelector(".campo-status").value, significado: tr.querySelector(".campo-significado").value, ignorar: tr.querySelector(".campo-ignorar").checked };
  try {
    const atualizada = await postJson(`/api/prospeccao/cores/${hex}`, corpo, "PUT");
    const i = cores.findIndex((c) => c.hex === hex);
    if (i >= 0) cores[i] = atualizada;
    renderizarCores();
    avisar(`#${hex} salva${atualizada.statusNome ? ` como "${atualizada.statusNome}"` : ""}.`);
    // a lista de status da tela de trabalho muda junto
    if (trab.dados) { trab.dados = null; await carregarTrabalho().catch(() => {}); }
  } catch (e) {
    avisar("⚠ " + e.message, true);
  }
}

document.getElementById("tabela-cores").addEventListener("change", (ev) => {
  const tr = ev.target.closest("tr[data-hex]");
  if (tr && ev.target.matches(".campo-status, .campo-significado, .campo-ignorar")) salvarCor(tr);
});
document.getElementById("tabela-cores").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ev.target.matches(".campo-status, .campo-significado")) { ev.preventDefault(); ev.target.blur(); }
});
document.getElementById("mostrar-ignoradas").addEventListener("change", renderizarCores);
document.getElementById("btn-novo-status").addEventListener("click", async () => {
  const corpo = { nome: document.getElementById("novo-status-nome").value, corHex: document.getElementById("novo-status-cor").value, significado: document.getElementById("novo-status-sig").value };
  try {
    const s = await postJson("/api/prospeccao/status", corpo);
    document.getElementById("novo-status-nome").value = ""; document.getElementById("novo-status-sig").value = "";
    avisar(`Status "${s.statusNome}" criado.`);
    await carregarCores();
    if (trab.dados) { trab.dados = null; await carregarTrabalho().catch(() => {}); }
  } catch (e) {
    avisar("⚠ " + e.message, true);
  }
});

// =====================================================================
// COBERTURA (Fase 1)
// =====================================================================

const ROTULO_GRUPO = { casado: "casado com município", pendente: "pendente de revisão", fora: "fora da UF", sem_cidade: "sem cidade", ignorado: "ignorado na revisão", nao_processado: "não processado" };

function renderizarCobertura(c) {
  const total = c.porUf.reduce((s, u) => s + u.linhas, 0);
  const cards = c.porUf.map((u) => `<div class="metrica-card"><span class="metrica-rotulo">${escapeHtml(u.uf)} — ${u.abas} abas</span>
    <span class="metrica-valor">${inteiro(u.linhas)}</span>
    <span class="metrica-extra">${inteiro(u.ocultas)} ocultas · telefone válido ${pctDe(u.telefonesValidos, u.linhas)} · município casado ${pctDe(u.municipiosCasados, u.linhas)} (${inteiro(u.municipiosDistintos)} municípios) · ${u.municipiosPendentes} pendentes · ${u.cores} cores</span></div>`).join("");
  const grupos = c.municipiosPorGrupo.map((g) => `${escapeHtml(g.uf)} ${ROTULO_GRUPO[g.grupo] || g.grupo}: ${inteiro(g.n)}`).join(" · ");
  document.getElementById("cards-cobertura").innerHTML = cards +
    `<div class="metrica-card"><span class="metrica-rotulo">Total</span><span class="metrica-valor">${inteiro(total)}</span><span class="metrica-extra">${escapeHtml(grupos || "nenhuma linha")}</span></div>` +
    `<div class="metrica-card"><span class="metrica-rotulo">Cores → status</span><span class="metrica-valor">${inteiro(c.status.nomeadas)} <small>de ${inteiro(c.status.cores)}</small></span><span class="metrica-extra">com nome · ${inteiro(c.status.ignoradas)} marcadas como formatação</span></div>`;
  const linhas = c.porAba.map((a) => `<tr class="sem-clique">
    <td>${escapeHtml(a.uf)}</td><td class="celula-nome">${escapeHtml(a.setor)}</td><td>${escapeHtml(a.orgao || "—")}</td>
    <td>${inteiro(a.linhas)}</td><td>${inteiro(a.ocultas)}</td><td>${inteiro(a.telefonesValidos)}</td><td class="${a.telefonesValidos / a.linhas >= 0.7 ? "pct-ok" : a.telefonesValidos / a.linhas >= 0.4 ? "pct-meio" : "pct-baixo"}">${pctDe(a.telefonesValidos, a.linhas)}</td>
    <td>${inteiro(a.whatsapps)}</td><td>${inteiro(a.emails)}</td>
    <td>${inteiro(a.municipiosCasados)}</td><td class="${a.municipiosCasados / a.linhas >= 0.9 ? "pct-ok" : a.municipiosCasados / a.linhas >= 0.6 ? "pct-meio" : "pct-baixo"}">${pctDe(a.municipiosCasados, a.linhas)}</td>
    <td>${a.municipiosPendentes ? `<span class="pct-baixo">${inteiro(a.municipiosPendentes)}</span>` : "0"}</td><td>${inteiro(a.semMunicipio)}</td>
    <td>${inteiro(a.cores)}</td><td>${inteiro(a.editadas)}</td></tr>`).join("");
  document.querySelector("#tabela-abas tbody").innerHTML = linhas || `<tr class="sem-clique"><td colspan="15" class="texto-suave">Nenhuma planilha importada ainda.</td></tr>`;
  const soma = (k) => c.porAba.reduce((s, a) => s + (a[k] || 0), 0);
  document.querySelector("#tabela-abas tfoot").innerHTML = c.porAba.length
    ? `<tr><td colspan="3">Total (${c.porAba.length} abas)</td><td>${inteiro(soma("linhas"))}</td><td>${inteiro(soma("ocultas"))}</td>
       <td>${inteiro(soma("telefonesValidos"))}</td><td>${pctDe(soma("telefonesValidos"), soma("linhas"))}</td><td>${inteiro(soma("whatsapps"))}</td><td>${inteiro(soma("emails"))}</td>
       <td>${inteiro(soma("municipiosCasados"))}</td><td>${pctDe(soma("municipiosCasados"), soma("linhas"))}</td><td>${inteiro(soma("municipiosPendentes"))}</td>
       <td>${inteiro(soma("semMunicipio"))}</td><td></td><td>${inteiro(soma("editadas"))}</td></tr>` : "";
  const blocos = Object.entries(c.naoReconhecidas || {}).map(([uf, info]) => {
    const colunas = (info.colunas || []).map((col) => `<li><code>${escapeHtml(col.rotulo)}</code> — ${col.abas.length} aba(s), ${inteiro(col.linhas)} valor(es) <span class="texto-suave">(${col.abas.slice(0, 5).map(escapeHtml).join(", ")}${col.abas.length > 5 ? "…" : ""})</span></li>`).join("");
    const abas = (info.abasNaoImportadas || []).map((a) => `<li><strong>${escapeHtml(a.aba)}</strong>: ${escapeHtml(a.motivo)}</li>`).join("");
    return `<div class="fonte-card"><h3>${escapeHtml(uf)}</h3>
      ${abas ? `<p class="texto-suave">Abas não importadas:</p><ul class="lista-simples prospeccao-lista">${abas}</ul>` : ""}
      <ul class="lista-simples prospeccao-lista">${colunas || "<li class='saude-ok'>✔ todas as colunas reconhecidas</li>"}</ul></div>`;
  });
  document.getElementById("nao-reconhecidas").innerHTML = blocos.length ? `<div class="grade-fontes">${blocos.join("")}</div>` : `<p class="texto-suave">Nenhuma importação ainda.</p>`;
}

async function carregarCobertura() {
  renderizarCobertura(await chamarApi("/api/prospeccao/cobertura"));
}

// =====================================================================

document.getElementById("btn-sair").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});
window.addEventListener("hashchange", () => { if (ignorarHash) return; const aba = lerHash(); mostrarAba(aba); if (trab.dados && trab.uf === el.fUf.value) { preencherFiltrosEstaticos(); aplicarFiltros(); } });

// ---------- Gerencial (admin): drill down por regional ----------

async function carregarGerencial() {
  const g = await chamarApi("/api/prospeccao/gerencial");
  const soma = (k) => g.regionais.reduce((s, r) => s + (r[k] || 0), 0);
  document.getElementById("gerencial-cards").innerHTML = g.porUf.map((u) => `<div class="metrica-card"><span class="metrica-rotulo">${escapeHtml(u.uf)}</span>
      <span class="metrica-valor">${inteiro(u.contatos)}</span><span class="metrica-extra">${inteiro(u.semConsultor)} sem consultor · ${inteiro(u.nuncaTocados)} nunca tocados</span></div>`).join("") +
    `<div class="metrica-card"><span class="metrica-rotulo">Regionais com titular</span><span class="metrica-valor">${g.regionais.filter((r) => r.titular).length} <small>de ${g.regionais.length}</small></span>
      <span class="metrica-extra">${g.semRegional.map((s) => `${escapeHtml(s.uf)}: ${inteiro(s.contatos)} contatos sem regional (município não casado)`).join(" · ") || "todos os contatos têm regional"}</span></div>`;
  document.querySelector("#tabela-gerencial tbody").innerHTML = g.regionais.map((r) => `<tr data-regional="${r.id}" data-uf="${escapeHtml(r.uf)}" title="abrir na aba Trabalho">
    <td>${escapeHtml(r.uf)}</td><td class="celula-nome">${escapeHtml(r.sigla)}<div class="texto-suave territorio-descricao">${escapeHtml(r.nome || "")}</div></td>
    <td style="text-align:left">${r.titular ? escapeHtml(r.titular) : '<span class="pct-baixo">sem titular</span>'}</td><td style="text-align:left" class="texto-suave">${r.apoios.map(escapeHtml).join(", ") || "—"}</td>
    <td>${inteiro(r.contatos)}</td><td>${inteiro(r.telefonesValidos)}</td><td>${r.semConsultor ? `<span class="pct-meio">${inteiro(r.semConsultor)}</span>` : "0"}</td>
    <td>${inteiro(r.trabalhados)}</td><td class="${r.contatos && r.trabalhados / r.contatos >= 0.6 ? "pct-ok" : r.contatos && r.trabalhados / r.contatos >= 0.3 ? "pct-meio" : "pct-baixo"}">${pctDe(r.trabalhados, r.contatos)}</td>
    <td>${inteiro(r.nuncaTocados)}</td><td>${inteiro(r.inexistentes)}</td><td>${escapeHtml(dataBr(r.ultimoContato))}</td><td>${inteiro(r.editados)}</td></tr>`).join("");
  document.querySelector("#tabela-gerencial tfoot").innerHTML = `<tr><td colspan="4">Total (${g.regionais.length} regionais)</td><td>${inteiro(soma("contatos"))}</td><td>${inteiro(soma("telefonesValidos"))}</td>
    <td>${inteiro(soma("semConsultor"))}</td><td>${inteiro(soma("trabalhados"))}</td><td>${pctDe(soma("trabalhados"), soma("contatos"))}</td><td>${inteiro(soma("nuncaTocados"))}</td><td>${inteiro(soma("inexistentes"))}</td><td></td><td>${inteiro(soma("editados"))}</td></tr>`;
}

document.getElementById("tabela-gerencial").addEventListener("click", async (ev) => {
  const tr = ev.target.closest("tr[data-regional]");
  if (!tr) return;
  const uf = tr.dataset.uf;
  Object.assign(trab.filtros, { busca: "", municipio: "", regional: tr.dataset.regional, setor: "", consultor: "", marca: "", status: new Set(), ocultas: false, semTelefone: false, inexistente: false, nunca: false, nuncaCdr: false, de: "", ate: "" });
  mostrarAba("trabalho");
  if (trab.uf !== uf) { trab.uf = uf; el.fUf.value = uf; await carregarTrabalho().catch((e) => avisar("⚠ " + e.message, true)); }
  else { preencherFiltrosEstaticos(); aplicarFiltros(); }
});

// ---------- Gerencial (admin): CDR × carteiras (Fase 4, só leitura) ----------

const cdrUi = { de: "", ate: "" };
function periodoCdr(tipo) {
  const hoje = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (tipo === "mes") return [iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), iso(hoje)];
  if (tipo === "mes-anterior") return [iso(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)), iso(new Date(hoje.getFullYear(), hoje.getMonth(), 0))];
  const d = new Date(hoje); d.setDate(hoje.getDate() - 30); return [iso(d), iso(hoje)];
}
const CLASSE_ROTULO = { prospeccao: "Prospecção", ambigua: "Ambíguas (2 municípios)", cliente: "Clientes (alunos)", lead: "Leads (Omie)", desconhecida: "Desconhecidas", interna: "Internas", nao_cruzada: "Não cruzadas" };

async function carregarCdr(de = cdrUi.de, ate = cdrUi.ate) {
  if (!de || !ate) [de, ate] = periodoCdr("mes");
  cdrUi.de = de; cdrUi.ate = ate;
  document.getElementById("cdr-de").value = de; document.getElementById("cdr-ate").value = ate;
  document.getElementById("cdr-legenda").textContent = `${dataBr(de)} a ${dataBr(ate)}`;
  const g = await chamarApi(`/api/prospeccao/cdr?de=${de}&ate=${ate}`);
  const cl = g.classes;
  const card = (rotulo, valor, extra = "") => `<div class="metrica-card"><span class="metrica-rotulo">${rotulo}</span><span class="metrica-valor">${valor}</span><span class="metrica-extra">${extra}</span></div>`;
  const pros = cl.prospeccao || { ligacoes: 0, atendidas: 0, municipios: 0 };
  document.getElementById("cdr-cards").innerHTML = [
    card("Ligações no período", inteiro(g.total), `${inteiro(g.semRegional || 0)} de prospecção sem regional`),
    card("Prospecção", `${inteiro(pros.ligacoes)} <small>${pctDe(pros.ligacoes, g.total)}</small>`, `${inteiro(pros.atendidas)} atendidas · ${inteiro(pros.municipios)} municípios distintos`),
    ...["ambigua", "cliente", "lead", "desconhecida"].map((k) => card(CLASSE_ROTULO[k], `${inteiro(cl[k]?.ligacoes)} <small>${pctDe(cl[k]?.ligacoes || 0, g.total)}</small>`, `${inteiro(cl[k]?.atendidas)} atendidas`)),
  ].join("");
  const regs = g.regionais;
  const soma = (k) => regs.reduce((s, r) => s + (r[k] || 0), 0);
  document.querySelector("#tabela-cdr-regionais tbody").innerHTML = regs.map((r) => `<tr data-regional="${r.id}" data-uf="${escapeHtml(r.uf)}" title="abrir na aba Trabalho">
    <td>${escapeHtml(r.uf)}</td><td class="celula-nome">${escapeHtml(r.sigla)}<div class="texto-suave territorio-descricao">${escapeHtml(r.nome || "")}</div></td>
    <td>${inteiro(r.ligacoes)}</td><td>${inteiro(r.atendidas)}</td><td>${inteiro(r.municipiosLigados)}</td><td>${inteiro(r.municipiosComContatos)}</td>
    <td class="${r.municipiosComContatos && r.municipiosLigados / r.municipiosComContatos >= 0.6 ? "pct-ok" : r.municipiosComContatos && r.municipiosLigados / r.municipiosComContatos >= 0.3 ? "pct-meio" : "pct-baixo"}">${pctDe(r.municipiosLigados, r.municipiosComContatos)}</td>
    <td>${r.nuncaLigados ? `<span class="pct-meio">${inteiro(r.nuncaLigados)}</span>` : "0"}</td><td>${r.foraDaCarteira ? `<span class="pct-baixo">${inteiro(r.foraDaCarteira)}</span>` : "0"}</td>
    <td style="text-align:left" class="cdr-quem">${r.porConsultor.map((c) => `${escapeHtml(c.nome)} ${inteiro(c.ligacoes)}`).join(" · ") || "—"}</td></tr>`).join("");
  document.querySelector("#tabela-cdr-regionais tfoot").innerHTML = `<tr><td colspan="2">Total (${regs.length} regionais)</td><td>${inteiro(soma("ligacoes"))}</td><td>${inteiro(soma("atendidas"))}</td>
    <td>${inteiro(soma("municipiosLigados"))}</td><td>${inteiro(soma("municipiosComContatos"))}</td><td>${pctDe(soma("municipiosLigados"), soma("municipiosComContatos"))}</td><td>${inteiro(soma("nuncaLigados"))}</td><td>${inteiro(soma("foraDaCarteira"))}</td><td></td></tr>`;
  document.querySelector("#tabela-cdr-consultores tbody").innerHTML = (g.porConsultor || []).map((c) => `<tr class="sem-clique"><td style="text-align:left">${escapeHtml(c.nome || "sem consultor (ramal sem dono)")}</td>
    <td>${inteiro(c.ligacoes)}</td><td>${inteiro(c.prospeccao)}</td><td>${pctDe(c.prospeccao, c.ligacoes)}</td><td>${inteiro(c.municipios)}</td>
    <td>${c.ambiguas ? `<span class="pct-meio">${inteiro(c.ambiguas)}</span>` : "0"}</td><td>${inteiro(c.clientes)}</td><td>${inteiro(c.leads)}</td><td>${inteiro(c.desconhecidas)}</td></tr>`).join("")
    || `<tr class="sem-clique"><td colspan="9" class="texto-suave">Nenhuma ligação no período.</td></tr>`;
  const amb = g.ambiguas || [];
  document.getElementById("chip-ambiguas").textContent = `${amb.length} número(s)`;
  document.querySelector("#tabela-cdr-ambiguas tbody").innerHTML = amb.map((a) => `<tr class="sem-clique"><td style="text-align:left"><a href="#trabalho?uf=${escapeHtml(a.uf || trab.uf)}&q=${escapeHtml(a.numero)}" data-cdr-numero="${escapeHtml(a.numero)}" data-uf="${escapeHtml(a.uf || "")}">${escapeHtml(a.numero)}</a></td>
    <td>${inteiro(a.ligacoes)}</td><td>${escapeHtml(dataHoraBr(a.ultima))}</td>
    <td style="text-align:left">${a.municipios.map((m) => `${escapeHtml(m.municipio)} <small class="texto-suave">(${m.linhas})</small>`).join(" · ")}</td></tr>`).join("")
    || `<tr class="sem-clique"><td colspan="4" class="texto-suave">Nenhuma ligação ambígua no período.</td></tr>`;
  document.getElementById("cdr-ddd").innerHTML = (g.desconhecidasPorDdd || []).map((d) => `<span class="chip cdr-ddd-chip">DDD ${escapeHtml(d.ddd)} <strong>${inteiro(d.n)}</strong> <small>${inteiro(d.atendidas)} atend.</small></span>`).join("")
    || "Nenhuma ligação desconhecida no período.";
}

document.querySelector("#tabela-cdr-regionais tbody").addEventListener("click", (ev) => {
  const tr = ev.target.closest("tr[data-regional]");
  if (tr) document.querySelector(`#tabela-gerencial tr[data-regional="${tr.dataset.regional}"]`)?.click();
});
document.querySelector("#tabela-cdr-ambiguas tbody").addEventListener("click", async (ev) => {
  const a = ev.target.closest("a[data-cdr-numero]");
  if (!a) return;
  ev.preventDefault();
  // abre a aba Trabalho na UF dos contatos, com a busca pelo número — as linhas aparecem com os municípios divergentes
  Object.assign(trab.filtros, { busca: a.dataset.cdrNumero, municipio: "", regional: "", setor: "", consultor: "", marca: "", status: new Set(), ocultas: true, semTelefone: false, inexistente: false, nunca: false, nuncaCdr: false, de: "", ate: "" });
  mostrarAba("trabalho");
  const uf = a.dataset.uf;
  if (uf && uf !== trab.uf) { trab.uf = uf; el.fUf.value = uf; await carregarTrabalho().catch((e) => avisar("⚠ " + e.message, true)); }
  else { preencherFiltrosEstaticos(); aplicarFiltros(); }
  if (!trab.filtradas.length) avisar("Nenhum contato com esse número nesta UF.");
});
for (const b of document.querySelectorAll("button[data-cdr-periodo]")) b.addEventListener("click", () => carregarCdr(...periodoCdr(b.dataset.cdrPeriodo)).catch((e) => avisar("⚠ " + e.message, true)));
document.getElementById("cdr-aplicar").addEventListener("click", () => {
  const de = document.getElementById("cdr-de").value, ate = document.getElementById("cdr-ate").value;
  if (!de || !ate || ate < de) return avisar("Informe um intervalo válido.", true);
  carregarCdr(de, ate).catch((e) => avisar("⚠ " + e.message, true));
});
document.getElementById("cdr-recruzar").addEventListener("click", async () => {
  try {
    const r = await postJson("/api/prospeccao/cdr/recruzar", {});
    avisar(`Cruzamento recalculado: ${inteiro(r.ligacoes)} ligações — ${inteiro(r.prospeccao)} prospecção, ${inteiro(r.ambigua)} ambíguas, ${inteiro(r.cliente)} clientes, ${inteiro(r.lead)} leads, ${inteiro(r.desconhecida)} desconhecidas (${r.ms} ms).`);
    await carregarCdr();
    if (trab.dados) { trab.dados = null; await carregarTrabalho(); }
  } catch (e) { avisar("⚠ " + e.message, true); }
});

(async () => {
  const aba = lerHash();
  let sessao = null;
  try { sessao = await chamarApi("/api/sessao"); } catch (_) { /* nav.js já redireciona */ }
  const vendedor = sessao?.papel === "vendedor";
  if (vendedor) {
    for (const b of document.querySelectorAll(".aba-btn.so-admin")) b.remove();
    if (sessao.escopo?.ufs?.length && !sessao.escopo.ufs.includes(trab.uf)) trab.uf = sessao.escopo.ufs[0];
    mostrarAba("trabalho");
  } else {
    mostrarAba(aba);
  }
  el.fUf.value = trab.uf;
  try {
    await Promise.all(vendedor ? [carregarTrabalho()] : [carregarTrabalho(), carregarCores(), carregarCobertura(), carregarGerencial(), carregarCdr()]);
  } catch (e) {
    avisar("⚠ Não foi possível carregar. (" + e.message + ")", true);
  }
})();
