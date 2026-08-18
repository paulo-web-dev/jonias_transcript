"use strict";

const ALERTA_DIAS = 7; // fonte sem dado novo há mais de X dias corridos = alerta

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t ?? "";
  return d.innerHTML;
}

async function chamarApi(url) {
  const r = await fetch(url);
  if (r.status === 401) { location.href = "/login"; throw new Error("sessão expirada"); }
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.error || `erro ${r.status}`);
  return corpo;
}

const dataHoraBr = (iso) => {
  if (!iso) return "nunca";
  const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
  return isNaN(d) ? String(iso) : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
};
const reais = (c) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format((c || 0) / 100);

function idadeDias(iso) {
  if (!iso) return Infinity;
  const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
  return isNaN(d) ? Infinity : (Date.now() - d.getTime()) / 86400000;
}

function cartaoFonte(titulo, icone, fonte) {
  const idade = idadeDias(fonte.dadosAte);
  const alerta = idade > ALERTA_DIAS;
  const estado = alerta
    ? `<span class="saude-alerta">⚠ dados parados há ${isFinite(idade) ? Math.floor(idade) + " dia(s)" : "sempre"}</span>`
    : `<span class="saude-ok">✔ atualizado</span>`;
  return `<div class="fonte-card">
    <h3>${icone} ${escapeHtml(titulo)}</h3>
    <p class="fonte-status">${estado}</p>
    <ul class="lista-simples">
      <li><span>Dados até</span><span>${dataHoraBr(fonte.dadosAte)}</span></li>
      <li><span>Última ingestão</span><span>${fonte.ultimaImportacao ? dataHoraBr(fonte.ultimaImportacao.concluido_em) : "nunca"}</span></li>
      <li><span>Registros na cópia local</span><span>${fonte.registros.toLocaleString("pt-BR")}</span></li>
    </ul>
  </div>`;
}

function preencherLista(el, itens, renderizar, vazio) {
  el.innerHTML = itens.length
    ? itens.map(renderizar).join("")
    : `<li><span class="saude-ok">✔ ${vazio}</span></li>`;
}

async function carregar() {
  let s;
  try {
    s = await chamarApi("/api/saude");
  } catch (e) {
    document.getElementById("aviso").textContent = "⚠ Não foi possível carregar. (" + e.message + ")";
    document.getElementById("aviso").classList.add("visivel");
    return;
  }
  document.getElementById("cartoes-fontes").innerHTML =
    cartaoFonte("CDR do PABX", "📞", s.fontes.cdr) +
    cartaoFonte("Oportunidades (Omie)", "🎯", s.fontes.omie) +
    cartaoFonte("Matrículas (Unyflex)", "🗄", s.fontes.mysql);

  preencherLista(document.getElementById("lista-wallets"), s.walletsSemMatch,
    (w) => `<li><span>${escapeHtml(w.wallet)}</span><span>${w.n} matrícula(s)</span></li>`,
    "todos os wallets casaram");
  preencherLista(document.getElementById("lista-vendedores"), s.vendedoresSemMatch,
    (v) => `<li><span>${escapeHtml(v.vendedor)}</span><span>${v.n} oportunidade(s)</span></li>`,
    "todos os vendedores casaram");
  preencherLista(document.getElementById("lista-sem-oportunidade"), s.matriculasEquipeSemOportunidade,
    (m) => `<li><span>${escapeHtml(m.pessoa)}</span><span>${m.n} matrícula(s)</span></li>`,
    "todas as matrículas da equipe têm oportunidade");
  preencherLista(document.getElementById("lista-conquistadas"), s.conquistadasSemMatricula,
    (o) => `<li><span>${escapeHtml(o.numero)} — ${escapeHtml(o.conta || "?")} (${escapeHtml(o.vendedor || "?")})</span>
      <span>${reais(o.ticket_centavos)} · ${dataHoraBr(o.fase_06_em)}</span></li>`,
    "toda conquistada tem matrícula");
  preencherLista(document.getElementById("lista-conflitos"), s.conflitosAtribuicao,
    (c) => `<li><span>${escapeHtml(c.aluno_nome || "matrícula #" + c.matricula_id)} — wallet
      <strong>${escapeHtml(c.wallet_pessoa)}</strong> × CRM <strong>${escapeHtml(c.oportunidade_pessoa)}</strong>
      (${escapeHtml(c.numero)})</span><span>${dataHoraBr(c.criada_em)}</span></li>`,
    "nenhum conflito de atribuição");
  document.getElementById("alunos-orfaos").textContent = s.alunosOrfaos;
}

document.getElementById("btn-sair").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});

carregar();
