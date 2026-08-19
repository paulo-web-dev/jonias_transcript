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
const GIRO_MS = Math.max(6, Number(params.get("giro")) || 45) * 1000;
const FIXO = params.get("fixo"); // dia | semana | mes
const DIA_SEMPRE = params.get("dia") === "sempre";
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

// Tendência em miniatura: discadas dos últimos 5 dias úteis
function svgSparkline(vals) {
  if (!vals || vals.length < 2) return "";
  const W = 150, H = 44, P = 7;
  const max = Math.max(...vals, 1);
  const x = (i) => P + (i * (W - 2 * P)) / (vals.length - 1);
  const y = (v) => H - P - (v / max) * (H - 2 * P);
  const u = vals.length - 1;
  return `<svg viewBox="0 0 ${W} ${H}" class="tv-spark-svg">
    <polyline points="${vals.map((v, i) => `${x(i)},${y(v)}`).join(" ")}" fill="none"
      stroke="var(--acento-2)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
    <circle cx="${x(u)}" cy="${y(vals[u])}" r="6" fill="var(--acento-2)"/></svg>`;
}

// Curva acumulada da semana × traçado ideal (45/dia até a meta na sexta)
function svgAcumulado(a) {
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
    <text x="${x(4)}" y="${y(a.metaSemana) - 12}" font-size="23" fill="var(--texto-suave)" text-anchor="end">ritmo p/ ${a.metaSemana}</text>
    ${DIAS.map((d2, i) => `<text x="${x(i)}" y="${H - 6}" font-size="22" fill="var(--texto-suave)" text-anchor="middle">${d2}</text>`).join("")}
    ${rot.map((f) => `
      <polyline points="${f.pts}" fill="none" stroke="${f.cor}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${f.vx}" cy="${f.vy}" r="9" fill="${f.cor}"/>
      <text x="${f.vx + 16}" y="${f.ry + 8}" font-size="26" font-weight="800" fill="${f.cor}">${f.nome} ${num(f.valor)}</text>`).join("")}
  </svg>`;
}

// Funil de oportunidades ativas por fase (onde está represado)
function svgFunil(fases) {
  if (!fases || !fases.length) return "";
  const W = 460, ROW = 78, PAD = 6;
  const H = fases.length * ROW + PAD * 2;
  const max = Math.max(...fases.map((f) => f.n), 1);
  return `<svg viewBox="0 0 ${W} ${H}" class="tv-chart">` + fases.map((f, i) => {
    const w = Math.max(56, (f.n / max) * (W - 16));
    const y0 = PAD + i * ROW;
    const nome = String(f.fase).replace(/^\d+_/, "");
    // contorno escuro atrás do texto claro: legível sobre a barra E sobre o fundo
    return `<rect x="${(W - w) / 2}" y="${y0}" width="${w}" height="${ROW - 16}" rx="14"
        fill="${CORES_SERIE[i % CORES_SERIE.length]}" opacity="0.9"/>
      <text x="${W / 2}" y="${y0 + (ROW - 16) / 2 + 10}" text-anchor="middle" font-size="28"
        font-weight="800" fill="#e8ecf4" stroke="#0b0e17" stroke-width="6" paint-order="stroke">${nome} · ${num(f.n)}</text>`;
  }).join("") + `</svg>`;
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

function montarLinhas(container, nomes, comSpark) {
  container.innerHTML = nomes.map((nome) => `
    <div class="tv-linha" data-nome="${nome}">
      <div class="tv-linha-topo">
        <span class="tv-linha-nome">${nome}</span>
        <span class="tv-linha-valor"><b data-campo="principal" data-v="0">0</b><i data-campo="principal-meta"></i></span>
        ${comSpark ? '<span class="tv-spark" data-campo="spark" title="discadas — últimos 5 dias úteis"></span>' : ""}
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

let visoesAtivas = [];
let visaoAtual = 0;

function aplicarVisoes(d) {
  const mostrarDia = d.dia.emCurso && (d.dia.temDadoHoje || DIA_SEMPRE);
  const novas = [];
  if (mostrarDia) novas.push("dia");
  novas.push("semana", "mes");
  const fixoValido = FIXO && novas.includes(FIXO) ? FIXO : null;
  visoesAtivas = fixoValido ? [fixoValido] : novas;
  if (visaoAtual >= visoesAtivas.length) visaoAtual = 0;
  ["dia", "semana", "mes"].forEach((v) =>
    el("visao-" + v).classList.toggle("tv-fora", !visoesAtivas.includes(v)));
  mostrarVisao(visoesAtivas[visaoAtual], true);
}

const NOMES_VISAO = { dia: "HOJE", semana: "SEMANA", mes: "MÊS" };

function mostrarVisao(nome, imediato) {
  for (const v of ["dia", "semana", "mes"]) {
    el("visao-" + v).classList.toggle("tv-ativa", v === nome);
  }
  el("tv-indicador").innerHTML = visoesAtivas
    .map((v) => `<span class="${v === nome ? "ponto-ativo" : ""}">●</span>`)
    .join(" ") + `<b>${NOMES_VISAO[nome] || ""}</b>`;
}

setInterval(() => {
  if (visoesAtivas.length < 2) return;
  visaoAtual = (visaoAtual + 1) % visoesAtivas.length;
  mostrarVisao(visoesAtivas[visaoAtual]);
}, GIRO_MS);

// ---------- Render ----------

let anterior = null; // apenas o payload anterior (substituído, nunca acumulado)
let montado = false;
let ultimaAtualizacao = null;

function montar(d) {
  montarLinhas(el("dia-linhas"), d.dia.porPessoa.map((p) => p.nome), true);
  montarLinhas(el("semana-linhas"), d.semana.porPessoa.map((p) => p.nome), false);
  el("mes-barras").innerHTML = d.mes.porPessoa.map((p) => `
    <div class="tv-gauge" data-nome="${p.nome}">
      ${svgGauge()}
      <div class="tv-gauge-nome">${p.nome}</div>
      <div class="tv-gauge-valor" data-campo="valor" data-v="0">—</div>
      <div class="tv-gauge-extra" data-campo="extra"></div>
    </div>`).join("");
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

    // Meta do DIA batida (45 ligações) também é festa — só na virada <100 → ≥100
    if (anterior.dia.data === d.dia.data) {
      for (const p of d.dia.porPessoa) {
        const antes = anterior.dia.porPessoa.find((a) => a.nome === p.nome);
        if (!antes) continue;
        if ((antes.discadas.atingimento ?? 0) < 100 && (p.discadas.atingimento ?? 0) >= 100) {
          celebrar("🏆 META BATIDA 🏆", `${p.nome} · ${num(p.discadas.valor)} ligações — meta do dia!`);
        }
      }
    }

    const mesmaSemana = anterior.semana.de === d.semana.de;
    for (const p of d.semana.porPessoa) {
      const antes = anterior.semana.porPessoa.find((a) => a.nome === p.nome);
      if (!antes) continue;
      if (JSON.stringify(antes) !== JSON.stringify(p)) mudancas.houve = true;
      const cruzou = (m) => (antes[m].atingimento ?? 0) < 100 && (p[m].atingimento ?? 0) >= 100;
      mudancas[p.nome] = {
        cruzouDiscadas: cruzou("discadas"),
        cruzouMatriculas: cruzou("matriculas"),
        mudou: JSON.stringify(antes) !== JSON.stringify(p),
      };
      if (mesmaSemana) {
        if (cruzou("discadas")) celebrar("🏆 META BATIDA 🏆", `${p.nome} · ${num(p.discadas.valor)} ligações — meta da semana!`);
        if (cruzou("leads")) celebrar("🏆 META BATIDA 🏆", `${p.nome} · ${num(p.leads.valor)} leads — meta da semana!`);
        if (cruzou("matriculas")) celebrar("🏆 META BATIDA 🏆", `${p.nome} · ${num(p.matriculas.valor)} matrículas — meta da semana!`);
      }
    }
  }
  anterior = d;

  // ---- HOJE ----
  el("dia-titulo").textContent = d.dia.emCurso
    ? `HOJE ${dataBr(d.dia.data)} — em curso, dados até ${d.dia.temDadoHoje ? horaBr(d.dia.dadosAte) : "—"}`
    : `HOJE ${dataBr(d.dia.data)}`;
  const selo = el("dia-selo");
  selo.classList.toggle("oculto", d.dia.temDadoHoje);
  if (!d.dia.temDadoHoje) selo.textContent = `SEM DADO DE HOJE — último: ${dataHoraBr(d.dia.dadosAte)}`;
  // "terça passada: 39" — o número que a equipe entende de imediato; métrica
  // sem dado na semana anterior é omitida em silêncio
  const DIAS_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  const c = d.dia.comparativo || {};
  const rotuloPassado = c.data
    ? DIAS_SEMANA[new Date(c.data + "T00:00:00").getDay()] + " passada"
    : "";
  for (const p of d.dia.porPessoa) {
    const linha = document.querySelector(`#dia-linhas [data-nome="${p.nome}"]`);
    if (!linha) continue;
    const semDados = !p.discadas.valor && !p.leads.valor && !p.matriculas.valor && !p.receitaCentavos;
    const rotulos = { adiantado: "↗ adiantado", no_ritmo: "→ no ritmo", atrasado: "↘ atrasado" };
    // Legibilidade: só o comparativo do número principal (discadas); o resto
    // do detalhe fino vive nos relatórios internos, não na tela exposta
    const sp = p.semanaPassada;
    const comparTexto = sp && c.temDiscadas
      ? ` · ${rotuloPassado}: 📞 ${num(sp.discadas)}`
      : "";
    atualizarLinha(linha, {
      semDados,
      principal: p.discadas.valor,
      meta: p.discadas.metaDia,
      pct: p.discadas.atingimento,
      status: p.discadas.estado
        ? `proj. ${num(p.discadas.projecao)} · ${rotulos[p.discadas.estado]}`
        : (p.discadas.valor ? "projeção em breve" : ""),
      statusClasse: p.discadas.estado ? "status-" + p.discadas.estado : "status-neutro",
      detalhe: `✨ ${num(p.leads.valor)} leads · 🎓 ${num(p.matriculas.valor)} matr.${comparTexto}`,
      mudou: mudancas[p.nome]?.mudou,
      cruzouMeta: mudancas[p.nome]?.cruzouDiscadas,
    });
    trocarSvg(linha.querySelector('[data-campo="spark"]'), svgSparkline(p.sparkline));
  }
  atualizarPodio(el("dia-podio"), d.dia.rankingLigacoes.map((r) => ({ nome: r.nome, valor: r.valor })), num);
  const funilHtml = svgFunil(d.funil);
  el("dia-funil").classList.toggle("oculto", !funilHtml);
  trocarSvg(document.querySelector("#dia-funil .tv-funil-corpo"), funilHtml);

  // ---- SEMANA ----
  el("semana-titulo").textContent =
    `SEMANA ${dataBr(d.semana.de)} → ${dataBr(d.semana.ate)} · dia ${d.semana.diasUteis} de 5`;
  for (const p of d.semana.porPessoa) {
    const linha = document.querySelector(`#semana-linhas [data-nome="${p.nome}"]`);
    if (!linha) continue;
    const semDados = !p.discadas.valor && !p.leads.valor && !p.matriculas.valor && !p.receitaCentavos;
    const a = p.discadas.atingimento;
    atualizarLinha(linha, {
      semDados,
      principal: p.discadas.valor,
      meta: p.discadas.meta,
      pct: a,
      status: a == null ? "" : a >= 100 ? "✓ meta" : `${a.toLocaleString("pt-BR")}%`,
      statusClasse: a == null ? "status-neutro" : a >= 100 ? "status-adiantado" : a >= 70 ? "status-no_ritmo" : "status-atrasado",
      detalhe: `✨ ${num(p.leads.valor)} / ${metaFmt(p.leads.meta)} leads · ` +
        `🎓 ${num(p.matriculas.valor)} / ${metaFmt(p.matriculas.meta)} matr.${(p.matriculas.atingimento ?? 0) >= 100 ? " ✓" : ""}`,
      mudou: mudancas[p.nome]?.mudou,
      cruzouMeta: mudancas[p.nome]?.cruzouDiscadas || mudancas[p.nome]?.cruzouMatriculas,
    });
  }
  atualizarPodio(el("podio-lig"), d.semana.rankingLigacoes, num);
  atualizarPodio(el("podio-leads"), d.semana.rankingLeads, num);
  atualizarPodio(el("podio-rec"), d.semana.rankingReceita, kReais);
  trocarSvg(el("semana-acumulado"), svgAcumulado(d.semana.acumulado));

  // ---- MÊS ----
  el("mes-titulo").textContent =
    `MÊS ${d.mes.mes.slice(5)}/${d.mes.mes.slice(0, 4)} — RECEITA × ${reais(d.mes.porPessoa[0]?.metaCentavos)} · ` +
    `${d.mes.diasUteisDecorridos} útil(eis) passados · ${d.mes.diasUteisRestantes} restantes`;
  let totalMes = 0;
  for (const p of d.mes.porPessoa) {
    totalMes += p.receitaCentavos;
    const card = document.querySelector(`#mes-barras [data-nome="${p.nome}"]`);
    if (!card) continue;
    const fracao = Math.min(1, (p.atingimento ?? 0) / 100);
    const arco = card.querySelector('[data-campo="arco"]');
    arco.setAttribute("stroke-dashoffset", ARCO_GAUGE * (1 - fracao));
    arco.setAttribute("stroke", (p.atingimento ?? 0) >= 100 ? "var(--verde)" : "var(--acento-2)");
    card.querySelector('[data-campo="pct"]').textContent =
      p.atingimento == null ? "—" : `${Math.round(p.atingimento)}%`;
    animarNumero(card.querySelector('[data-campo="valor"]'), p.receitaCentavos, kReais);
    card.querySelector('[data-campo="extra"]').textContent =
      `meta ${kReais(p.metaCentavos)} · faltam ${kReais(p.faltaCentavos)}`;
  }
  el("mes-rodape").textContent = `Equipe no mês: ${reais(totalMes)}`;
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
    try { f = JSON.parse(ev.data).fonte; } catch (_) { /* payload inesperado: toast genérico */ }
    notificarIngestao(f);
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
    celebrar("🏆 META BATIDA 🏆", "TESTE · 225 ligações — meta da semana!");
  }, 2500);
}
