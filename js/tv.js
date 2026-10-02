"use strict";

// Painel de TV 2.0 — tempo real (SSE + polling de segurança), rotação entre
// visões, contagem animada, pulso de borda + toast a cada ingestão, celebração
// de matrícula e som opcional (preferência global no banco; override por URL).
// Todos os números vêm prontos do motor SQL (/api/tv/dados); zero IA.
// Higiene para dias de tela aberta: um EventSource, três intervals fixos,
// animações por rAF com cancelamento, nós de overlay reutilizados e apenas o
// payload anterior guardado (substituído a cada refresh, nunca acumulado).

const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
// ?giro=N segundos por tela (padrão 20 desde 2026-10-01; antes 30, e 45 até 2026-09-25)
const GIRO_MS = Math.max(6, Number(params.get("giro")) || 20) * 1000;
// Cartão de destaque (falta para a meta da semana): entra ENTRE cada tela da
// rotação, com duração própria — ?destaque=N segundos (padrão 12, mín. 4)
const DESTAQUE_MS = Math.max(4, Number(params.get("destaque")) || 12) * 1000;
const FIXO = params.get("fixo"); // status | ranking | semana | receita | mes | parados3 | parados10 | destaque
// Som: o padrão vem da preferência global (configuracoes.tv_som, no payload);
// ?som=1 / ?som=0 é override por dispositivo. Silêncio é o padrão, não falha.
const SOM_OVERRIDE = params.has("som") ? params.get("som") !== "0" : null;
const VOLUME = Math.min(1, Math.max(0, Number(params.get("volume") ?? 0.5) || 0.5));
const POLLING_MS = 60000;
// Teto de segurança da celebração: um evento com mais de N matrículas novas
// atualiza os números normalmente mas NÃO comemora (lote/backfill, não venda)
const TETO_CELEBRACAO = Math.max(1, Number(params.get("teto")) || 5);

const dinheiro = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const reais = (c) => dinheiro.format((c || 0) / 100);
const kReais = (c) => {
  const v = (c || 0) / 100;
  return v >= 1000 ? `R$ ${(v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}k` : reais(c);
};
const num = (v) => (v ?? 0).toLocaleString("pt-BR");
const metaFmt = (m) => (m == null ? "—" : m.toLocaleString("pt-BR"));
const dataBr = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "—");
const horaBr = (iso) => { const m = /T(\d{2}):(\d{2})/.exec(iso || ""); return m ? `${m[1]}h${m[2]}` : ""; };
const dataHoraBr = (iso) => (iso ? `${dataBr(iso)} ${horaBr(iso)}`.trim() : "nunca");
const el = (id) => document.getElementById(id);
// Texto que vem do CRM (nome de conta) nunca entra cru no innerHTML
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- Som (WebAudio sintetizado; um som por evento, nunca em loop) ----------
// Sem overlay de desbloqueio: se o som está habilitado, tentamos armar direto
// (funciona com --autoplay-policy=no-user-gesture-required); se o navegador
// segurar, o 🔕 discreto do rodapé arma com um clique. Painel funciona igual mudo.

let audioCtx = null;
let somConfig = false; // preferência global, atualizada a cada payload

const somHabilitado = () => SOM_OVERRIDE ?? somConfig;
const somPronto = () => somHabilitado() && !!audioCtx && audioCtx.state === "running";

function atualizarIndicadorSom() {
  const ind = el("tv-som");
  ind.classList.toggle("oculto", !somHabilitado());
  ind.textContent = somPronto() ? "🔔" : "🔕";
  ind.title = somPronto() ? "som ativo" : "som ligado na configuração — toque para liberar o áudio";
}

function tentarArmarSom() {
  if (!somHabilitado()) return atualizarIndicadorSom();
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== "running") {
      audioCtx.resume().catch(() => {}).then(atualizarIndicadorSom);
      return;
    }
  } catch (_) { /* sem áudio disponível — painel segue mudo */ }
  atualizarIndicadorSom();
}

function tocarNotas(notas) {
  if (!somPronto()) return;
  const t0 = audioCtx.currentTime;
  for (const { freq, inicio, dur } of notas) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0 + inicio);
    gain.gain.linearRampToValueAtTime(0.35 * VOLUME, t0 + inicio + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + inicio + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + inicio);
    osc.stop(t0 + inicio + dur + 0.05);
  }
}

// Alerta de ingestão concluída (curto e discreto) — diferente do arpejo da
// matrícula, que continua exclusivo da celebração
const somAlerta = () => tocarNotas([
  { freq: 880, inicio: 0, dur: 0.09 },
  { freq: 1175, inicio: 0.1, dur: 0.12 },
]);
// NÍVEL FESTA (matrícula nova / meta batida): fanfarra sintetizada de ~3,5 s —
// subida, repique e acorde final. Exclusiva da celebração.
const somFesta = () => tocarNotas([
  { freq: 523, inicio: 0.0, dur: 0.16 },
  { freq: 659, inicio: 0.15, dur: 0.16 },
  { freq: 784, inicio: 0.3, dur: 0.16 },
  { freq: 1047, inicio: 0.45, dur: 0.3 },
  { freq: 784, inicio: 0.85, dur: 0.14 },
  { freq: 1047, inicio: 1.0, dur: 0.35 },
  { freq: 1319, inicio: 1.45, dur: 0.22 },
  { freq: 1047, inicio: 1.68, dur: 0.22 },
  { freq: 1319, inicio: 1.9, dur: 0.45 },
  { freq: 523, inicio: 2.5, dur: 0.95 },
  { freq: 659, inicio: 2.5, dur: 0.95 },
  { freq: 784, inicio: 2.5, dur: 0.95 },
  { freq: 1047, inicio: 2.55, dur: 1.05 },
]);

el("tv-som").addEventListener("click", tentarArmarSom);

// ---------- Pulso de borda (aviso visual de dado novo — não depende de som) ----------

function pulsarBorda() {
  const borda = el("tv-borda-pulso");
  borda.classList.remove("pulsando");
  void borda.offsetWidth; // reinicia a animação CSS
  borda.classList.add("pulsando");
}

// ---------- Contagem animada (rAF com cancelamento por elemento) ----------

function animarNumero(elemento, para, formatar) {
  const de = Number(elemento.dataset.v ?? para);
  elemento.dataset.v = para;
  if (elemento._anim) cancelAnimationFrame(elemento._anim);
  if (de === para) { elemento.textContent = formatar(para); return; }
  const t0 = performance.now();
  const DURACAO = 800;
  const passo = (t) => {
    const f = Math.min(1, (t - t0) / DURACAO);
    const suave = 1 - Math.pow(1 - f, 3);
    elemento.textContent = formatar(Math.round(de + (para - de) * suave));
    if (f < 1) elemento._anim = requestAnimationFrame(passo);
    else elemento._anim = null;
  };
  elemento._anim = requestAnimationFrame(passo);
}

function brilhar(elemento, classe = "tv-glow") {
  if (!elemento) return;
  elemento.classList.remove(classe);
  void elemento.offsetWidth; // reinicia a animação CSS
  elemento.classList.add(classe);
}

// ---------- Gráficos em SVG puro (desenhados aqui — sem CDN externo) ----------
// Regra: legível a 4 metros — poucos elementos, traço grosso, rótulo grande.

const CORES_SERIE = ["var(--acento-2)", "var(--verde)", "var(--amarelo)", "var(--acento)"];

// Curva acumulada da semana × traçado ideal (pipeline: meta diária até a
// meta fechada na sexta). `fmt` formata os valores (R$ compacto).
function svgAcumulado(a, fmt = num) {
  if (!a || !a.metaSemana || !a.porPessoa.length || !a.porPessoa[0].valores.length) return "";
  const W = 780, H = 210, PL = 18, PR = 190, PT = 30, PB = 34;
  const maxY = Math.max(a.metaSemana, ...a.porPessoa.map((p) => p.valores[p.valores.length - 1] || 0)) * 1.06;
  const x = (i) => PL + (i * (W - PL - PR)) / 4;
  const y = (v) => H - PB - (v / maxY) * (H - PT - PB);
  const ideal = Array.from({ length: 5 }, (_, i) => `${x(i)},${y(a.metaDia * (i + 1))}`).join(" ");
  const fins = a.porPessoa.map((p, i) => ({
    nome: p.nome,
    cor: CORES_SERIE[i % CORES_SERIE.length],
    valor: p.valores[p.valores.length - 1],
    vx: x(p.valores.length - 1),
    vy: y(p.valores[p.valores.length - 1]),
    pts: p.valores.map((v, j) => `${x(j)},${y(v)}`).join(" "),
  }));
  // anti-colisão vertical dos rótulos de fim de linha
  const rot = fins.map((f) => ({ ...f, ry: f.vy })).sort((m, n) => m.ry - n.ry);
  for (let i = 1; i < rot.length; i++) if (rot[i].ry - rot[i - 1].ry < 30) rot[i].ry = rot[i - 1].ry + 30;
  const DIAS = ["seg", "ter", "qua", "qui", "sex"];
  return `<svg viewBox="0 0 ${W} ${H}" class="tv-chart">
    <polyline points="${ideal}" fill="none" stroke="var(--texto-suave)" stroke-width="4" stroke-dasharray="12 10" opacity="0.85"/>
    <text x="${x(4)}" y="${y(a.metaSemana) - 12}" font-size="23" fill="var(--texto-suave)" text-anchor="end">ritmo p/ ${fmt(a.metaSemana)}</text>
    ${DIAS.map((d2, i) => `<text x="${x(i)}" y="${H - 6}" font-size="22" fill="var(--texto-suave)" text-anchor="middle">${d2}</text>`).join("")}
    ${rot.map((f) => `
      <polyline points="${f.pts}" fill="none" stroke="${f.cor}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${f.vx}" cy="${f.vy}" r="9" fill="${f.cor}"/>
      <text x="${f.vx + 16}" y="${f.ry + 8}" font-size="26" font-weight="800" fill="${f.cor}">${f.nome} ${fmt(f.valor)}</text>`).join("")}
  </svg>`;
}

// Gauge semicircular da receita do mês × meta — lê melhor de longe que barra fina
const ARCO_GAUGE = Math.PI * 78;
function svgGauge() {
  const arco = "M 22 100 A 78 78 0 0 1 178 100";
  return `<svg viewBox="0 0 200 112" class="tv-gauge-svg">
    <path d="${arco}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="17" stroke-linecap="round"/>
    <path d="${arco}" fill="none" stroke="var(--acento-2)" stroke-width="17" stroke-linecap="round"
      stroke-dasharray="${ARCO_GAUGE}" stroke-dashoffset="${ARCO_GAUGE}" data-campo="arco"
      style="transition: stroke-dashoffset 0.8s ease, stroke 0.8s ease"/>
    <text x="100" y="96" text-anchor="middle" font-size="34" font-weight="800" fill="var(--texto)" data-campo="pct">—</text>
  </svg>`;
}

// ---------- Linhas por consultor (barra longa + detalhe subordinado) ----------

function montarLinhas(container, nomes) {
  container.innerHTML = nomes.map((nome) => `
    <div class="tv-linha" data-nome="${nome}">
      <div class="tv-linha-topo">
        <span class="tv-linha-nome">${nome}</span>
        <span class="tv-linha-valor"><b data-campo="principal" data-v="0">0</b><i data-campo="principal-meta"></i></span>
        <span class="tv-linha-status" data-campo="status"></span>
      </div>
      <div class="tv-trilha"><div class="tv-fill" data-campo="barra"></div></div>
      <div class="tv-linha-detalhe" data-campo="detalhe"></div>
    </div>`).join("");
}

// innerHTML só quando o SVG mudou — evita flicker no refresh
function trocarSvg(alvo, html) {
  if (!alvo) return;
  if (alvo.dataset.h !== html) {
    alvo.innerHTML = html;
    alvo.dataset.h = html;
  }
}

function atualizarLinha(linha, dados) {
  // dados: {principal, meta, pct, status, statusClasse, detalhe, semDados}
  linha.classList.toggle("tv-sem-dados", !!dados.semDados);
  const principal = linha.querySelector('[data-campo="principal"]');
  if (dados.semDados) {
    principal.textContent = "—";
    principal.dataset.v = 0;
    linha.querySelector('[data-campo="principal-meta"]').textContent = "";
    linha.querySelector('[data-campo="status"]').textContent = "sem dados";
    linha.querySelector('[data-campo="status"]').className = "tv-linha-status status-neutro";
    linha.querySelector('[data-campo="barra"]').style.width = "0%";
    linha.querySelector('[data-campo="detalhe"]').textContent = "";
    return;
  }
  animarNumero(principal, dados.principal, dados.formatar || num);
  linha.querySelector('[data-campo="principal-meta"]').textContent = dados.meta != null ? ` / ${dados.meta}` : "";
  const status = linha.querySelector('[data-campo="status"]');
  status.textContent = dados.status || "";
  status.className = "tv-linha-status " + (dados.statusClasse || "");
  const barra = linha.querySelector('[data-campo="barra"]');
  barra.style.width = Math.min(100, dados.pct ?? 0) + "%";
  barra.classList.toggle("fill-ok", (dados.pct ?? 0) >= 100);
  linha.querySelector('[data-campo="detalhe"]').textContent = dados.detalhe || "";
  if (dados.cruzouMeta) brilhar(linha, "tv-glow-meta");
  else if (dados.mudou) brilhar(linha);
}

// ---------- Pódio ----------

function atualizarPodio(podioEl, itens, formatar) {
  const blocos = podioEl.querySelector(".tv-podio-blocos");
  const top = itens.slice(0, 3);
  const ordem = [top[1], top[0], top[2]]; // 2º, 1º, 3º
  const alturas = ["podio-2", "podio-1", "podio-3"];
  const medalhas = ["🥈", "👑", "🥉"];
  const html = ordem.map((item, i) => item ? `
    <div class="tv-podio-bloco ${alturas[i]}">
      <span class="tv-podio-medalha">${medalhas[i]}</span>
      <span class="tv-podio-nome">${item.nome}</span>
      <span class="tv-podio-valor">${formatar(item.valor)}</span>
    </div>` : `<div class="tv-podio-bloco ${alturas[i]} tv-podio-vazio"></div>`).join("");
  if (blocos.dataset.html !== html) {
    const lideresAntes = blocos.dataset.lider;
    blocos.innerHTML = html;
    blocos.dataset.html = html;
    if (top[0] && lideresAntes && lideresAntes !== top[0].nome) brilhar(podioEl, "tv-glow-meta");
    blocos.dataset.lider = top[0]?.nome || "";
  }
}

// ---------- Celebração NÍVEL FESTA (fila; nó único reutilizado) ----------
// Matrícula nova e meta batida: capivara + confete + fanfarra, ~6 s.
// Ingestão comum fica no nível discreto (pulso de borda + toast), sem festa.

const filaCelebracao = [];
let celebrando = false;

function celebrar(titulo, info) {
  filaCelebracao.push({ titulo, info });
  if (!celebrando) proximaCelebracao();
}

function proximaCelebracao() {
  const festa = filaCelebracao.shift();
  if (!festa) { celebrando = false; return; }
  celebrando = true;
  el("celebracao-titulo").textContent = festa.titulo;
  el("celebracao-info").textContent = festa.info;
  const confetes = el("confetes");
  confetes.innerHTML = Array.from({ length: 60 }, (_, i) =>
    `<i style="left:${(i * 53) % 100}%;animation-delay:${(i % 12) * 0.11}s;background:hsl(${(i * 47) % 360},90%,60%)"></i>`).join("");
  el("celebracao").classList.remove("oculto");
  somFesta();
  setTimeout(() => {
    el("celebracao").classList.add("oculto");
    confetes.innerHTML = "";
    setTimeout(proximaCelebracao, 600);
  }, 6000);
}

// ---------- Rotação entre visões ----------

const VISOES = ["status", "ranking", "destaque", "semana", "receita", "mes", "parados3", "parados10"];
let receitaAvisada = false;
let visoesAtivas = [];
let visaoAtual = 0;
let destaqueAvisado = false;
const foraAvisadas = new Set(); // log no console uma vez por motivo de saída
function avisarFora(visao, motivo) {
  if (foraAvisadas.has(visao)) return;
  foraAvisadas.add(visao);
  console.log(`[tv] tela ${visao} fora da rotação: ${motivo}`);
}

function aplicarVisoes(d) {
  // O cartão só entra com meta da semana cadastrada (painel /metas)
  const temDestaque = d.semana.equipe.receita?.metaCentavos != null;
  if (!temDestaque && !destaqueAvisado) {
    destaqueAvisado = true;
    console.log("[tv] cartão 'falta para a meta da semana' fora da rotação: meta da equipe (semana) não cadastrada em /metas");
  }
  // RECEITA DA SEMANA (% e falta por vendedor) só entra com meta de receita
  // semanal cadastrada para alguém do painel (receita_semana, painel /metas)
  const temReceita = d.semana.porPessoa.some((p) => p.receita?.meta != null);
  if (!temReceita && !receitaAvisada) {
    receitaAvisada = true;
    console.log("[tv] visão RECEITA DA SEMANA fora da rotação: nenhuma meta de receita semanal (receita_semana) cadastrada em /metas");
  }
  const telas = [];
  // STATUS: sai sem rota hoje E sem meta de pipeline para ninguém
  if (d.status?.ativo) { telas.push("status"); foraAvisadas.delete("status"); }
  else avisarFora("status", "nenhuma rota hoje e nenhuma meta de pipeline vigente");
  // RANKING: sai enquanto ninguém do painel vendeu na semana
  if (d.premio?.ativo) { telas.push("ranking"); foraAvisadas.delete("ranking"); }
  else avisarFora("ranking", "nenhuma venda (matrícula) do painel na semana");
  telas.push("semana");
  if (temReceita) telas.push("receita");
  telas.push("mes");
  // Leads parados: cada faixa só entra com alguém nela (tela vazia sai da rotação)
  for (const [visao, faixa] of [["parados3", "amarela"], ["parados10", "vermelha"]]) {
    if (d.parados?.faixas[faixa]?.total) { telas.push(visao); foraAvisadas.delete(visao); }
    else avisarFora(visao, `nenhuma oportunidade ativa na faixa ${faixa}`);
  }
  // destaque intercalado: STATUS → cartão → RANKING → cartão → SEMANA → cartão → …
  const novas = temDestaque ? telas.flatMap((t) => [t, "destaque"]) : telas;
  const fixoValido = FIXO && novas.includes(FIXO) ? FIXO : null;
  const telaAntes = visoesAtivas[visaoAtual];
  visoesAtivas = fixoValido ? [fixoValido] : novas;
  // Pausado por navegação manual: o refresh não pode trocar a tela que a
  // pessoa escolheu (se ela saiu da rotação, cai na primeira)
  if (pausadoAte && telaAntes) visaoAtual = Math.max(0, visoesAtivas.indexOf(telaAntes));
  if (visaoAtual >= visoesAtivas.length) visaoAtual = 0;
  VISOES.forEach((v) => el("visao-" + v).classList.toggle("tv-fora", !visoesAtivas.includes(v)));
  mostrarVisao(visoesAtivas[visaoAtual]);
}

const NOMES_VISAO = { status: "STATUS", ranking: "RANKING DE VENDAS", semana: "SEMANA", receita: "RECEITA DA SEMANA", mes: "MÊS", destaque: "META DA SEMANA", parados3: "PARADOS 3–9 DIAS", parados10: "URGENTE — PARADOS 10+ DIAS" };

function mostrarVisao(nome) {
  if (nome === "parados3" || nome === "parados10") ajustarCards(nome);
  for (const v of VISOES) el("visao-" + v).classList.toggle("tv-ativa", v === nome);
  // Pontos = só as telas (o cartão intercalado não ganha ponto próprio)
  const pontos = [...new Set(visoesAtivas.filter((v) => v !== "destaque"))];
  el("tv-indicador").innerHTML = pontos
    .map((v) => `<span class="${v === nome ? "ponto-ativo" : ""}">●</span>`)
    .join(" ") + `<b>${NOMES_VISAO[nome] || ""}</b>`;
}

// Giro com duração por tela (cadeia de timeouts: o cartão fica menos tempo)
let giroTimer = null;
function agendarGiro() {
  clearTimeout(giroTimer);
  if (pausadoAte) return; // navegação manual: quem retoma é retomarGiro()
  const duracao = visoesAtivas[visaoAtual] === "destaque" ? DESTAQUE_MS : GIRO_MS;
  giroTimer = setTimeout(() => {
    if (visoesAtivas.length >= 2) {
      visaoAtual = (visaoAtual + 1) % visoesAtivas.length;
      mostrarVisao(visoesAtivas[visaoAtual]);
    }
    agendarGiro();
  }, duracao);
}

// ---------- Navegação manual (setas na tela e ← → no teclado) ----------
// Anda uma TELA por vez entre as que estão na rotação agora (tela fora por
// falta de dado continua fora; o cartão intercalado da meta é pulado) e pausa
// a rotação por PAUSA_MS; ela volta sozinha, a partir da tela em que parou.
// Sem ninguém tocar, nada disto roda. Com ?fixo= não há para onde navegar.
const PAUSA_MS = 60000;
const SETAS_VISIVEIS_MS = 3500;
let pausadoAte = 0;
let retomarTimer = null;
let contagemTimer = null;
let setasTimer = null;

function navegar(passo) {
  if (FIXO) return;
  const telas = visoesAtivas.filter((v) => v !== "destaque");
  if (telas.length < 2) return;
  // No cartão, "a tela atual" é a que veio antes dele na rotação
  let atual = visoesAtivas[visaoAtual];
  if (atual === "destaque") atual = visoesAtivas[(visaoAtual - 1 + visoesAtivas.length) % visoesAtivas.length];
  const i = telas.indexOf(atual);
  const proxima = telas[((i < 0 ? 0 : i) + passo + telas.length) % telas.length];
  visaoAtual = visoesAtivas.indexOf(proxima);
  mostrarVisao(proxima);
  pausar();
}

function pausar() {
  pausadoAte = Date.now() + PAUSA_MS;
  clearTimeout(giroTimer);
  clearTimeout(retomarTimer);
  retomarTimer = setTimeout(retomarGiro, PAUSA_MS);
  if (!contagemTimer) contagemTimer = setInterval(atualizarPausa, 1000);
  atualizarPausa();
}

function retomarGiro() {
  pausadoAte = 0;
  clearTimeout(retomarTimer);
  clearInterval(contagemTimer);
  contagemTimer = null;
  atualizarPausa();
  agendarGiro(); // a tela atual ganha o tempo inteiro antes de girar
}

function atualizarPausa() {
  const pill = el("tv-pausa");
  pill.classList.toggle("oculto", !pausadoAte);
  if (!pausadoAte) return;
  const s = Math.max(0, Math.ceil((pausadoAte - Date.now()) / 1000));
  pill.textContent = `⏸ rotação pausada · volta em ${s} s · ▶ retomar`;
}

function mostrarSetas() {
  if (FIXO || visoesAtivas.filter((v) => v !== "destaque").length < 2) return;
  document.body.classList.add("tv-nav-visivel");
  clearTimeout(setasTimer);
  setasTimer = setTimeout(() => document.body.classList.remove("tv-nav-visivel"), SETAS_VISIVEIS_MS);
}

el("tv-nav-anterior").addEventListener("click", () => { navegar(-1); mostrarSetas(); });
el("tv-nav-proxima").addEventListener("click", () => { navegar(1); mostrarSetas(); });
el("tv-pausa").addEventListener("click", retomarGiro);
document.addEventListener("mousemove", mostrarSetas);
document.addEventListener("touchstart", mostrarSetas, { passive: true });
document.addEventListener("keydown", (ev) => {
  // ← → (e PageUp/PageDown, de passadores de slide); Esc retoma na hora
  if (ev.key === "ArrowRight" || ev.key === "PageDown") { ev.preventDefault(); navegar(1); }
  else if (ev.key === "ArrowLeft" || ev.key === "PageUp") { ev.preventDefault(); navegar(-1); }
  else if (ev.key === "Escape" && pausadoAte) retomarGiro();
});

agendarGiro();

// ---------- STATUS (quem está em dia hoje) ----------
// ROTA = rota de HOJE (% feitas ÷ itens; rota curta fecha com o que recebeu).
// PIPELINE = semana ("bateu N de M dias"; ✓ quando o acumulado cobre a meta
// diária × dias até hoje — o dia em curso não reprova). Nada de qualidade do
// pipeline aqui: ticket zero/retroativo/concentração ficam nas telas internas.
const CLASSE_ESTADO = { ok: "st-ok", pendente: "st-pendente", fora: "st-fora", sem_rota: "st-neutro", sem_meta: "st-neutro" };
const diasTxt = (n) => `${num(n)} dia${n === 1 ? "" : "s"}`;

function blocoRotaStatus(r) {
  if (!r.hoje) {
    return `<div class="tv-st-bloco st-neutro">
      <div class="tv-st-topo"><span class="tv-st-valor">—</span></div>
      <div class="tv-st-sub">sem rota hoje</div></div>`;
  }
  const h = r.hoje;
  const ok = h.feitas >= h.itens;
  const estado = ok ? "st-ok" : r.diasPerdidos ? "st-fora" : "st-pendente";
  // Rota curta: a cota dele é o tamanho da rota — explícito, senão parece que fez menos
  const curta = h.curta ? ` · <span class="tv-st-curta">rota curta: recebeu ${num(h.itens)} (estoque acabou)</span>` : "";
  const semana = r.diasAvaliados
    ? ` · <span class="${r.diasPerdidos ? "st-txt-fora" : ""}">semana: 100% em ${num(r.diasOk)} de ${diasTxt(r.diasAvaliados)}</span>` : "";
  return `<div class="tv-st-bloco ${estado}">
    <div class="tv-st-topo"><span class="tv-st-valor">${num(h.pct)}%${ok ? " ✓" : ""}</span>
      <div class="tv-trilha"><div class="tv-fill${ok ? " fill-ok" : ""}" style="width:${Math.min(100, h.pct)}%"></div></div></div>
    <div class="tv-st-sub">${num(h.feitas)} de ${num(h.itens)} feitas${curta}${semana}</div></div>`;
}

function blocoPipelineStatus(p) {
  if (p.metaDia == null) {
    return `<div class="tv-st-bloco st-neutro">
      <div class="tv-st-topo"><span class="tv-st-valor">${kReais(p.valor)}</span></div>
      <div class="tv-st-sub">sem meta de pipeline</div></div>`;
  }
  const dias = p.dias || { batidos: 0, avaliados: 0 };
  const principal = dias.avaliados
    ? `${num(dias.batidos)} de ${diasTxt(dias.avaliados)}`
    : `${kReais(p.hojeCentavos)} hoje`;
  const situacao = p.estado === "ok" ? "✓ acumulado na meta"
    : p.estado === "pendente" ? `hoje faltam ${kReais(p.faltaCentavos)}`
    : `faltam ${kReais(p.faltaCentavos)}`;
  return `<div class="tv-st-bloco ${CLASSE_ESTADO[p.estado]}">
    <div class="tv-st-topo"><span class="tv-st-valor">${principal}</span><span class="tv-st-situacao">${situacao}</span></div>
    <div class="tv-st-sub">semana ${kReais(p.valor)} de ${kReais(p.metaAteHoje)} até hoje · hoje ${kReais(p.hojeCentavos)} de ${kReais(p.metaDia)}</div></div>`;
}

function renderizarStatus(st) {
  if (!st) return;
  el("status-titulo").textContent = `STATUS DE HOJE ${dataBr(st.data)} — QUEM ESTÁ EM DIA · dia ${num(st.diaDaSemana)} de 5`;
  const alvo = el("status-linhas");
  alvo.classList.toggle("tv-st-compacto", st.porPessoa.length > 6);
  const html = `<div class="tv-st-linha tv-st-cabecalho"><span></span><span>🗺 ROTA DE HOJE</span>` +
    `<span>📈 PIPELINE — DIAS NA META DA SEMANA</span><span></span></div>` +
    st.porPessoa.map((x) => `
    <div class="tv-st-linha${x.emDia ? " tv-st-emdia" : ""}" data-nome="${esc(x.nome)}">
      <div class="tv-st-nome">${esc(x.nome)}</div>
      ${blocoRotaStatus(x.rota)}
      ${blocoPipelineStatus(x.pipeline)}
      <div class="tv-st-selo">${x.emDia ? "✓ EM DIA" : ""}</div>
    </div>`).join("");
  if (alvo.dataset.h !== html) { alvo.innerHTML = html; alvo.dataset.h = html; }
  const legenda = "EM DIA = rota de hoje 100% e pipeline da semana na meta (meta diária × dias até hoje) · o dia em curso nunca reprova";
  if (el("status-legenda").textContent !== legenda) el("status-legenda").textContent = legenda;
}

// ---------- RANKING DE VENDAS (prêmio da semana) ----------
// Pódio pela receita de matrículas da semana. Rota e pipeline são
// PRÉ-REQUISITO: quem está fora vê exatamente por quê ("rota 100% em 3 de 4
// dias", "pipeline: faltam R$ X").
function linhasPremio(x) {
  const r = x.rota, p = x.pipeline;
  const linhas = [];
  if (r.estado === "sem_rota") linhas.push(`<li class="st-neutro">🗺 Rota: sem rota na semana</li>`);
  else if (r.estado === "fora") linhas.push(`<li class="st-fora">✗ Rota: 100% em só ${num(r.diasOk)} de ${diasTxt(r.diasAvaliados)}</li>`);
  else if (r.estado === "pendente") linhas.push(`<li class="st-pendente">🗺 Rota ✓ ${r.diasAvaliados ? `${num(r.diasOk)} de ${diasTxt(r.diasAvaliados)} · ` : ""}hoje em ${num(r.hoje?.pct ?? 0)}%</li>`);
  else linhas.push(`<li class="st-ok">✓ Rota 100% em ${num(r.diasOk)} de ${diasTxt(r.diasAvaliados)}</li>`);
  if (p.estado === "sem_meta") linhas.push(`<li class="st-neutro">📈 Pipeline: sem meta</li>`);
  else if (p.estado === "fora") linhas.push(`<li class="st-fora">✗ Pipeline: ${kReais(p.valor)} de ${kReais(p.metaAteHoje)} — faltam ${kReais(p.faltaCentavos)}</li>`);
  else if (p.estado === "pendente") linhas.push(`<li class="st-pendente">📈 Pipeline ✓ até ontem · hoje faltam ${kReais(p.faltaCentavos)}</li>`);
  else linhas.push(`<li class="st-ok">✓ Pipeline ${kReais(p.valor)} de ${kReais(p.metaAteHoje)}</li>`);
  return linhas.join("");
}

function renderizarPremio(pr) {
  if (!pr) return;
  el("ranking-titulo").textContent = `RANKING DE VENDAS DA SEMANA ${dataBr(pr.semanaDe)} · dia ${num(pr.diaDaSemana)} de 5`;
  const top = pr.ranking.slice(0, 3);
  const ordem = [top[1], top[0], top[2]]; // 2º, 1º, 3º
  const alturas = ["podio-2", "podio-1", "podio-3"];
  const medalhas = ["🥈", "🥇", "🥉"];
  const html = ordem.map((x, i) => !x ? `<div class="tv-pr-bloco ${alturas[i]} tv-podio-vazio"></div>` : `
    <div class="tv-pr-bloco ${alturas[i]}${x.qualificado ? "" : " tv-pr-fora"}${pr.vencedor?.nome === x.nome ? " tv-pr-vencedor-bloco" : ""}">
      <div class="tv-pr-medalha">${medalhas[i]}</div>
      <div class="tv-pr-nome">${esc(x.nome)}</div>
      <div class="tv-pr-valor">${kReais(x.receitaCentavos)}</div>
      <div class="tv-pr-matr">${num(x.matriculas)} matrícula${x.matriculas === 1 ? "" : "s"}</div>
      ${x.qualificado ? "" : `<div class="tv-pr-fora-selo">FORA DO PRÊMIO</div>`}
      <ul class="tv-pr-requisitos">${linhasPremio(x)}</ul>
    </div>`).join("");
  const podio = el("ranking-podio");
  if (podio.dataset.h !== html) { podio.innerHTML = html; podio.dataset.h = html; }
  const v = pr.vencedor;
  const lider = pr.ranking[0];
  const texto = v
    ? `🏆 Se a semana fechasse agora, o prêmio iria para <b>${esc(v.nome)}</b> — ${v.posicao}º em vendas · ${kReais(v.receitaCentavos)}` +
      (lider && lider.nome !== v.nome ? ` <span class="st-txt-fora">(${esc(lider.nome)} lidera em vendas, mas está fora dos pré-requisitos)</span>` : "")
    : `Ninguém com venda na semana cumpre rota e pipeline ainda — o prêmio está em aberto`;
  if (el("ranking-vencedor").innerHTML !== texto) el("ranking-vencedor").innerHTML = texto;
}

// ---------- Render ----------

let anterior = null; // apenas o payload anterior (substituído, nunca acumulado)
const brilharStatus = new Set();
let montado = false;
let ultimaAtualizacao = null;

function montar(d) {
  montarLinhas(el("semana-linhas"), d.semana.porPessoa.map((p) => p.nome));
  montarLinhas(el("receita-linhas"), d.semana.porPessoa.map((p) => p.nome));
  el("receita-linhas").classList.toggle("tv-linhas-compactas", d.semana.porPessoa.length > 5);
  el("mes-barras").innerHTML = d.mes.porPessoa.map((p) => `
    <div class="tv-gauge" data-nome="${p.nome}">
      ${svgGauge()}
      <div class="tv-gauge-nome">${p.nome}</div>
      <div class="tv-gauge-valor" data-campo="valor" data-v="0">—</div>
      <div class="tv-gauge-extra" data-campo="extra"></div>
      <div class="tv-gauge-mensal" data-campo="mensal"></div>
    </div>`).join("") + (d.mes.gerencial ? `
    <div class="tv-gauge tv-gauge-canal" data-nome="Gerencial">
      <div class="tv-gauge-nome">Gerencial</div>
      <div class="tv-gauge-valor" data-campo="valor" data-v="0">—</div>
      <div class="tv-gauge-extra" data-campo="extra">carteira gerencial · sem meta</div>
    </div>` : "");
  montado = true;
}

function renderizar(d, origem) {
  somConfig = !!d.som;
  tentarArmarSom();
  if (!montado) montar(d);
  aplicarVisoes(d);

  // Frescor + indicadores
  const fontes = { cdr: "📞", omie: "🎯", mysql: "🗄" };
  for (const [chave, icone] of Object.entries(fontes)) {
    const f = d.frescor[chave];
    const alvo = el("tv-frescor").querySelector(`[data-fonte="${chave}"]`);
    alvo.textContent = `${icone} ${dataHoraBr(f.dadosAte)} ${f.atrasada ? "⚠" : "✔"}`;
    alvo.classList.toggle("tv-atrasada", f.atrasada);
  }
  ultimaAtualizacao = new Date(d.atualizadoEm);
  relogio();

  // ---- Diff para animação/som/celebração (só com payload anterior) ----
  const mudancas = { houve: false };
  if (anterior) {
    // Celebração: SÓ matrícula com criada_em de HOJE (delta do painel do dia —
    // backfill/histórico muda semana e mês sem virar confete), com teto de
    // segurança contra lotes.
    const candidatas = [];
    let novasHoje = 0;
    for (const p of d.dia.porPessoa) {
      const antes = anterior.dia.porPessoa.find((a) => a.nome === p.nome);
      if (!antes || anterior.dia.data !== d.dia.data) continue; // virada de dia: sem base de comparação
      const delta = p.matriculas.valor - antes.matriculas.valor;
      if (delta > 0) {
        novasHoje += delta;
        const deltaReceita = p.receitaCentavos - antes.receitaCentavos;
        candidatas.push(`${p.nome} · +${delta} matrícula${delta > 1 ? "s" : ""}` +
          (deltaReceita > 0 ? ` · +${reais(deltaReceita)}` : ""));
      }
    }
    if (novasHoje > 0 && novasHoje <= TETO_CELEBRACAO) {
      candidatas.forEach((info) => celebrar("🎉 MATRÍCULA NOVA 🎉", info));
    } else if (novasHoje > TETO_CELEBRACAO) {
      console.log(`[tv] celebração suprimida: ${novasHoje} matrículas novas de hoje num único evento (teto ${TETO_CELEBRACAO}) — números atualizados normalmente`);
    }

    const mesmaSemana = anterior.semana.de === d.semana.de;
    for (const p of d.semana.porPessoa) {
      const antes = anterior.semana.porPessoa.find((a) => a.nome === p.nome);
      if (!antes) continue;
      if (JSON.stringify(antes) !== JSON.stringify(p)) mudancas.houve = true;
      const cruzou = (m) => ((antes[m]?.atingimento ?? 0) < 100) && ((p[m]?.atingimento ?? 0) >= 100);
      mudancas[p.nome] = {
        cruzouPipeline: cruzou("pipeline"),
        cruzouMatriculas: cruzou("matriculas"),
        cruzouReceita: cruzou("receita"),
        mudou: JSON.stringify(antes) !== JSON.stringify(p),
        mudouReceita: JSON.stringify(antes.receita) !== JSON.stringify(p.receita),
      };
      if (mesmaSemana) {
        if (cruzou("pipeline")) celebrar("🏆 META BATIDA 🏆", `${p.nome} · ${reais(p.pipeline.valor)} de pipeline — meta da semana!`);
        if (cruzou("matriculas")) celebrar("🏆 META BATIDA 🏆", `${p.nome} · ${num(p.matriculas.valor)} matrículas — meta da semana!`);
        if (cruzou("receita")) celebrar("🏆 META BATIDA 🏆", `${p.nome} · ${reais(p.receita.valor)} — meta de receita da semana!`);
      }
    }
  }
  // STATUS: virar "EM DIA" (rota de hoje 100% + pipeline na meta) é festa; a
  // rota fechada em 100% também — se as duas viradas vêm juntas, uma festa só
  if (anterior?.status && d.status && anterior.status.data === d.status.data) {
    for (const x of d.status.porPessoa) {
      const antes = anterior.status.porPessoa.find((a) => a.nome === x.nome);
      if (!antes) continue;
      const fechouRota = x.rota.hoje && (antes.rota.hoje?.pct ?? 0) < 100 && x.rota.hoje.pct >= 100;
      if (!antes.emDia && x.emDia) {
        celebrar("✅ EM DIA ✅", `${x.nome} · rota de hoje 100% e pipeline da semana na meta!`);
      } else if (fechouRota) {
        celebrar("🏆 ROTA CONCLUÍDA 🏆", `${x.nome} · ${num(x.rota.hoje.feitas)} de ${num(x.rota.hoje.itens)} da rota — 100%!`);
      }
      if (!antes.emDia && x.emDia || fechouRota) brilharStatus.add(x.nome);
    }
  }
  anterior = d;
  renderizarStatus(d.status);
  renderizarPremio(d.premio);
  for (const nome of brilharStatus) brilhar(document.querySelector(`#status-linhas [data-nome="${CSS.escape(nome)}"]`), "tv-glow-meta");
  brilharStatus.clear();

  // ---- SEMANA ----
  el("semana-titulo").textContent =
    `SEMANA ${dataBr(d.semana.de)} → ${dataBr(d.semana.ate)} · PIPELINE × META · dia ${d.semana.diasUteis} de 5`;
  for (const p of d.semana.porPessoa) {
    const linha = document.querySelector(`#semana-linhas [data-nome="${p.nome}"]`);
    if (!linha) continue;
    const pip = p.pipeline || { valor: 0, meta: null, atingimento: null };
    const rota = p.rota;
    const semDados = !pip.valor && !rota?.itens && !p.matriculas.valor && !p.receitaCentavos;
    const a = pip.atingimento;
    const dias = pip.dias;
    const rotaTxt = !rota || !rota.itens ? "🗺 sem rota"
      : `🗺 rota 100% em ${num(rota.diasOk)} de ${diasTxt(rota.diasAvaliados)}${rota.diasPerdidos ? " ✗" : ""}`;
    atualizarLinha(linha, {
      semDados,
      principal: pip.valor,
      formatar: kReais,
      meta: pip.meta != null ? kReais(pip.meta) : null,
      pct: a,
      status: dias && dias.avaliados ? `📈 ${num(dias.batidos)} de ${diasTxt(dias.avaliados)} na meta` : a == null ? "" : `${Math.round(a)}%`,
      statusClasse: a == null ? "status-neutro" : a >= 100 ? "status-adiantado" : a >= 70 ? "status-no_ritmo" : "status-atrasado",
      detalhe: `${rotaTxt} · 🎓 ${num(p.matriculas.valor)} / ${metaFmt(p.matriculas.meta)} matr.${(p.matriculas.atingimento ?? 0) >= 100 ? " ✓" : ""}`,
      mudou: mudancas[p.nome]?.mudou,
      cruzouMeta: mudancas[p.nome]?.cruzouPipeline || mudancas[p.nome]?.cruzouMatriculas,
    });
  }
  atualizarPodio(el("podio-lig"), d.semana.rankingPipeline, kReais);
  atualizarPodio(el("podio-leads"), d.semana.rankingRota, num);
  atualizarPodio(el("podio-rec"), d.semana.rankingReceita, kReais);
  trocarSvg(el("semana-acumulado"), svgAcumulado(d.semana.acumulado, kReais));

  // ---- RECEITA DA SEMANA: % atingido e falta para a meta semanal de cada
  // vendedor (receita_semana própria ou padrão; número grande, barra longa) ----
  {
    const metas = d.semana.porPessoa.map((p) => p.receita?.meta).filter((m) => m != null);
    const todasIguais = metas.length && metas.every((m) => m === metas[0]);
    el("receita-titulo").textContent =
      `RECEITA DA SEMANA · ${todasIguais ? `meta ${reais(metas[0])} por vendedor` : "meta própria por vendedor"}` +
      ` · dia ${d.semana.diasUteis} de 5`;
    for (const p of d.semana.porPessoa) {
      const linha = document.querySelector(`#receita-linhas [data-nome="${p.nome}"]`);
      if (!linha || !p.receita) continue;
      const r = p.receita;
      const a = r.atingimento;
      const semMeta = r.meta == null;
      atualizarLinha(linha, {
        semDados: false,
        principal: r.valor,
        formatar: reais,
        meta: semMeta ? null : reais(r.meta),
        pct: a,
        status: semMeta ? "sem meta" : a >= 100 ? "✓ meta" : `${Math.round(a)}%`,
        statusClasse: semMeta || !r.valor ? "status-neutro"
          : a >= 100 ? "status-adiantado" : a >= 70 ? "status-no_ritmo" : "status-atrasado",
        detalhe: semMeta ? "meta de receita semanal não cadastrada"
          : a >= 100 ? `✓ ${reais(r.valor - r.meta)} acima da meta` : `faltam ${reais(r.faltaCentavos)}`,
        mudou: mudancas[p.nome]?.mudouReceita,
        cruzouMeta: mudancas[p.nome]?.cruzouReceita,
      });
    }
  }

  // ---- MÊS ----
  // Metas de receita podem ser por pessoa (painel /metas): o título não cita
  // um valor único; cada gauge traz a sua
  el("mes-titulo").textContent =
    `MÊS ${d.mes.mes.slice(5)}/${d.mes.mes.slice(0, 4)} — RECEITA × META INDIVIDUAL · ` +
    `${d.mes.diasUteisDecorridos} útil(eis) passados · ${d.mes.diasUteisRestantes} restantes`;
  for (const p of d.mes.porPessoa) {
    const card = document.querySelector(`#mes-barras [data-nome="${p.nome}"]`);
    if (!card) continue;
    const fracao = Math.min(1, (p.atingimento ?? 0) / 100);
    const arco = card.querySelector('[data-campo="arco"]');
    arco.setAttribute("stroke-dashoffset", ARCO_GAUGE * (1 - fracao));
    arco.setAttribute("stroke", (p.atingimento ?? 0) >= 100 ? "var(--verde)" : "var(--acento-2)");
    card.querySelector('[data-campo="pct"]').textContent =
      p.atingimento == null ? "—" : `${Math.round(p.atingimento)}%`;
    animarNumero(card.querySelector('[data-campo="valor"]'), p.receitaCentavos, kReais);
    card.querySelector('[data-campo="extra"]').textContent = p.metaCentavos
      ? `meta ${kReais(p.metaCentavos)} · faltam ${kReais(p.faltaCentavos)}`
      : "sem meta de receita";
    // Metas do MÊS: ligações/matrículas mensais cadastradas e o pipeline
    // (meta diária × dias úteis do mês) — só o que tiver meta
    const mensal = [["📞", p.discadas, num], ["📈", p.pipeline, kReais], ["🎓", p.matriculas, num]]
      .filter(([, m]) => m && m.meta != null)
      .map(([ic, m, f]) => `<span class="${(m.atingimento ?? 0) >= 100 ? "ok" : ""}">${ic} ${f(m.valor)}/${f(m.meta)}</span>`)
      .join(" · ");
    const alvoMensal = card.querySelector('[data-campo="mensal"]');
    if (alvoMensal && alvoMensal.dataset.h !== mensal) { alvoMensal.innerHTML = mensal; alvoMensal.dataset.h = mensal; }
  }
  if (d.mes.gerencial) {
    const card = document.querySelector('#mes-barras [data-nome="Gerencial"]');
    if (card) {
      animarNumero(card.querySelector('[data-campo="valor"]'), d.mes.gerencial.receitaCentavos, kReais);
      card.querySelector('[data-campo="extra"]').textContent =
        `carteira gerencial · ${num(d.mes.gerencial.matriculas)} matr. · sem meta`;
    }
  }
  const eqMes = d.mes.equipe;
  el("mes-rodape").textContent = eqMes.metaCentavos
    ? `Equipe no mês: ${reais(eqMes.receitaCentavos)} de ${reais(eqMes.metaCentavos)} (${Math.round(eqMes.atingimento)}%)` +
      (eqMes.incluiGerencial ? " · inclui Gerencial" : "")
    : `Equipe no mês: ${reais(eqMes.receitaCentavos)}` + (eqMes.incluiGerencial ? " · inclui Gerencial" : "");

  renderParados(d.parados);

  // ---- DESTAQUE: falta para a meta da SEMANA (equipe, R$) ----
  const eq = d.semana.equipe.receita;
  if (eq && eq.metaCentavos != null) {
    const bateu = eq.receitaCentavos >= eq.metaCentavos;
    const valorEl = el("destaque-valor");
    el("destaque-titulo").textContent = bateu ? "🏆 META DA SEMANA BATIDA 🏆" : "FALTA PARA A META DA SEMANA";
    animarNumero(valorEl, bateu ? eq.receitaCentavos - eq.metaCentavos : eq.faltaCentavos,
      (v) => (bateu ? "+" : "") + reais(v));
    valorEl.classList.toggle("tv-destaque-ok", bateu);
    const barra = el("destaque-barra");
    barra.style.width = Math.min(100, eq.atingimento ?? 0) + "%";
    barra.classList.toggle("fill-ok", bateu);
    el("destaque-linha").textContent =
      `${reais(eq.receitaCentavos)} de ${reais(eq.metaCentavos)} · ${Math.round(eq.atingimento ?? 0)}% · dia ${d.semana.diasUteis} de 5`;
    el("destaque-rodape").textContent = eqMes.metaCentavos
      ? `Mês: ${reais(eqMes.receitaCentavos)} de ${reais(eqMes.metaCentavos)} · faltam ${reais(eqMes.faltaCentavos)}` +
        (eq.incluiGerencial ? " · inclui Gerencial" : "")
      : (eq.incluiGerencial ? "inclui a carteira Gerencial" : "");
    // (`anterior` já é o payload atual aqui — o cartão guarda o seu próprio)
    if (destaqueAnterior && destaqueAnterior.de === d.semana.de) {
      if ((destaqueAnterior.atingimento ?? 0) < 100 && (eq.atingimento ?? 0) >= 100) brilhar(el("visao-destaque"), "tv-glow-meta");
      else if (destaqueAnterior.receitaCentavos !== eq.receitaCentavos) brilhar(el("visao-destaque"));
    }
    destaqueAnterior = { de: d.semana.de, atingimento: eq.atingimento, receitaCentavos: eq.receitaCentavos };
  }
}
let destaqueAnterior = null;

// ---------- Leads parados no funil (kanban por vendedor) ----------
// O placar (contagem por vendedor, em tipografia grande) é o principal; os 5
// cards mais antigos são ilustração. Zero é mérito: "0 ✓" em verde. "≥ N dias"
// = sem data de entrada na fase no Omie, contado desde a última atualização
// (piso: nunca superestima).
const dataHoraLocal = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
};
const diasFmt = (dias, piso) => `${piso ? "≥ " : ""}${num(dias)} dia${dias === 1 ? "" : "s"}`;

// Card que não cabe INTEIRO na coluna sai e entra na conta "+ N outros" (o
// número na tela é sempre exato). Refeito ao mostrar a tela e no resize: com
// a tela fora da rotação (display: none) não há o que medir.
function ajustarCards(visao) {
  for (const coluna of el(visao + "-kanban").querySelectorAll(".tv-kb-coluna")) {
    const caixa = coluna.querySelector(".tv-kb-cards");
    const outrosEl = coluna.querySelector(".tv-kb-outros");
    if (!caixa || !outrosEl) continue;
    const cards = [...caixa.children];
    cards.forEach((c) => { c.hidden = false; });
    const limite = caixa.getBoundingClientRect().bottom + 1;
    let ocultos = 0;
    for (const c of cards) {
      if (ocultos || c.getBoundingClientRect().bottom > limite) { c.hidden = true; ocultos++; }
    }
    const n = Number(outrosEl.dataset.base) + ocultos;
    outrosEl.textContent = n > 0 ? `+ ${num(n)} outro${n === 1 ? "" : "s"}` : "";
  }
}
window.addEventListener("resize", () => { ajustarCards("parados3"); ajustarCards("parados10"); });

function renderParados(p) {
  if (!p) return;
  for (const [visao, faixa] of [["parados3", "amarela"], ["parados10", "vermelha"]]) {
    const f = p.faixas[faixa];
    const kanban = el(visao + "-kanban");
    kanban.style.setProperty("--colunas", f.colunas.length);
    const html = f.colunas.map((c) => {
      if (!c.total) {
        return `<div class="tv-kb-coluna tv-kb-zero" data-nome="${esc(c.nome)}">
          <div class="tv-kb-nome">${esc(c.nome)}</div>
          <div class="tv-kb-total">0 <span>✓</span></div>
          <div class="tv-kb-antigo">nenhum parado nesta faixa</div>
        </div>`;
      }
      const outros = c.total - c.cards.length;
      return `<div class="tv-kb-coluna" data-nome="${esc(c.nome)}">
        <div class="tv-kb-nome">${esc(c.nome)}</div>
        <div class="tv-kb-total">${num(c.total)} <small>parado${c.total === 1 ? "" : "s"}</small></div>
        <div class="tv-kb-antigo">mais antigo: <b>${diasFmt(c.maisAntigo.dias, c.maisAntigo.piso)}</b></div>
        <div class="tv-kb-cards">${c.cards.map((k) => `
          <div class="tv-kb-card">
            <div class="tv-kb-conta">${esc(k.conta || k.numero)}</div>
            <div class="tv-kb-meta"><b>${diasFmt(k.dias, k.piso)}</b> · ${esc(k.fase)} · ${k.ticketCentavos ? kReais(k.ticketCentavos) : "sem ticket"}</div>
          </div>`).join("")}
        </div>
        <div class="tv-kb-outros" data-base="${outros}"></div>
      </div>`;
    }).join("");
    if (kanban.dataset.h !== html) { kanban.innerHTML = html; kanban.dataset.h = html; }

    // Aviso de dado defasado: a exportação do Omie é um retrato de uma janela
    // recente — o que não veio no último arquivo pode ter mudado de fase no CRM
    const u = p.ultimaImportacao;
    const partes = [];
    if (u) {
      partes.push(f.foraDoUltimoArquivo
        ? `<span class="tv-parados-alerta">⚠ ${num(f.foraDoUltimoArquivo)} de ${num(f.total)} não vieram na última importação do Omie (${dataHoraLocal(u.concluidoEm)}) — podem ter mudado de fase no CRM</span>`
        : `✔ todos vieram na última importação do Omie (${dataHoraLocal(u.concluidoEm)})`);
    }
    if (f.comPiso) partes.push(`≥ = sem data de fase no Omie, contado desde a última atualização (${num(f.comPiso)})`);
    const aviso = partes.join(" · ");
    const alvo = el(visao + "-aviso");
    if (alvo.dataset.h !== aviso) { alvo.innerHTML = aviso; alvo.dataset.h = aviso; }
    ajustarCards(visao); // por último: o aviso também ocupa altura
  }
}

// ---------- Relógio / status ----------

function relogio(erro) {
  const alvo = el("tv-relogio");
  if (!ultimaAtualizacao) { alvo.textContent = erro || "carregando…"; return; }
  const hora = ultimaAtualizacao.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  alvo.textContent = erro ? `${erro} — dados de ${hora}` : `atualizado às ${hora}`;
}
setInterval(() => relogio(), 60000);

// ---------- Busca de dados (SSE = push; polling = rede de segurança) ----------

let buscando = false;

async function atualizar(origem) {
  if (buscando) return;
  buscando = true;
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), 15000);
  try {
    const r = await fetch(`/api/tv/dados?token=${encodeURIComponent(token)}`, { signal: controle.signal });
    if (!r.ok) { relogio(r.status === 401 ? "token inválido" : "painel indisponível"); return; }
    renderizar(await r.json(), origem);
  } catch (_) {
    relogio("sem conexão");
  } finally {
    clearTimeout(timer);
    buscando = false;
  }
}

// Aviso de ingestão concluída (só push/SSE; polling continua mudo): som de
// alerta + toast com a fonte. Vários eventos juntos = um som só e um toast
// acumulando as fontes.
const ROTULOS_FONTE = { cdr: "CDR atualizado", oportunidades: "Omie atualizado", mysql: "Unyflex sincronizado" };
const fontesPendentes = new Set();
let toastTimer = null;
let alertaSuprimidoAte = 0;

function notificarIngestao(fonte) {
  fontesPendentes.add(fonte);
  const agora = performance.now();
  if (agora >= alertaSuprimidoAte) {
    alertaSuprimidoAte = agora + 3000;
    pulsarBorda(); // aviso principal é visual; o som (se armado) reforça
    somAlerta();
  }
  const toast = el("tv-toast");
  toast.textContent = [...fontesPendentes]
    .map((f) => ROTULOS_FONTE[f] || "Dados atualizados").join(" · ");
  toast.classList.add("tv-toast-visivel");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("tv-toast-visivel");
    fontesPendentes.clear();
    toastTimer = null;
  }, 4500);
}

function conectarSse() {
  const fonte = new EventSource(`/api/tv/eventos?token=${encodeURIComponent(token)}`);
  fonte.onopen = () => { el("tv-push").textContent = "⚡"; el("tv-push").title = "tempo real conectado"; };
  fonte.onerror = () => { el("tv-push").textContent = "⏱"; el("tv-push").title = "reconectando — polling ativo"; };
  fonte.onmessage = (ev) => {
    let f = null;
    let tipo = "dados";
    try { ({ fonte: f = null, tipo = "dados" } = JSON.parse(ev.data)); } catch (_) { /* payload inesperado: toast genérico */ }
    // "config" (metas/configuração mudaram): só refaz o fetch, sem pulso/toast
    if (tipo !== "config") notificarIngestao(f);
    atualizar("sse");
  };
  return fonte; // EventSource reconecta sozinho; mantemos uma única instância
}

atualizar("inicial");
conectarSse();
setInterval(() => atualizar("polling"), POLLING_MS);

// Modo de teste da festa: ?festa=demo dispara uma matrícula e uma meta de
// exemplo ao carregar — capivara, confete e som sem esperar venda real
if (params.get("festa") === "demo") {
  setTimeout(() => {
    celebrar("🎉 MATRÍCULA NOVA 🎉", "TESTE · +1 matrícula · +R$ 2.980");
    celebrar("✅ EM DIA ✅", "TESTE · rota de hoje 100% e pipeline da semana na meta!");
  }, 2500);
}
