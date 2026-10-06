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
  renderizarBackup(s.backup);
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
  carregarSemTicket();
}

// Backup: último (data, tamanho, contatos, verificação), alerta com mais de
// 48 h ou falha, e os backups mantidos pela retenção
const tamanho = (b) => (b == null ? "—" : b >= 1048576 ? `${(b / 1048576).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB` : `${Math.round(b / 1024)} KB`);
function renderizarBackup(bk) {
  const alvo = document.getElementById("backup-conteudo");
  if (!bk) { alvo.innerHTML = `<p class="texto-suave">Sem informação de backup.</p>`; return; }
  const u = bk.ultimoOk;
  const estado = bk.alerta
    ? `<span class="saude-alerta">⚠ ${escapeHtml(bk.alerta)}</span>`
    : `<span class="saude-ok">✔ backup em dia</span>`;
  const falha = bk.ultimo && !bk.ultimo.ok
    ? `<li><span class="saude-alerta">Última tentativa (${dataHoraBr(bk.ultimo.criadoEm)}) falhou</span><span>${escapeHtml(bk.ultimo.erro || "")}</span></li>` : "";
  alvo.innerHTML = `<p class="fonte-status">${estado}${bk.emAndamento ? ' <span class="texto-suave">· backup em andamento…</span>' : ""}</p>
    <ul class="lista-simples">
      ${falha}
      <li><span>Último backup verificado</span><span>${u ? `${dataHoraBr(u.criadoEm)} <span class="texto-suave">(há ${Math.floor(bk.idadeHoras)} h · ${escapeHtml(u.motivo)})</span>` : "nenhum"}</span></li>
      ${u ? `<li><span>Tamanho</span><span>${tamanho(u.bytes)}</span></li>
      <li><span>Contatos de prospecção no backup</span><span>${(u.contatos ?? 0).toLocaleString("pt-BR")}</span></li>
      <li><span>Verificação (integrity_check)</span><span>${u.integridade === "ok" ? '<span class="saude-ok">✔ ok</span>' : `<span class="saude-alerta">${escapeHtml(u.integridade || "—")}</span>`} · user_version ${u.userVersion ?? "—"}</span></li>
      <li><span>Arquivo</span><span><code>${escapeHtml(u.arquivo)}</code></span></li>` : ""}
      <li><span>Diretório</span><span style="text-align:right;min-width:0"><code style="white-space:normal;word-break:break-all">${escapeHtml(bk.diretorio)}</code></span></li>
    </ul>
    ${bk.backups.length ? `<details><summary>${bk.backups.length} backup(s) mantido(s)</summary><ul class="lista-simples">${bk.backups.map((b) =>
      `<li><span>${dataHoraBr(b.criadoEm)} <span class="texto-suave">${b.tipo}${b.motivo === "manual" ? " · manual" : ""}</span></span>
       <span>${b.ok ? '<span class="saude-ok">✔</span>' : '<span class="saude-alerta">✖</span>'} ${tamanho(b.bytes)} · ${(b.contatos ?? 0).toLocaleString("pt-BR")} contatos</span></li>`).join("")}</ul></details>` : ""}`;
}

document.getElementById("btn-backup").addEventListener("click", async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.textContent = "Fazendo backup…";
  try {
    const r = await fetch("/api/saude/backup", { method: "POST" });
    const corpo = await r.json().catch(() => ({}));
    if (corpo.resumo) renderizarBackup(corpo.resumo);
    if (!r.ok) throw new Error(corpo.erro || corpo.error || `erro ${r.status}`);
  } catch (e) {
    const aviso = document.getElementById("aviso");
    aviso.textContent = "⚠ Backup falhou: " + e.message;
    aviso.classList.add("visivel");
  } finally {
    btn.disabled = false;
    btn.textContent = "Fazer backup agora";
  }
});

// Leads ativos sem ticket, por consultor (clique abre a lista)
async function carregarSemTicket() {
  const alvo = document.getElementById("lista-sem-ticket");
  const r = await chamarApi("/api/oportunidades/sem-ticket").catch(() => null);
  if (!r) { alvo.innerHTML = `<p class="texto-suave">Não foi possível carregar.</p>`; return; }
  document.getElementById("sem-ticket-arquivo").textContent = r.ultimaImportacao
    ? `“fora do último arquivo” = não veio na importação do Omie de ${dataHoraBr(r.ultimaImportacao.concluido_em)} — pode já ter sido corrigida no CRM.`
    : "";
  alvo.innerHTML = r.porPessoa.length ? r.porPessoa.map((g) => `
    <details class="sem-ticket-grupo">
      <summary><strong>${escapeHtml(g.nome)}</strong> — ${g.total} lead(s) · mais antigo há ${g.maisAntigoDias} dia(s)
        <span class="texto-suave">(até 7 d: ${g.faixas.ate7} · 8–30 d: ${g.faixas.de8a30} · mais de 30 d: ${g.faixas.mais30})</span></summary>
      <ul class="lista-simples">${g.itens.map((o) => `<li><span>${escapeHtml(o.numero)} — ${escapeHtml(o.conta || "?")}
        <span class="texto-suave">${escapeHtml(o.fase || "")}${o.noUltimoArquivo ? "" : " · fora do último arquivo"}</span></span>
        <span>${o.dias} dia(s) · criada ${dataHoraBr(o.criadaEm)}</span></li>`).join("")}</ul>
    </details>`).join("") : `<p><span class="saude-ok">✔ nenhum lead ativo sem ticket</span></p>`;
  if (location.hash === "#sem-ticket") document.getElementById("sem-ticket").scrollIntoView();
}

document.getElementById("btn-sair").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});

carregar();
