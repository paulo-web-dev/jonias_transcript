"use strict";

// Dashboard de TV — somente leitura, sem interação, aberto por dias.
// Todos os números vêm prontos do motor SQL (/api/tv/dados); zero IA.
// Render sem piscar: o esqueleto do DOM é construído UMA vez (na primeira
// resposta) e cada refresh só troca textos, classes e larguras de barra.

const REFRESH_MS = 60000;
const token = new URLSearchParams(location.search).get("token") || "";
// Rotação opcional para TVs menores: ?giro=15 (segundos por painel)
const giroSeg = Number(new URLSearchParams(location.search).get("giro")) || 0;

const dinheiro = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const reais = (c) => dinheiro.format((c || 0) / 100);
const num = (v) => (v ?? 0).toLocaleString("pt-BR");
const dataBr = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "—");
const horaBr = (iso) => {
  if (!iso) return "";
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  return m ? `${m[1]}h${m[2]}` : "";
};
const dataHoraBr = (iso) => (iso ? `${dataBr(iso)} ${horaBr(iso)}`.trim() : "nunca");

let montado = false;
let ultimaAtualizacao = null;

// ---------- Montagem (uma vez) ----------

function montarCardPessoa(container, nomes, comRitmo) {
  container.innerHTML = nomes
    .map(
      (nome) => `
    <div class="tv-pessoa" data-nome="${nome}">
      <div class="tv-pessoa-nome">${nome}</div>
      <div class="tv-pessoa-principal">
        <span class="tv-num" data-campo="discadas">—</span>
        <span class="tv-meta-sub" data-campo="discadas-meta">de —</span>
        ${comRitmo ? '<span class="tv-ritmo" data-campo="ritmo"></span>' : '<span class="tv-pct" data-campo="discadas-pct">—</span>'}
      </div>
      <div class="tv-pessoa-linhas">
        <span>✅ <b data-campo="atendidas">—</b> atend. (<b data-campo="taxa">—</b>)</span>
        <span>✨ <b data-campo="leads">—</b> leads <i data-campo="leads-meta"></i></span>
        <span>🎓 <b data-campo="matriculas">—</b> matr. <i data-campo="matriculas-meta"></i></span>
        <span>💰 <b data-campo="receita">—</b></span>
      </div>
    </div>`
    )
    .join("");
}

function montarBarrasMes(container, nomes) {
  container.innerHTML = nomes
    .map(
      (nome) => `
    <div class="tv-barra-linha" data-nome="${nome}">
      <span class="tv-barra-nome">${nome}</span>
      <div class="tv-barra-trilha"><div class="tv-barra-fill" data-campo="fill"></div></div>
      <span class="tv-barra-info" data-campo="info">—</span>
    </div>`
    )
    .join("");
}

function montar(d) {
  const nomes = d.semana.porPessoa.map((p) => p.nome);
  montarCardPessoa(document.getElementById("dia-pessoas"), nomes, true);
  montarCardPessoa(document.getElementById("semana-pessoas"), nomes, false);
  montarBarrasMes(document.getElementById("mes-barras"), d.mes.porPessoa.map((p) => p.nome));
  montado = true;

  if (giroSeg > 0) {
    document.body.classList.add("tv-giro");
    const paineis = [...document.querySelectorAll(".tv-painel")];
    let atual = 0;
    paineis.forEach((p, i) => p.classList.toggle("tv-ativo", i === 0));
    setInterval(() => {
      paineis[atual].classList.remove("tv-ativo");
      atual = (atual + 1) % paineis.length;
      paineis[atual].classList.add("tv-ativo");
    }, giroSeg * 1000);
  }
}

// ---------- Atualização em lugar (sem piscar) ----------

const setTexto = (raiz, campo, texto) => {
  const el = raiz.querySelector(`[data-campo="${campo}"]`);
  if (el && el.textContent !== String(texto)) el.textContent = texto;
};

function atualizarPessoaDia(card, p) {
  setTexto(card, "discadas", num(p.discadas.valor));
  setTexto(card, "discadas-meta", `de ${p.discadas.metaDia ?? "—"}`);
  const ritmoEl = card.querySelector('[data-campo="ritmo"]');
  if (p.discadas.estado) {
    const setas = { adiantado: "↗", no_ritmo: "→", atrasado: "↘" };
    const rotulos = { adiantado: "adiantado", no_ritmo: "no ritmo", atrasado: "atrasado" };
    ritmoEl.textContent = `${setas[p.discadas.estado]} proj. ${num(p.discadas.projecao)} — ${rotulos[p.discadas.estado]}`;
    ritmoEl.className = `tv-ritmo ritmo-${p.discadas.estado}`;
  } else {
    ritmoEl.textContent = p.discadas.valor > 0 ? "projeção em breve" : "";
    ritmoEl.className = "tv-ritmo";
  }
  setTexto(card, "atendidas", num(p.atendidas));
  setTexto(card, "taxa", p.taxaAtendimento == null ? "—" : p.taxaAtendimento + "%");
  setTexto(card, "leads", num(p.leads.valor));
  setTexto(card, "leads-meta", `/ ${p.leads.metaDia ?? "—"}`);
  setTexto(card, "matriculas", num(p.matriculas.valor));
  setTexto(card, "matriculas-meta", `/ ${p.matriculas.metaDia ?? "—"}`);
  setTexto(card, "receita", reais(p.receitaCentavos));
}

function atualizarPessoaSemana(card, p) {
  setTexto(card, "discadas", num(p.discadas.valor));
  setTexto(card, "discadas-meta", `de ${p.discadas.meta ?? "—"}`);
  const pctEl = card.querySelector('[data-campo="discadas-pct"]');
  const a = p.discadas.atingimento;
  pctEl.textContent = a == null ? "" : a.toLocaleString("pt-BR") + "%";
  pctEl.className = "tv-pct " + (a == null ? "" : a >= 100 ? "pct-ok" : a >= 70 ? "pct-meio" : "pct-baixo");
  setTexto(card, "atendidas", num(p.atendidas));
  setTexto(card, "taxa", p.taxaAtendimento == null ? "—" : p.taxaAtendimento + "%");
  setTexto(card, "leads", num(p.leads.valor));
  setTexto(card, "leads-meta", `/ ${p.leads.meta ?? "—"} (${p.leads.atingimento ?? "—"}%)`);
  setTexto(card, "matriculas", num(p.matriculas.valor));
  setTexto(card, "matriculas-meta", `/ ${p.matriculas.meta ?? "—"} (${p.matriculas.atingimento ?? "—"}%)`);
  setTexto(card, "receita", reais(p.receitaCentavos));
}

function atualizarRanking(id, itens, formatar) {
  const ol = document.getElementById(id);
  const linhas = itens.map((i) => `<li><span>${i.nome}</span><strong>${formatar(i.valor)}</strong></li>`).join("");
  if (ol.dataset.html !== linhas) {
    ol.innerHTML = linhas;
    ol.dataset.html = linhas;
  }
}

function atualizarFrescor(f, atualizadoEm) {
  const raiz = document.getElementById("tv-frescor");
  const fontes = { cdr: "📞 CDR", omie: "🎯 Omie", mysql: "🗄 Unyflex" };
  for (const [chave, rotulo] of Object.entries(fontes)) {
    const el = raiz.querySelector(`[data-fonte="${chave}"]`);
    const fonte = f[chave];
    el.textContent = `${rotulo} até ${dataHoraBr(fonte.dadosAte)} ${fonte.atrasada ? "⚠" : "✔"}`;
    el.classList.toggle("tv-atrasada", fonte.atrasada);
  }
  ultimaAtualizacao = new Date(atualizadoEm);
  relogio();
}

function relogio(erro) {
  const el = document.getElementById("tv-relogio");
  if (!ultimaAtualizacao) { el.textContent = erro || "carregando…"; return; }
  const hora = ultimaAtualizacao.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  el.textContent = erro ? `${erro} — dados de ${hora}` : `atualizado às ${hora}`;
}

function renderizar(d) {
  if (!montado) montar(d);
  atualizarFrescor(d.frescor, d.atualizadoEm);

  // Dia
  const painelDia = document.getElementById("painel-dia");
  document.getElementById("dia-titulo").textContent = d.dia.emCurso
    ? `HOJE ${dataBr(d.dia.data)} — em curso, dados até ${d.dia.temDadoHoje ? horaBr(d.dia.dadosAte) : "—"}`
    : `HOJE ${dataBr(d.dia.data)} (fim de semana)`;
  const selo = document.getElementById("dia-selo");
  selo.classList.toggle("oculto", d.dia.temDadoHoje);
  if (!d.dia.temDadoHoje) selo.textContent = `SEM DADO DE HOJE — último: ${dataHoraBr(d.dia.dadosAte)}`;
  painelDia.classList.toggle("tv-esmaecido", !d.dia.temDadoHoje);
  for (const p of d.dia.porPessoa) {
    const card = document.querySelector(`#dia-pessoas [data-nome="${p.nome}"]`);
    if (card) atualizarPessoaDia(card, p);
  }
  atualizarRanking("dia-rank-lig", d.dia.rankingLigacoes, num);
  atualizarRanking("dia-rank-mat", d.dia.rankingMatriculas, num);

  // Semana
  document.getElementById("semana-titulo").textContent =
    `SEMANA ${dataBr(d.semana.de)} → ${dataBr(d.semana.ate)} · ${d.semana.diasUteis} dia(s) útil(eis)`;
  for (const p of d.semana.porPessoa) {
    const card = document.querySelector(`#semana-pessoas [data-nome="${p.nome}"]`);
    if (card) atualizarPessoaSemana(card, p);
  }
  atualizarRanking("sem-rank-lig", d.semana.rankingLigacoes, num);
  atualizarRanking("sem-rank-leads", d.semana.rankingLeads, num);
  atualizarRanking("sem-rank-rec", d.semana.rankingReceita, reais);

  // Mês
  document.getElementById("mes-titulo").textContent =
    `MÊS ${d.mes.mes.slice(5)}/${d.mes.mes.slice(0, 4)} — RECEITA × META · ` +
    `${d.mes.diasUteisDecorridos} útil(eis) passados · ${d.mes.diasUteisRestantes} restantes`;
  for (const p of d.mes.porPessoa) {
    const linha = document.querySelector(`#mes-barras [data-nome="${p.nome}"]`);
    if (!linha) continue;
    const pctVal = Math.min(100, p.atingimento ?? 0);
    linha.querySelector('[data-campo="fill"]').style.width = pctVal + "%";
    setTexto(linha, "info",
      `${reais(p.receitaCentavos)} · ${p.atingimento ?? "—"}% · faltam ${reais(p.faltaCentavos)}`);
  }
}

// ---------- Ciclo (um único intervalo; falha mantém números anteriores) ----------

async function atualizar() {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), 15000);
  try {
    const r = await fetch(`/api/tv/dados?token=${encodeURIComponent(token)}`, { signal: controle.signal });
    if (!r.ok) { relogio(r.status === 401 ? "token inválido" : "painel indisponível"); return; }
    renderizar(await r.json());
  } catch (_) {
    relogio("sem conexão");
  } finally {
    clearTimeout(timer);
  }
}

atualizar();
setInterval(atualizar, REFRESH_MS);
