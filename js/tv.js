"use strict";

// Painel de TV 2.0 — tempo real (SSE + polling de segurança), rotação entre
// visões, contagem animada, celebração de matrícula e som com desbloqueio.
// Todos os números vêm prontos do motor SQL (/api/tv/dados); zero IA.
// Higiene para dias de tela aberta: um EventSource, três intervals fixos,
// animações por rAF com cancelamento, nós de overlay reutilizados e apenas o
// payload anterior guardado (substituído a cada refresh, nunca acumulado).

const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const GIRO_MS = Math.max(6, Number(params.get("giro")) || 20) * 1000;
const FIXO = params.get("fixo"); // dia | semana | mes
const DIA_SEMPRE = params.get("dia") === "sempre";
const SOM_ATIVO = params.get("som") !== "0";
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
const dataBr = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "—");
const horaBr = (iso) => { const m = /T(\d{2}):(\d{2})/.exec(iso || ""); return m ? `${m[1]}h${m[2]}` : ""; };
const dataHoraBr = (iso) => (iso ? `${dataBr(iso)} ${horaBr(iso)}`.trim() : "nunca");
const el = (id) => document.getElementById(id);

// ---------- Som (WebAudio sintetizado; um som por evento, nunca em loop) ----------

let audioCtx = null;

function armarSom() {
  if (!SOM_ATIVO || audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
    el("tv-som").textContent = "🔔";
    el("tv-som").title = "som armado";
  } catch (_) { /* sem áudio disponível */ }
  el("audio-overlay").classList.add("oculto");
}

function tocarNotas(notas) {
  if (!audioCtx || audioCtx.state !== "running") return;
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
const somMatricula = () => tocarNotas([
  { freq: 523, inicio: 0, dur: 0.15 },
  { freq: 659, inicio: 0.14, dur: 0.15 },
  { freq: 784, inicio: 0.28, dur: 0.15 },
  { freq: 1047, inicio: 0.42, dur: 0.45 },
]);

if (SOM_ATIVO) {
  document.addEventListener("pointerdown", armarSom, { once: true });
  setTimeout(() => el("audio-overlay").classList.add("oculto"), 20000);
} else {
  el("audio-overlay").classList.add("oculto");
  el("tv-som").classList.add("oculto");
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

// ---------- Linhas por consultor (barra longa + detalhe subordinado) ----------

function montarLinhas(container, nomes, comRitmo) {
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

// ---------- Celebração (fila; nó único reutilizado) ----------

const filaCelebracao = [];
let celebrando = false;

function celebrar(texto) {
  filaCelebracao.push(texto);
  if (!celebrando) proximaCelebracao();
}

function proximaCelebracao() {
  const texto = filaCelebracao.shift();
  if (!texto) { celebrando = false; return; }
  celebrando = true;
  el("celebracao-info").textContent = texto;
  const confetes = el("confetes");
  confetes.innerHTML = Array.from({ length: 40 }, (_, i) =>
    `<i style="left:${(i * 53) % 100}%;animation-delay:${(i % 10) * 0.12}s;background:hsl(${(i * 47) % 360},90%,60%)"></i>`).join("");
  el("celebracao").classList.remove("oculto");
  somMatricula();
  setTimeout(() => {
    el("celebracao").classList.add("oculto");
    confetes.innerHTML = "";
    setTimeout(proximaCelebracao, 600);
  }, 5000);
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
    <div class="tv-barra-mes" data-nome="${p.nome}">
      <span class="tv-barra-mes-nome">${p.nome}</span>
      <div class="tv-trilha tv-trilha-grande"><div class="tv-fill" data-campo="barra"></div></div>
      <span class="tv-barra-mes-valor" data-campo="valor" data-v="0">—</span>
      <span class="tv-barra-mes-extra" data-campo="extra"></span>
    </div>`).join("");
  montado = true;
}

function renderizar(d, origem) {
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
    if (novasHoje > 0 && novasHoje <= TETO_CELEBRACAO) candidatas.forEach(celebrar);
    else if (novasHoje > TETO_CELEBRACAO) {
      console.log(`[tv] celebração suprimida: ${novasHoje} matrículas novas de hoje num único evento (teto ${TETO_CELEBRACAO}) — números atualizados normalmente`);
    }

    for (const p of d.semana.porPessoa) {
      const antes = anterior.semana.porPessoa.find((a) => a.nome === p.nome);
      if (!antes) continue;
      if (JSON.stringify(antes) !== JSON.stringify(p)) mudancas.houve = true;
      mudancas[p.nome] = {
        cruzouDiscadas: (antes.discadas.atingimento ?? 0) < 100 && (p.discadas.atingimento ?? 0) >= 100,
        cruzouMatriculas: (antes.matriculas.atingimento ?? 0) < 100 && (p.matriculas.atingimento ?? 0) >= 100,
        mudou: JSON.stringify(antes) !== JSON.stringify(p),
      };
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
    const sp = p.semanaPassada;
    const partesPassado = [];
    if (sp && c.temDiscadas) partesPassado.push(`📞 ${num(sp.discadas)}`);
    if (sp && c.temLeads) partesPassado.push(`✨ ${num(sp.leads)}`);
    if (sp && c.temMatriculas) partesPassado.push(`🎓 ${num(sp.matriculas)}`);
    const comparTexto = partesPassado.length
      ? ` · ${rotuloPassado}: ${partesPassado.join(" ")}`
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
      detalhe: `✅ ${num(p.atendidas)} atend. (${p.taxaAtendimento ?? "—"}%) · ✨ ${num(p.leads.valor)} leads · ` +
        `🎓 ${num(p.matriculas.valor)} matr. · 💰 ${kReais(p.receitaCentavos)}${comparTexto}`,
      mudou: mudancas[p.nome]?.mudou,
      cruzouMeta: mudancas[p.nome]?.cruzouDiscadas,
    });
  }
  atualizarPodio(el("dia-podio"), d.dia.rankingLigacoes.map((r) => ({ nome: r.nome, valor: r.valor })), num);

  // ---- SEMANA ----
  el("semana-titulo").textContent =
    `SEMANA ${dataBr(d.semana.de)} → ${dataBr(d.semana.ate)} · ${d.semana.diasUteis} dia(s) útil(eis)`;
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
      detalhe: `✨ ${num(p.leads.valor)}/${p.leads.meta ?? "—"} leads · ` +
        `🎓 ${num(p.matriculas.valor)}/${p.matriculas.meta ?? "—"} matr.${(p.matriculas.atingimento ?? 0) >= 100 ? " ✓" : ""} · ` +
        `💰 ${kReais(p.receitaCentavos)} · taxa ${p.taxaAtendimento ?? "—"}%`,
      mudou: mudancas[p.nome]?.mudou,
      cruzouMeta: mudancas[p.nome]?.cruzouDiscadas || mudancas[p.nome]?.cruzouMatriculas,
    });
  }
  atualizarPodio(el("podio-lig"), d.semana.rankingLigacoes, num);
  atualizarPodio(el("podio-leads"), d.semana.rankingLeads, num);
  atualizarPodio(el("podio-rec"), d.semana.rankingReceita, kReais);

  // ---- MÊS ----
  el("mes-titulo").textContent =
    `MÊS ${d.mes.mes.slice(5)}/${d.mes.mes.slice(0, 4)} — RECEITA × ${reais(d.mes.porPessoa[0]?.metaCentavos)} · ` +
    `${d.mes.diasUteisDecorridos} útil(eis) passados · ${d.mes.diasUteisRestantes} restantes`;
  let totalMes = 0;
  for (const p of d.mes.porPessoa) {
    totalMes += p.receitaCentavos;
    const linha = document.querySelector(`#mes-barras [data-nome="${p.nome}"]`);
    if (!linha) continue;
    const barra = linha.querySelector('[data-campo="barra"]');
    barra.style.width = Math.min(100, p.atingimento ?? 0) + "%";
    barra.classList.toggle("fill-ok", (p.atingimento ?? 0) >= 100);
    animarNumero(linha.querySelector('[data-campo="valor"]'), p.receitaCentavos, kReais);
    linha.querySelector('[data-campo="extra"]').textContent =
      `${p.atingimento ?? "—"}% · faltam ${kReais(p.faltaCentavos)}`;
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
    somAlerta();
    alertaSuprimidoAte = agora + 3000;
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
